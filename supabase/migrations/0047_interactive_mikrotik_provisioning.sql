-- Interactive MikroTik provisioning sessions.
--
-- Replaces the static "generate an .rsc and hope" flow with a stateful,
-- two-phase handshake:
--
--   phase 1  NETPID mints a single-use token; the operator pastes ONE command
--            into the router's terminal. The router fetches a discovery script,
--            reports its hardware back, and NETPID now knows what the box is.
--   phase 2  the operator picks mode/WAN/HotSpot/PPPoE ports in the dashboard
--            against the REAL interfaces, and NETPID emits a configure script
--            built from what the hardware actually reported.
--
-- Every object the configure script creates is tagged comment="NETPID:<router_id>"
-- so a later run can find and update exactly what NETPID owns, and a human can
-- see it. Nothing outside that namespace is touched.
--
-- token_hash, never token: the row stores a SHA-256 of the token, so a database
-- leak does not hand out live provisioning sessions. The plaintext token is
-- returned exactly once, to the operator's browser.

create table if not exists public.router_provisioning_sessions (
  id uuid primary key default extensions.uuid_generate_v4(),
  isp_id uuid not null references public.isps(id) on delete cascade,
  -- Nullable: a session can be started against a board NETPID has not yet
  -- decided to register. Once the handshake lands it is bound to a router.
  router_id uuid references public.routers(id) on delete cascade,

  token_hash text not null unique,

  status text not null default 'PENDING'
    check (status in (
      'PENDING',            -- token minted, nothing heard from the router yet
      'BOOTSTRAPPED',       -- router fetched the discovery script
      'CAPABILITIES_DETECTED', -- hardware reported, dashboard can configure
      'CONFIGURED',         -- configure script issued
      'APPLIED',            -- operator reported it ran
      'FAILED',
      'EXPIRED',
      'CANCELLED'
    )),

  -- What the router told us about itself.
  router_model text,
  board_name text,
  routeros_version text,
  architecture text,
  cpu text,
  ram_mb integer,
  capabilities jsonb not null default '{}'::jsonb,
  detected_interfaces jsonb not null default '[]'::jsonb,
  detected_bridges jsonb not null default '[]'::jsonb,

  -- What the operator chose in phase 2.
  selected_mode text check (selected_mode in ('HOTSPOT','PPPOE','HOTSPOT_PPPOE')),
  wan_interface text,
  hotspot_interfaces text[] not null default '{}',
  pppoe_interfaces text[] not null default '{}',

  current_step text,
  progress_pct integer not null default 0
    check (progress_pct between 0 and 100),
  error_message text,

  started_at timestamptz not null default now(),
  -- 0048 adds this. The touch trigger below was created before the column
  -- existed, so it failed on every UPDATE with
  --   record "new" has no field "updated_at"
  -- which meant NO session could ever leave PENDING. See 0048.
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz not null default (now() + interval '30 minutes')
);

create index if not exists idx_prov_sessions_isp on public.router_provisioning_sessions(isp_id);
create index if not exists idx_prov_sessions_router on public.router_provisioning_sessions(router_id);
-- The poller hits this constantly; only live sessions need to be found.
create index if not exists idx_prov_sessions_live
  on public.router_provisioning_sessions(status, expires_at);

drop trigger if exists trg_prov_sessions_touch on public.router_provisioning_sessions;
create trigger trg_prov_sessions_touch before update on public.router_provisioning_sessions
for each row execute function public.touch_updated_at();

-- RLS. The repo enables RLS and reaches rows through the service role behind
-- lib/isp.ts; these policies additionally bind every user-session path to the
-- caller's own ISP, so a leaked anon key still cannot read another ISP's
-- provisioning sessions (which include router hardware detail).
--
-- isp_user_roles has no isp_id of its own (0003): membership runs
-- isp_user_roles -> isp_roles -> isp. isp_users carries the isp_id for the user.
alter table public.router_provisioning_sessions enable row level security;

drop policy if exists prov_sessions_read_own_isp on public.router_provisioning_sessions;
create policy prov_sessions_read_own_isp on public.router_provisioning_sessions
  for select to authenticated
  using (
    isp_id in (
      select iu.isp_id
      from public.isp_users iu
      join public.isp_user_roles iur on iur.isp_user_id = iu.id
      where iu.user_id = auth.uid() and iu.is_active = true
    )
  );

drop policy if exists prov_sessions_write_own_isp on public.router_provisioning_sessions;
create policy prov_sessions_write_own_isp on public.router_provisioning_sessions
  for all to authenticated
  using (
    isp_id in (
      select iu.isp_id
      from public.isp_users iu
      join public.isp_user_roles iur on iur.isp_user_id = iu.id
      where iu.user_id = auth.uid() and iu.is_active = true
    )
  )
  with check (
    isp_id in (
      select iu.isp_id
      from public.isp_users iu
      join public.isp_user_roles iur on iur.isp_user_id = iu.id
      where iu.user_id = auth.uid() and iu.is_active = true
    )
  );

comment on table public.router_provisioning_sessions is
  'Two-phase MikroTik onboarding. Only a SHA-256 token hash is stored; the plaintext token is shown once and expires 30 minutes after issue.';
comment on column public.router_provisioning_sessions.progress_pct is
  'Operator-facing progress only. It is NOT evidence that anything was configured on the router - the router confirms via APPLIED.';