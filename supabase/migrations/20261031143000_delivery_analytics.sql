-- Aggregate delivery metrics in Postgres so results are complete beyond the
-- REST API row limit and remain subject to the caller's row-level policies.
create function public.get_delivery_analytics()
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  analytics jsonb;
begin
  if (select auth.uid()) is null
     or (select public.current_app_role()) not in ('pharmacy'::public.app_role, 'admin'::public.app_role) then
    raise exception 'Only authenticated pharmacies and admins can view delivery analytics'
      using errcode = '42501';
  end if;

  select jsonb_build_object(
    'total_deliveries', count(*),
    'pending', count(*) filter (where d.status = 'pending'),
    'ready', count(*) filter (where d.status = 'ready'),
    'picked_up', count(*) filter (where d.status = 'picked_up'),
    'delivered', count(*) filter (where d.status = 'delivered'),
    'items_delivered', count(*) filter (where d.status = 'delivered'),
    'cancelled', count(*) filter (where d.status = 'cancelled'),
    'top_drivers', coalesce((
      select jsonb_agg(
        jsonb_build_object('name', leaderboard.name, 'delivered_count', leaderboard.delivered_count)
        order by leaderboard.delivered_count desc, leaderboard.name asc
      )
      from (
        select coalesce(nullif(p.display_name, ''), p.email, 'Driver') as name,
               count(*) as delivered_count
        from public.delivery_orders as completed
        join public.profiles as p on p.id = completed.driver_id
        where completed.status = 'delivered'
          and completed.driver_id is not null
        group by completed.driver_id, p.display_name, p.email
        order by count(*) desc, name asc
        limit 5
      ) as leaderboard
    ), '[]'::jsonb)
  )
  into analytics
  from public.delivery_orders as d;

  return analytics;
end;
$$;

revoke all on function public.get_delivery_analytics() from public, anon;
grant execute on function public.get_delivery_analytics() to authenticated;
