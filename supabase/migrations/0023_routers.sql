-- NETPID Phase 4: routers (app DB). Credentials locked (service-role only).
create table if not exists public.routers (
  id uuid primary key default uuid_generate_v4(),
  isp_id uuid not null references public.isps(id) on delete cascade,
  name text not null,
  identity text,
  host inet not null, -- management IP
  api_port integer not null default 8728,
  api_ssl_port integer not null default 8729,
  api_username text not null default 'netpid',
  use_ssl boolean not null default true,
  ros_version text, model text, serial text,
  status text not null default 'unknown'
    check (status in ('online','offline','degraded','unknown')),
  last_seen_at timestamptz,
  uptime_seconds bigint, cpu_load integer, mem_used_pct integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
drop trigger if exists trg_routers_touch on public.routers;
create trigger trg_routers_touch before update on public.routers
  for each row execute function public.touch_updated_at();
create index if not exists idx_routers_isp on public.routers(isp_id);

create table if not exists public.router_credentials (
  router_id uuid primary key references public.routers(id) on delete cascade,
  encrypted_password text not null,
  key_version integer not null default 1,
  updated_at timestamptz not null default now()
);

create table if not exists public.router_health (
  id uuid primary key default uuid_generate_v4(),
  router_id uuid not null references public.routers(id) on delete cascade,
  reachable boolean not null,
  latency_ms integer,
  ros_version text, model text, uptime_seconds bigint,
  cpu_load integer, mem_used_pct integer,
  detail jsonb not null default '{}'::jsonb,
  checked_at timestamptz not null default now()
);
create index if not exists idx_router_health_r on public.router_health(router_id, checked_at desc);

create table if not exists public.router_backups (
  id uuid primary key default uuid_generate_v4(),
  isp_id uuid not null references public.isps(id) on delete cascade,
  router_id uuid not null references public.routers(id) on delete cascade,
  storage_path text not null, -- private bucket path, never public URL
  size_bytes bigint, created_at timestamptz not null default now()
);

create table if not exists public.ip_pools (
  id uuid primary key default uuid_generate_v4(),
  isp_id uuid not null references public.isps(id) on delete cascade,
  name text not null, ranges text not null, -- e.g. 10.10.0.10-10.10.0.254
  created_at timestamptz not null default now(),
  unique (isp_id, name)
);

-- Link NAS → router with a real FK going forward (radius_nas.router_id text deprecated)
alter table public.radius_nas add column if not exists router_uuid uuid
  references public.routers(id) on delete set null;
