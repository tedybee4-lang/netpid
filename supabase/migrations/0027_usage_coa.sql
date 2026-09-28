-- NETPID Phase 5: usage rollups + CoA support columns
create table if not exists public.data_usage (
  isp_id uuid not null references public.isps(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  day date not null,
  upload_bytes bigint not null default 0,
  download_bytes bigint not null default 0,
  session_seconds integer not null default 0,
  sessions integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (isp_id, customer_id, day)
);
create index if not exists idx_usage_day on public.data_usage(isp_id, day desc);

create table if not exists public.package_sales_daily (
  isp_id uuid not null references public.isps(id) on delete cascade,
  package_id uuid references public.packages(id) on delete set null,
  day date not null,
  count integer not null default 0,
  revenue integer not null default 0, -- minor units
  primary key (isp_id, package_id, day)
);

-- CoA/Disconnect target info per NAS (MikroTik default 3799/udp)
alter table public.radius_nas add column if not exists coa_port integer not null default 3799;
alter table public.radius_nas add column if not exists coa_enabled boolean not null default true;

-- Expiry reminders bookkeeping (avoid duplicate SMS)
alter table public.customers add column if not exists expiry_reminded_at timestamptz;
