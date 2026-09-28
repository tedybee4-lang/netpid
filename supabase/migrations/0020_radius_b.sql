-- NETPID Phase 3: groups, sync state, logs, health, rate limits (tables)
create table if not exists public.radius_groups (
  id uuid primary key default extensions.uuid_generate_v4(),
  isp_id uuid not null references public.isps(id) on delete cascade,
  package_id uuid not null unique references public.packages(id) on delete cascade,
  group_name text not null, -- e.g. lipanet_pppoe_15m (unique per ISP)
  service_type text not null,
  created_at timestamptz not null default now(),
  unique (isp_id, group_name)
);

create table if not exists public.radius_group_attributes (
  id uuid primary key default extensions.uuid_generate_v4(),
  group_id uuid not null references public.radius_groups(id) on delete cascade,
  attribute text not null, -- Mikrotik-Rate-Limit, Session-Timeout, ...
  op text not null default '=',
  value text not null,
  created_at timestamptz not null default now(),
  unique (group_id, attribute)
);

create table if not exists public.radius_logs (
  id uuid primary key default extensions.uuid_generate_v4(),
  isp_id uuid not null references public.isps(id) on delete cascade,
  username text not null,
  event text not null, -- accept | reject | test-accept | test-reject | test-timeout | test-error
  nas_ip text,
  reply text,
  created_at timestamptz not null default now()
);
create index if not exists idx_radius_logs_isp on public.radius_logs(isp_id, created_at desc);

create table if not exists public.radius_health_checks (
  id uuid primary key default extensions.uuid_generate_v4(),
  server_id uuid not null references public.radius_servers(id) on delete cascade,
  status text not null check (status in ('online','degraded','offline')),
  latency_ms integer,
  detail jsonb not null default '{}'::jsonb,
  checked_at timestamptz not null default now()
);
create index if not exists idx_radius_health_srv on public.radius_health_checks(server_id, checked_at desc);

-- DB-backed rate limits (serverless-safe)
create table if not exists public.rate_limits (
  key text primary key,
  window_start timestamptz not null default now(),
  count integer not null default 1
);
