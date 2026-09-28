-- NETPID Phase 1: claims / atomic job dequeue (tables exist from 0006)
create or replace function public.claim_next_job()
returns setof public.network_jobs language plpgsql security definer
set search_path = public as $$
declare r public.network_jobs%rowtype;
begin
  select * into r from public.network_jobs
  where status in ('queued','retrying') and run_after <= now()
  order by created_at asc limit 1 for update skip locked;
  if not found then return; end if;
  update public.network_jobs set status='running', attempts=attempts+1,
    started_at = coalesce(started_at, now()) where id = r.id;
  return query select * from public.network_jobs where id = r.id;
end $$;
