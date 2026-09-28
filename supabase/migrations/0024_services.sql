-- NETPID Phase 4: PPPoE/HotSpot accounts, vouchers, accounting mirror, APs
create table if not exists public.pppoe_accounts (
  id uuid primary key default uuid_generate_v4(),
  isp_id uuid not null references public.isps(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  radius_user_id uuid references public.radius_users(id) on delete set null,
  router_id uuid references public.routers(id) on delete set null,
  profile text, ip_pool text, static_ip inet,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (customer_id)
);
drop trigger if exists trg_pppoe_touch on public.pppoe_accounts;
create trigger trg_pppoe_touch before update on public.pppoe_accounts
  for each row execute function public.touch_updated_at();

create table if not exists public.hotspot_users (
  id uuid primary key default uuid_generate_v4(),
  isp_id uuid not null references public.isps(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  radius_user_id uuid references public.radius_users(id) on delete set null,
  voucher_id uuid, -- FK added below
  profile text,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.voucher_batches (
  id uuid primary key default uuid_generate_v4(),
  isp_id uuid not null references public.isps(id) on delete cascade,
  name text not null, package_id uuid not null references public.packages(id) on delete restrict,
  quantity integer not null check (quantity > 0 and quantity <= 5000),
  code_length integer not null default 8,
  expires_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create table if not exists public.vouchers (
  id uuid primary key default uuid_generate_v4(),
  isp_id uuid not null references public.isps(id) on delete cascade,
  batch_id uuid not null references public.voucher_batches(id) on delete cascade,
  code text not null,
  status text not null default 'unused'
    check (status in ('unused','active','expired','disabled')),
  activated_at timestamptz, expires_at timestamptz,
  usage_mb bigint not null default 0,
  created_at timestamptz not null default now(),
  unique (isp_id, code)
);
create index if not exists idx_vouchers_batch on public.vouchers(batch_id, status);
alter table public.hotspot_users add column if not exists voucher_fk uuid
  references public.vouchers(id) on delete set null;

-- Accounting mirror (read-only copy synced from RADIUS DB; source of "online")
create table if not exists public.radius_sessions (
  isp_id uuid not null references public.isps(id) on delete cascade,
  acct_session_id text not null,
  acct_unique_id text not null default '',
  username text not null,
  customer_id uuid references public.customers(id) on delete set null,
  nas_ip inet, framed_ip inet, calling_station text,
  start_time timestamptz, last_update timestamptz, stop_time timestamptz,
  session_seconds integer not null default 0,
  input_octets bigint not null default 0, output_octets bigint not null default 0,
  terminate_cause text, is_open boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (isp_id, acct_session_id, acct_unique_id)
);
create index if not exists idx_sessions_open on public.radius_sessions(isp_id, is_open, last_update desc);

create table if not exists public.access_points (
  id uuid primary key default uuid_generate_v4(),
  isp_id uuid not null references public.isps(id) on delete cascade,
  router_id uuid references public.routers(id) on delete set null,
  name text not null, ip inet, mac text, location text, ssid text,
  status text not null default 'unknown' check (status in ('online','offline','unknown')),
  clients integer not null default 0, uptime_seconds bigint,
  last_seen_at timestamptz, created_at timestamptz not null default now()
);
