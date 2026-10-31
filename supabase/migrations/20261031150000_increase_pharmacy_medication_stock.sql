create function public.increase_medication_stock(
  p_medication_id uuid,
  p_quantity integer
)
returns public.medications
language plpgsql
security definer
set search_path = ''
as $$
declare
  updated_medication public.medications;
begin
  if (select auth.uid()) is null
     or (select public.current_app_role()) is distinct from 'pharmacy'::public.app_role then
    raise exception 'Only authenticated pharmacies can update medication stock'
      using errcode = '42501';
  end if;

  if p_quantity is null or p_quantity < 1 or p_quantity > 1000000 then
    raise exception 'Stock increase must be between 1 and 1000000'
      using errcode = '22023';
  end if;

  update public.medications as medication
  set stock_count = medication.stock_count + p_quantity
  where medication.id = p_medication_id
    and medication.pharmacy_id = (select auth.uid())
    and medication.stock_count <= 1000000 - p_quantity
  returning medication.* into updated_medication;

  if not found then
    raise exception 'Medication is unavailable or the stock limit would be exceeded'
      using errcode = 'P0002';
  end if;

  return updated_medication;
end;
$$;

revoke all on function public.increase_medication_stock(uuid, integer) from public, anon;
grant execute on function public.increase_medication_stock(uuid, integer) to authenticated;
