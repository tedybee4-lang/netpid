-- Live progress from the router while the configure script runs.
--
-- WHY THIS EXISTS
-- The operator pastes a ~200 line script into a serial console and is then
-- blind: the wizard could only show "70% - script generated", which stayed at 70%
-- whether the script had been pasted at all, was three lines in, or had just
-- finished. progress_pct cannot fix that, because the dashboard is the only
-- thing that could tell the difference and it had no way of knowing.
--
-- The script now GETs this endpoint at every step boundary, so step_log is the
-- router's own account of how far it got. current_step and progress_pct remain
-- the single-value summary the rest of the app already reads; step_log is the
-- ordered history behind them.
--
-- PROOF OF CONFIGURATION, NOT PROOF OF SUCCESS
-- A step appearing in step_log means the router REACHED that boundary. It does
-- not mean the objects were created - the script's own report reads the router
-- back for that, and NETPID still requires an API health check before ONLINE.
-- `pct` is clamped by the route, never trusted from the query string.
--
-- Idempotent: `add column if not exists`, so a database that already has it
-- from a partially applied run is fine.

alter table public.router_provisioning_sessions
  add column if not exists step_log jsonb not null default '[]'::jsonb;

comment on column public.router_provisioning_sessions.step_log is
  'Ordered [{step,pct,at}] progress events reported BY THE ROUTER while the configure script ran. Reaching a step is not proof the objects were created - the script''s own report reads the router back, and ONLINE still requires an API health check.';

-- Prove the column is visible and defaults correctly, rather than assuming the
-- statement above did what it said.
do $$
begin
  if (select count(*) from public.router_provisioning_sessions
      where step_log is null) > 0 then
    raise exception '0049: step_log is nullable or missing on existing rows';
  end if;
exception when undefined_column or undefined_table then
  raise exception '0049: step_log was not created on router_provisioning_sessions';
end $$;