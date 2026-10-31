-- Self-service signup may select only the non-admin roles. Admin roles are
-- assigned by an existing admin through assign_app_role().
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested_role public.app_role;
begin
  requested_role := case new.raw_user_meta_data ->> 'requested_role'
    when 'pharmacy' then 'pharmacy'::public.app_role
    when 'driver' then 'driver'::public.app_role
    else null
  end;

  insert into public.profiles (id, email, role, display_name)
  values (
    new.id,
    lower(new.email),
    requested_role,
    nullif(trim(coalesce(new.raw_user_meta_data ->> 'display_name', '')), '')
  );
  return new;
end;
$$;

comment on column public.profiles.role is
  'Users may select pharmacy or driver at signup; admin is granted only by an existing admin.';

create or replace function public.set_my_app_role(p_role public.app_role)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'Sign in before selecting an application role'
      using errcode = '42501';
  end if;
  if p_role is null or p_role not in ('pharmacy'::public.app_role, 'driver'::public.app_role) then
    raise exception 'Self-service signup supports pharmacy or driver roles only'
      using errcode = '42501';
  end if;

  update public.profiles
  set role = p_role
  where id = (select auth.uid()) and role is null;
  if not found then
    raise exception 'Role is already assigned or profile does not exist'
      using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.set_my_app_role(public.app_role) from public, anon;
grant execute on function public.set_my_app_role(public.app_role) to authenticated;

create function public.assign_app_role(p_user_id uuid, p_role public.app_role)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null
     or (select public.current_app_role()) is distinct from 'admin'::public.app_role then
    raise exception 'Only an admin can assign account roles'
      using errcode = '42501';
  end if;
  if p_user_id is null or p_role is null then
    raise exception 'A target account and role are required'
      using errcode = '22023';
  end if;
  if p_user_id = (select auth.uid()) then
    raise exception 'Admins cannot change their own role'
      using errcode = '42501';
  end if;

  update public.profiles
  set role = p_role
  where id = p_user_id;
  if not found then
    raise exception 'Profile not found'
      using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.assign_app_role(uuid, public.app_role) from public, anon;
grant execute on function public.assign_app_role(uuid, public.app_role) to authenticated;

drop policy profiles_select_self_or_assigned_driver on public.profiles;
create policy profiles_select_self_or_assigned_driver
  on public.profiles for select to authenticated
  using (
    id = (select auth.uid())
    or (select public.current_app_role()) = 'admin'
    or (
      (select public.current_app_role()) = 'pharmacy'
      and role = 'driver'
      and exists (
        select 1 from public.delivery_orders as d
        where d.pharmacy_id = (select auth.uid()) and d.driver_id = profiles.id
      )
    )
  );
