-- NETPID Phase 3: RADIUS mapping tables (app DB; RADIUS DB lives on VPS per §48)
-- Secrets NEVER in these tables readable by users — see *_secrets tables (no RLS read).

create table if not exists public.radius_servers (
  id uuid primary key default uuid_generate_v4(),
  isp_id uuid references public.isps(id) on delete cascade, -- null = shared/global
  name text not null,
  host text not null, -- IP or hostname of FreeRADIUS VPS
  auth_port integer not null default 1812,
  acct_port integer not null default 1813,
  protocol text not null default 'udp' check (protocol in ('udp','radsec')),
  status text not null default 'unknown'
    check (status in ('online','degraded','offline','unknown')),
  last_check_at timestamptz,
  last_postauth_id bigint not null default 0, -- cursor for log sync
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
drop trigger if exists trg_radius_servers_touch on public.radius_servers;
create trigger trg_radius_servers_touch before update on public.radius_servers
  for each row execute function public.touch_updated_at();

create table if not exists public.radius_nas (
  id uuid primary key default uuid_generate_v4(),
  isp_id uuid not null references public.isps(id) on delete cascade,
  router_id text, -- FK to routers table lands in Phase 4
  shortname text not null,
  nasname inet not null, -- router public IP
  auth_port integer not null default 1812,
  acct_port integer not null default 1813,
  protocol text not null default 'udp' check (protocol in ('udp','radsec')),
  enabled boolean not null default true,
  sync_status text not null default 'pending'
    check (sync_status in ('pending','synced','error')),
  sync_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (isp_id, nasname)
);
drop trigger if exists trg_radius_nas_touch on public.radius_nas;
create trigger trg_radius_nas_touch before update on public.radius_nas
  for each row execute function public.touch_updated_at();

-- NAS shared secrets: service-role ONLY (no policies → RLS deny by default)
create table if not exists public.radius_nas_secrets (
  nas_id uuid primary key references public.radius_nas(id) on delete cascade,
  encrypted_secret text not null,
  key_version integer not null default 1,
  created_at timestamptz not null default now()
);

create table if not exists public.radius_users (
  id uuid primary key default uuid_generate_v4(),
  isp_id uuid not null references public.isps(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  username text not null,
  service_type text not null default 'pppoe'
    check (service_type in ('pppoe','hotspot','voucher','static')),
  radius_group text,
  enabled boolean not null default false,
  password_set boolean not null default false,
  sync_status text not null default 'pending'
    check (sync_status in ('pending','synced','error','disabled')),
  sync_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (isp_id, username)
);
drop trigger if exists trg_radius_users_touch on public.radius_users;
create trigger trg_radius_users_touch before update on public.radius_users
  for each row execute function public.touch_updated_at();
create index if not exists idx_radius_users_customer on public.radius_users(customer_id);

-- Login credentials: service-role ONLY
create table if not exists public.radius_user_credentials (
  radius_user_id uuid primary key references public.radius_users(id) on delete cascade,
  encrypted_password text not null,
  key_version integer not null default 1,
  updated_at timestamptz not null default now()
);
