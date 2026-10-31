-- Initial schema for the pharmacy delivery MVP.
-- User roles are provisioned by a trusted administrator; signup metadata is not trusted.

create type public.app_role as enum ('pharmacy', 'driver', 'admin');
create type public.delivery_status as enum ('pending', 'ready', 'picked_up', 'delivered', 'cancelled');

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text unique,
  role public.app_role,
  display_name text,
  created_at timestamptz not null default now(),
  constraint profiles_email_lowercase check (email is null or email = lower(email))
);

comment on column public.profiles.role is
  'Assigned by a trusted administrator after signup; never copied from user-editable auth metadata.';

create table public.delivery_orders (
  id uuid primary key default gen_random_uuid(),
  pharmacy_id uuid not null references public.profiles (id) on delete restrict,
  driver_id uuid references public.profiles (id) on delete set null,
  status public.delivery_status not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint delivery_orders_distinct_participants check (driver_id is null or driver_id <> pharmacy_id)
);

create table public.medications (
  id uuid primary key default gen_random_uuid(),
  pharmacy_id uuid not null references public.profiles (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 200),
  dosage text not null check (length(trim(dosage)) between 1 and 100),
  stock_count integer not null default 0 check (stock_count >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, pharmacy_id)
);

create index medications_pharmacy_active_idx
  on public.medications (pharmacy_id, is_active, name);

-- Opaque references to the pharmacy's external prescription records. This MVP
-- links references to stock items; it does not store or verify prescription content.
create table public.prescription_mappings (
  id uuid primary key default gen_random_uuid(),
  pharmacy_id uuid not null,
  medication_id uuid not null,
  external_reference text not null check (length(trim(external_reference)) between 1 and 120),
  created_at timestamptz not null default now(),
  unique (pharmacy_id, external_reference),
  unique (id, pharmacy_id),
  foreign key (medication_id, pharmacy_id)
    references public.medications (id, pharmacy_id) on delete cascade
);

create index prescription_mappings_pharmacy_idx
  on public.prescription_mappings (pharmacy_id, created_at desc);

-- Keep medical details and drop-off addresses out of the public driver queue until assignment.
create table public.delivery_details (
  delivery_order_id uuid primary key references public.delivery_orders (id) on delete cascade,
  pharmacy_id uuid not null references public.profiles (id) on delete restrict,
  medication_name text not null check (length(trim(medication_name)) between 1 and 200),
  dosage text not null check (length(trim(dosage)) between 1 and 100),
  delivery_address text not null check (length(trim(delivery_address)) between 5 and 500),
  created_at timestamptz not null default now()
);

create table public.delivery_prescriptions (
  delivery_order_id uuid primary key references public.delivery_orders (id) on delete cascade,
  pharmacy_id uuid not null,
  prescription_mapping_id uuid not null,
  created_at timestamptz not null default now(),
  foreign key (prescription_mapping_id, pharmacy_id)
    references public.prescription_mappings (id, pharmacy_id) on delete restrict
);

create index delivery_orders_pharmacy_status_idx
  on public.delivery_orders (pharmacy_id, status, created_at desc);
create index delivery_orders_driver_status_idx
  on public.delivery_orders (driver_id, status, updated_at desc)
  where driver_id is not null;
create index delivery_orders_available_idx
  on public.delivery_orders (created_at)
  where status = 'ready' and driver_id is null;

create table public.driver_progress (
  id uuid primary key default gen_random_uuid(),
  delivery_order_id uuid not null references public.delivery_orders (id) on delete cascade,
  driver_id uuid not null references public.profiles (id) on delete restrict,
  current_lat numeric(9, 6) not null,
  current_lng numeric(9, 6) not null,
  status public.delivery_status not null,
  updated_at timestamptz not null default now(),
  constraint driver_progress_latitude_range check (current_lat between -90 and 90),
  constraint driver_progress_longitude_range check (current_lng between -180 and 180)
);

create index driver_progress_order_updated_idx
  on public.driver_progress (delivery_order_id, updated_at desc);
create index driver_progress_driver_updated_idx
  on public.driver_progress (driver_id, updated_at desc);

