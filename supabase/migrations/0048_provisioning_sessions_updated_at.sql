-- Fix: the provisioning session trigger referenced a column that did not exist.
--
-- FOUND IN THE FIELD, NOT IN TESTS. A real router fetched the bootstrap script
-- and reported back, and the register call failed with:
--
--   HTTP 400 {"error":"record \"new\" has no field \"updated_at\""}
--
-- 0047 created trg_prov_sessions_touch calling public.touch_updated_at() but
-- the table has no updated_at column. Every UPDATE on the table therefore
-- raised, so a session could never move off PENDING: not BOOTSTRAPPED, not
-- CAPABILITIES_DETECTED, not CONFIGURED. The dashboard would sit on
-- "Connecting..." forever with no error anywhere, because the one request that
-- reported the problem was the one being rejected.
--
-- The unit suite did not catch it: those tests read generator source and never
-- touch the database. A trigger that names a missing column is only visible
-- when the statement actually runs.
--
-- This adds the column rather than dropping the trigger. updated_at is what the
-- rest of the schema already assumes for every other table, and provisioning
-- sessions genuinely need it to age out expired rows.
--
-- 0047 is left untouched: it has been applied and the column is additive, so a
-- fresh database gets the column from 0048 in the same sequence.

alter table public.router_provisioning_sessions
  add column if not exists updated_at timestamptz not null default now();

comment on column public.router_provisioning_sessions.updated_at is
  'Maintained by trg_prov_sessions_touch. Added in 0048; the trigger that references it was created in 0047.';

-- Prove the trigger now works. A DO block that silently did nothing would let
-- the same class of bug survive a second time.
do $$
begin
  perform updated_at from public.router_provisioning_sessions limit 1;
exception when others then
  raise exception '0048: updated_at still not visible to the trigger: %', sqlerrm;
end $$;
