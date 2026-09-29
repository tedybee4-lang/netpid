-- NETPID: VPS / server management for the Super Admin console.
--
-- Scope: platform-level infrastructure, NOT ISP data. Every table here is
-- reachable only through is_platform_admin(), so an ISP admin cannot read
-- another tenant's SSH credentials or server inventory.
--
-- isp_id is nullable on vps_servers for a deliberate reason: a server can be
-- platform infrastructure shared by everyone, or dedicated to one ISP. When it
-- IS set, that server belongs to that tenant — and normal ISP membership
-- (is_isp_member) is still not sufficient. The platform console remains the
-- only way in, which keeps the isolation one-directional and obvious.

create table if not exists public.vps_servers (
  id uuid primary key default extensions.uuid_generate_v4(),
  isp_id uuid references public.isps(id) on delete cascade,
  name text not null,
  provider text not null default 'other',
  region text,
  hostname text,                        -- DNS name if the server has one
  ip_address inet not null,
  ipv6_address inet,
  ssh_port integer not null default 22 check (ssh_port between 1 and 65535),
  ssh_username text not null,

  -- How we authenticate. 'password' stores a symmetric secret encrypted with
  -- APP_ENCRYPTION_KEY; 'key' stores an asymmetric private key the same way.
  -- Nothing else is supported, so the UI cannot offer an unsafe option.
  auth_method text not null default 'password' check (auth_method in ('password','key')),
  credential_encrypted text,            -- AES-256-GCM, never leaves the server
  credential_status text not null default 'missing'
    check (credential_status in ('missing','active','expiring','expired')),
  credential_expires_at timestamptz,
  credential_updated_at timestamptz,
  credential_updated_by uuid references auth.users(id) on delete set null,

  enabled boolean not null default true,

  -- Live state, written by the heartbeat and by connection tests. The
  -- *_status columns are coarse on purpose: an operator scanning the list
  -- needs "is it up", not a full report.
  status text not null default 'unknown'
    check (status in ('online','delayed','offline','unknown','disabled')),
  worker_status text not null default 'unknown'
    check (worker_status in ('running','stopped','unknown')),
  radius_status text not null default 'unknown'
    check (radius_status in ('running','stopped','unknown')),
  wireguard_status text not null default 'unknown'
    check (wireguard_status in ('active','inactive','unknown')),
  firewall_status text not null default 'unknown'
    check (firewall_status in ('active','inactive','unknown')),

  os_name text,
  os_version text,
  kernel text,
  cpu_percent numeric(5,2),
  mem_percent numeric(5,2),
  mem_total_mb integer,
  disk_percent numeric(5,2),
  disk_total_gb integer,
  uptime_seconds bigint,
  load_avg_1 text,

  last_heartbeat_at timestamptz,
  last_health_check_at timestamptz,
  last_health_error text,

  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (name)
);
create index if not exists idx_vps_servers_status on public.vps_servers(status);
create index if not exists idx_vps_servers_isp on public.vps_servers(isp_id);
drop trigger if exists trg_vps_servers_touch on public.vps_servers;
create trigger trg_vps_servers_touch before update on public.vps_servers
  for each row execute function public.touch_updated_at();

-- ---------- worker_heartbeats ----------
-- Append-only. One row per worker per interval. Keeping history (rather than
-- overwriting a single row) is what makes "delayed since 14:32" answerable.
create table if not exists public.worker_heartbeats (
  id uuid primary key default extensions.uuid_generate_v4(),
  server_id uuid not null references public.vps_servers(id) on delete cascade,
  worker_id text not null,
  worker_version text,
  status text not null default 'ok' check (status in ('ok','degraded','error')),
  -- Safe metrics only. No credentials, keys or secrets are ever accepted here.
  cpu_percent numeric(5,2),
  mem_percent numeric(5,2),
  disk_percent numeric(5,2),
  uptime_seconds bigint,
  radius_running boolean,
  wireguard_active boolean,
  firewall_active boolean,
  jobs_processed integer,
  detail jsonb not null default '{}'::jsonb,
  reported_at timestamptz not null default now()
);
create index if not exists idx_worker_heartbeats_server
  on public.worker_heartbeats(server_id, reported_at desc);
-- ---------- vps_health_events ----------
-- Historical health transitions, so the console can show a sparkline and an
-- operator can answer "when did this start flapping?".
create table if not exists public.vps_health_events (
  id uuid primary key default extensions.uuid_generate_v4(),
  server_id uuid not null references public.vps_servers(id) on delete cascade,
  source text not null default 'heartbeat'
    check (source in ('heartbeat','ssh_test','manual')),
  status text not null check (status in ('online','delayed','offline','unknown','disabled')),
  detail jsonb not null default '{}'::jsonb,
  error text,
  recorded_at timestamptz not null default now()
);
create index if not exists idx_vps_health_events_server
  on public.vps_health_events(server_id, recorded_at desc);

-- ---------- platform_audit_log ----------
-- Security-relevant actions, with no secrets. The action names are fixed rather
-- than free text so the log cannot be used to smuggle data out.
create table if not exists public.platform_audit_log (
  id uuid primary key default extensions.uuid_generate_v4(),
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_label text,
  action text not null check (action in
    ('vps_created','vps_updated','vps_deleted','vps_credentials_changed',
     'vps_connection_tested','vps_enabled','vps_disabled',
     'worker_action','wireguard_action','radius_action','firewall_action',
     'admin_login','admin_logout')),
  target_type text,
  target_id text,
  target_label text,
  outcome text not null default 'ok' check (outcome in ('ok','failed','denied')),
  -- Free-form but must never contain secret material; callers pass a
  -- redacted summary only.
  detail jsonb not null default '{}'::jsonb,
  ip_address inet,
  created_at timestamptz not null default now()
);
create index if not exists idx_platform_audit_created
  on public.platform_audit_log(created_at desc);

-- ---------- RLS: platform admins only ----------
-- No is_isp_member policy on any of these tables, by design. An ISP admin's
-- session cannot read them, and every route under app/api/admin/* independently
-- calls isAdmin() on top of that.
do $$
declare t text;
begin
  foreach t in array array[
    'vps_servers','worker_heartbeats','vps_health_events','platform_audit_log'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_platform', t);
    execute format(
      'create policy %I on public.%I for all using (public.is_platform_admin()) '
      || 'with check (public.is_platform_admin())', t || '_platform', t);
  end loop;
end $$;

-- The worker posts heartbeats with the service role, which bypasses RLS. No
-- anon/authenticated policy is added on purpose: an unauthenticated client must
-- not be able to write a heartbeat and mark a dead server as online.

create index if not exists idx_platform_audit_action
  on public.platform_audit_log(action, created_at desc);