-- The outbox is written in the same transaction as a delivery status change.
-- A later worker will publish these rows to Kafka and mark them as published.
create table public.event_outbox (
  id bigint generated always as identity primary key,
  event_type text not null check (event_type in ('medication.ready', 'driver.pickup', 'delivery.completed')),
  delivery_order_id uuid not null references public.delivery_orders (id) on delete restrict,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  last_error text
);

create index event_outbox_unpublished_idx
  on public.event_outbox (id)
  where published_at is null;

alter table public.event_outbox
  add column locked_at timestamptz,
  add column locked_by text;

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  event_outbox_id bigint not null references public.event_outbox (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  title text not null,
  body text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  unique (event_outbox_id, user_id)
);

create index notifications_user_created_idx
  on public.notifications (user_id, created_at desc);

-- Create a profile for each new Auth user. Role remains null until a trusted
-- provisioning flow assigns pharmacy, driver, or admin.
create function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    lower(new.email),
    nullif(trim(coalesce(new.raw_user_meta_data ->> 'display_name', '')), '')
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

create function public.set_delivery_order_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger delivery_orders_set_updated_at
  before update on public.delivery_orders
  for each row execute function public.set_delivery_order_updated_at();

create trigger medications_set_updated_at
  before update on public.medications
  for each row execute function public.set_delivery_order_updated_at();

create function public.record_delivery_milestone()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  milestone text;
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  milestone := case new.status
    when 'ready' then 'medication.ready'
    when 'picked_up' then 'driver.pickup'
    when 'delivered' then 'delivery.completed'
    else null
  end;

  if milestone is not null then
    insert into public.event_outbox (event_type, delivery_order_id, payload)
    values (
      milestone,
      new.id,
      jsonb_build_object(
        'delivery_order_id', new.id,
        'pharmacy_id', new.pharmacy_id,
        'driver_id', new.driver_id,
        'status', new.status,
        'occurred_at', now()
      )
    );
  end if;

  return new;
end;
$$;

create trigger delivery_orders_record_milestone
  after update of status on public.delivery_orders
  for each row execute function public.record_delivery_milestone();

create function public.current_app_role()
returns public.app_role
language sql
stable
security definer
set search_path = ''
as $$
  select p.role from public.profiles as p where p.id = (select auth.uid())
$$;

revoke all on function public.current_app_role() from public, anon;
grant execute on function public.current_app_role() to authenticated;

-- Atomically claim a ready, unassigned order. The row lock ensures two drivers
-- cannot both successfully accept the same order.
create function public.accept_delivery_order(p_delivery_order_id uuid)
returns public.delivery_orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed_order public.delivery_orders;
begin
  if (select auth.uid()) is null
     or (select public.current_app_role()) is distinct from 'driver'::public.app_role then
    raise exception 'Only authenticated drivers can accept delivery orders'
      using errcode = '42501';
  end if;

  update public.delivery_orders as d
  set driver_id = (select auth.uid())
  where d.id = p_delivery_order_id
    and d.status = 'ready'
    and d.driver_id is null
  returning d.* into claimed_order;

  if not found then
    raise exception 'Delivery order is unavailable'
      using errcode = 'P0002';
  end if;

  return claimed_order;
end;
$$;

revoke all on function public.accept_delivery_order(uuid) from public, anon;
grant execute on function public.accept_delivery_order(uuid) to authenticated;

create function public.create_delivery_order(
  p_prescription_mapping_id uuid,
  p_delivery_address text
)
returns public.delivery_orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  created_order public.delivery_orders;
  mapping_row public.prescription_mappings;
  medication_row public.medications;
