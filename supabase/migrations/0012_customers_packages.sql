-- NETPID Phase 2: packages + customers (tables; policies in 0015)
create table if not exists public.packages (
  id uuid primary key default extensions.uuid_generate_v4(),
  isp_id uuid not null references public.isps(id) on delete cascade,
  name text not null,
  service_type text not null check (service_type in ('pppoe','hotspot','voucher','static')),
  price integer not null check (price >= 0), -- minor units (KES cents)
  currency text not null default 'KES',
  duration_value integer not null default 30,
  duration_unit text not null default 'days' check (duration_unit in ('hours','days','weeks','months')),
  download_kbps integer, upload_kbps integer,
  data_cap_mb integer, session_timeout integer, idle_timeout integer,
  simultaneous_users integer not null default 1,
  ip_pool text, radius_group text,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
drop trigger if exists trg_packages_touch on public.packages;
create trigger trg_packages_touch before update on public.packages
  for each row execute function public.touch_updated_at();
create index if not exists idx_packages_isp on public.packages(isp_id, enabled);

create table if not exists public.package_features (
  id uuid primary key default extensions.uuid_generate_v4(),
  package_id uuid not null references public.packages(id) on delete cascade,
  key text not null, value text not null,
  created_at timestamptz not null default now(),
  unique (package_id, key)
);

create table if not exists public.customers (
  id uuid primary key default extensions.uuid_generate_v4(),
  isp_id uuid not null references public.isps(id) on delete cascade,
  customer_no text not null,
  user_id uuid references auth.users(id) on delete set null, -- portal login link
  full_name text not null, phone text not null, email text,
  address text, status text not null default 'pending'
    check (status in ('pending','active','suspended','expired','blocked','terminated')),
  package_id uuid references public.packages(id) on delete set null,
  service_type text not null default 'pppoe'
    check (service_type in ('pppoe','hotspot','voucher','static')),
  username text, -- PPPoE/HotSpot login id (RADIUS user link in Phase 3)
  installation_date date, expiry_date timestamptz,
  balance integer not null default 0,
  notes text, reseller_id uuid, -- FK added in Phase 6
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (isp_id, customer_no)
);
drop trigger if exists trg_customers_touch on public.customers;
create trigger trg_customers_touch before update on public.customers
  for each row execute function public.touch_updated_at();
create index if not exists idx_customers_isp_status on public.customers(isp_id, status);
create index if not exists idx_customers_phone on public.customers(isp_id, phone);

create table if not exists public.customer_devices (
  id uuid primary key default extensions.uuid_generate_v4(),
  isp_id uuid not null references public.isps(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  mac text, device_type text, created_at timestamptz not null default now()
);
create table if not exists public.customer_addresses (
  id uuid primary key default extensions.uuid_generate_v4(),
  isp_id uuid not null references public.isps(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  label text, address text not null, gps text,
  created_at timestamptz not null default now()
);
