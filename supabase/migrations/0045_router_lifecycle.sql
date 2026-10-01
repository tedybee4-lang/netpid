-- Router lifecycle: the honest answer to "is this router actually on NETPID?".
--
-- `status` alone could not express this. It only ever became 'online' after a
-- successful RouterOS API call, and stayed 'unknown' otherwise - so a router
-- that had never been touched and a router that was fully enrolled but briefly
-- unreachable looked identical. Worse, the dashboard showed UNKNOWN for both,
-- which reads as "something is wrong" rather than "this was never finished".
--
-- A router's real path to being usable has distinct stages, and conflating
-- them is how five routers sat in NETPID looking half-built:
--
--   created                     a row exists; nothing has been done
--   provisioning_required       the RouterOS script exists, nobody has run it
--   wireguard_enrollment_required
--                               no management path at all: the router has no
--                               WireGuard key, so NETPID cannot reach it
--   wireguard_connected         tunnel enrolled, API still not answering
--   routeros_unreachable        API health check ran and failed
--   online                      a REAL RouterOS API health check succeeded
--
-- 'online' is only ever written by a successful API health check. Nothing else
-- may set it.

alter table public.routers
  add column if not exists lifecycle text not null default 'created';

alter table public.routers
  drop constraint if exists routers_lifecycle_check;
alter table public.routers
  add constraint routers_lifecycle_check
  check (lifecycle in (
    'created',
    'provisioning_required',
    'wireguard_enrollment_required',
    'wireguard_connected',
    'routeros_unreachable',
    'online'
  ));

-- A router that has reached 'online' must have actually been seen. This makes
-- the promise enforceable in the database rather than a convention: you cannot
-- record an online router with no successful check behind it.
alter table public.routers
  drop constraint if exists routers_online_requires_last_seen;
alter table public.routers
  add constraint routers_online_requires_last_seen
  check (lifecycle <> 'online' or last_seen_at is not null);

-- Backfill honestly. Anything that already proved itself keeps the claim; the
-- rest is downgraded to what is actually known, which is "created".
update public.routers
   set lifecycle = case
     when status = 'online' and last_seen_at is not null then 'online'
     when last_seen_at is not null then 'routeros_unreachable'
     else 'created'
   end;