begin
  if (select auth.uid()) is null
     or (select public.current_app_role()) is distinct from 'pharmacy'::public.app_role then
    raise exception 'Only authenticated pharmacies can create delivery orders'
      using errcode = '42501';
  end if;

  select pm.*
  into mapping_row
  from public.prescription_mappings as pm
  where pm.id = p_prescription_mapping_id
    and pm.pharmacy_id = (select auth.uid());

  if not found then
    raise exception 'Prescription mapping is unavailable'
      using errcode = 'P0002';
  end if;

  select med.*
  into medication_row
  from public.medications as med
  where med.id = mapping_row.medication_id
    and med.pharmacy_id = mapping_row.pharmacy_id
    and med.is_active
  for update;

  if not found then
    raise exception 'Prescription mapping is unavailable'
      using errcode = 'P0002';
  end if;

  if medication_row.stock_count < 1 then
    raise exception 'Medication is out of stock'
      using errcode = 'P0001';
  end if;

  update public.medications
  set stock_count = stock_count - 1
  where id = medication_row.id;

  insert into public.delivery_orders (pharmacy_id)
  values ((select auth.uid()))
  returning * into created_order;

  insert into public.delivery_details (delivery_order_id, pharmacy_id, medication_name, dosage, delivery_address)
  values (
    created_order.id,
    created_order.pharmacy_id,
    medication_row.name,
    medication_row.dosage,
    trim(p_delivery_address)
  );

  insert into public.delivery_prescriptions (delivery_order_id, pharmacy_id, prescription_mapping_id)
  values (created_order.id, created_order.pharmacy_id, mapping_row.id);

  return created_order;
end;
$$;

revoke all on function public.create_delivery_order(uuid, text) from public, anon;
grant execute on function public.create_delivery_order(uuid, text) to authenticated;

-- Claim a small batch with row locks so multiple outbox workers can run safely.
create function public.claim_outbox_events(p_worker_id text, p_limit integer default 25)
returns setof public.event_outbox
language sql
security definer
set search_path = ''
as $$
  with candidates as (
    select e.id
    from public.event_outbox as e
    where e.published_at is null
      and (e.locked_at is null or e.locked_at < now() - interval '2 minutes')
    order by e.id
    for update skip locked
    limit greatest(1, least(p_limit, 100))
  )
  update public.event_outbox as e
  set locked_at = now(), locked_by = p_worker_id, attempts = e.attempts + 1
  from candidates as c
  where e.id = c.id
  returning e.*
$$;

revoke all on function public.claim_outbox_events(text, integer) from public, anon, authenticated;
grant execute on function public.claim_outbox_events(text, integer) to service_role;

alter table public.profiles enable row level security;
alter table public.delivery_orders enable row level security;
alter table public.medications enable row level security;
alter table public.prescription_mappings enable row level security;
alter table public.delivery_details enable row level security;
alter table public.delivery_prescriptions enable row level security;
alter table public.driver_progress enable row level security;
alter table public.event_outbox enable row level security;
alter table public.notifications enable row level security;

revoke all on public.profiles, public.delivery_orders, public.medications, public.prescription_mappings, public.delivery_details, public.delivery_prescriptions, public.driver_progress, public.event_outbox, public.notifications
  from anon, authenticated;

grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;
grant select on public.delivery_orders to authenticated;
grant update (status) on public.delivery_orders to authenticated;
grant select, insert, update on public.medications to authenticated;
grant select, insert on public.prescription_mappings to authenticated;
grant select on public.delivery_details to authenticated;
grant select on public.delivery_prescriptions to authenticated;
grant select, insert on public.driver_progress to authenticated;
grant select, update (read_at) on public.notifications to authenticated;

-- Profiles: self access, plus pharmacy visibility of drivers assigned to its orders.
create policy profiles_select_self_or_assigned_driver
  on public.profiles for select to authenticated
  using (
    id = (select auth.uid())
    or (
      (select public.current_app_role()) = 'pharmacy'
      and role = 'driver'
      and exists (
        select 1 from public.delivery_orders as d
        where d.pharmacy_id = (select auth.uid()) and d.driver_id = profiles.id
      )
    )
  );

create policy profiles_update_own_display_name
  on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- Pharmacies see and create their orders. Drivers see unassigned ready work and
-- their own assignments. Admins can read all orders; writes remain scoped below.
create policy delivery_orders_select_by_role
  on public.delivery_orders for select to authenticated
  using (
    (select public.current_app_role()) = 'admin'
    or ((select public.current_app_role()) = 'pharmacy' and pharmacy_id = (select auth.uid()))
    or (
      (select public.current_app_role()) = 'driver'
      and (driver_id = (select auth.uid()) or (driver_id is null and status = 'ready'))
    )
  );

create policy medications_select_by_owner_or_admin
  on public.medications for select to authenticated
  using (
    pharmacy_id = (select auth.uid())
    or (select public.current_app_role()) = 'admin'
  );

create policy medications_insert_own
  on public.medications for insert to authenticated
  with check (
    (select public.current_app_role()) = 'pharmacy'
    and pharmacy_id = (select auth.uid())
  );

create policy medications_update_own
  on public.medications for update to authenticated
  using (
    (select public.current_app_role()) = 'pharmacy'
    and pharmacy_id = (select auth.uid())
  )
  with check (
    (select public.current_app_role()) = 'pharmacy'
    and pharmacy_id = (select auth.uid())
  );

create policy prescription_mappings_select_own
  on public.prescription_mappings for select to authenticated
  using (
    pharmacy_id = (select auth.uid())
    or (select public.current_app_role()) = 'admin'
  );

create policy prescription_mappings_insert_own
  on public.prescription_mappings for insert to authenticated
  with check (
    (select public.current_app_role()) = 'pharmacy'
    and pharmacy_id = (select auth.uid())
  );

-- Pharmacies can only mark their own pending orders ready; they cannot assign a driver.
create policy delivery_orders_pharmacy_mark_ready
  on public.delivery_orders for update to authenticated
  using (
    (select public.current_app_role()) = 'pharmacy'
    and pharmacy_id = (select auth.uid())
    and status = 'pending'
  )
  with check (
    (select public.current_app_role()) = 'pharmacy'
    and pharmacy_id = (select auth.uid())
    and status = 'ready'
    and driver_id is null
  );

-- Driver assignment and order transitions are mediated by the trusted API in
-- the next phase. These policies only allow an assigned driver to advance work.
create policy delivery_orders_driver_pickup
  on public.delivery_orders for update to authenticated
  using (
    (select public.current_app_role()) = 'driver'
    and driver_id = (select auth.uid())
    and status = 'ready'
  )
  with check (
    (select public.current_app_role()) = 'driver'
    and driver_id = (select auth.uid())
    and status = 'picked_up'
  );

create policy delivery_orders_driver_complete
  on public.delivery_orders for update to authenticated
  using (
    (select public.current_app_role()) = 'driver'
    and driver_id = (select auth.uid())
    and status = 'picked_up'
  )
  with check (
    (select public.current_app_role()) = 'driver'
    and driver_id = (select auth.uid())
    and status = 'delivered'
  );

create policy driver_progress_select_by_role
  on public.driver_progress for select to authenticated
  using (
    (select public.current_app_role()) = 'admin'
    or driver_id = (select auth.uid())
    or exists (
      select 1 from public.delivery_orders as d
      where d.id = driver_progress.delivery_order_id
        and d.pharmacy_id = (select auth.uid())
    )
  );

create policy delivery_details_select_by_role
  on public.delivery_details for select to authenticated
  using (
    (select public.current_app_role()) = 'admin'
    or ((select public.current_app_role()) = 'pharmacy' and pharmacy_id = (select auth.uid()))
    or (
      (select public.current_app_role()) = 'driver'
      and exists (
        select 1 from public.delivery_orders as d
        where d.id = delivery_details.delivery_order_id
          and d.driver_id = (select auth.uid())
      )
    )
  );

create policy delivery_prescriptions_select_own
  on public.delivery_prescriptions for select to authenticated
  using (
    pharmacy_id = (select auth.uid())
    or (select public.current_app_role()) = 'admin'
  );

create policy driver_progress_insert_own_assignment
  on public.driver_progress for insert to authenticated
  with check (
    (select public.current_app_role()) = 'driver'
    and driver_id = (select auth.uid())
    and exists (
      select 1 from public.delivery_orders as d
      where d.id = driver_progress.delivery_order_id
        and d.driver_id = (select auth.uid())
        and d.status in ('picked_up', 'delivered')
    )
  );

create policy notifications_select_own
  on public.notifications for select to authenticated
  using (user_id = (select auth.uid()));

create policy notifications_mark_own_read
  on public.notifications for update to authenticated
  using (user_id = (select auth.uid()) and read_at is null)
  with check (user_id = (select auth.uid()));

-- The event worker uses the server-only service role. No client-facing policies
-- are created for this table.
