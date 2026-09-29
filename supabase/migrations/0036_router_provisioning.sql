-- NETPID: per-ISP router provisioning defaults.
--
-- Lets an ISP onboard a router with nothing but a NAME. The dashboard then
-- derives everything else — management IP from the subnet, API credentials,
-- RADIUS host/ports and NAS shortname — instead of asking the operator to
-- retype the same values for every site.
--
-- mgmt_subnet is the management network the router's API lives on; the next
-- free host address in it becomes the router's `host`. next_host_offset is the
-- allocator cursor (10.0.0.1 is the usual first management address).
create table if not exists public.isp_router_defaults (
  isp_id uuid primary key references public.isps(id) on delete cascade,
  mgmt_subnet inet not null default '10.10.10.0/24',
  mgmt_gateway inet not null default '10.10.10.1',
  next_host_offset integer not null default 1,
  api_username text not null default 'netpid',
  api_port integer not null default 8728,
  api_ssl_port integer not null default 8729,
  use_ssl boolean not null default true,
  ros_version text not null default '7' check (ros_version in ('6','7')),
  radius_server inet,
  radius_auth_port integer not null default 1812,
  radius_acct_port integer not null default 1813,
  radius_coa_port integer not null default 3799,
  nas_prefix text not null default 'netpid',
  dns_servers text not null default '1.1.1.1,8.8.8.8',
  ntp_servers text not null default 'pool.ntp.org',
  wifi_ssid text,
  country_code text not null default 'Kenya',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
drop trigger if exists trg_isp_router_defaults_touch on public.isp_router_defaults;
create trigger trg_isp_router_defaults_touch before update on public.isp_router_defaults
  for each row execute function public.touch_updated_at();

-- RLS: members read, owner/admin write. Mirrors isp_settings.
alter table public.isp_router_defaults enable row level security;
drop policy if exists ird_platform on public.isp_router_defaults;
create policy ird_platform on public.isp_router_defaults for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
drop policy if exists ird_member_read on public.isp_router_defaults;
create policy ird_member_read on public.isp_router_defaults for select
  using (public.is_isp_member(isp_id));
drop policy if exists ird_admin_write on public.isp_router_defaults;
create policy ird_admin_write on public.isp_router_defaults for all
  using (public.has_isp_role(isp_id,'admin'))
  with check (public.has_isp_role(isp_id,'admin'));

-- Which RouterOS major a generated script targets, per router. Nullable on
-- purpose: an unprobed router reports NULL and we fall back to the ISP default.
alter table public.routers add column if not exists script_ros_version text
  check (script_ros_version in ('6','7'));

-- Track soft-deletes so the Recycle Bin can restore rather than lose records.
create table if not exists public.recycle_bin (
  id uuid primary key default extensions.uuid_generate_v4(),
  isp_id uuid not null references public.isps(id) on delete cascade,
  table_name text not null,
  row_id uuid not null,
  label text,
  payload jsonb not null default '{}'::jsonb,
  deleted_by uuid references auth.users(id) on delete set null,
  deleted_at timestamptz not null default now(),
  restored_at timestamptz
);
create index if not exists idx_recycle_bin_isp on public.recycle_bin(isp_id, deleted_at desc);
alter table public.recycle_bin enable row level security;
drop policy if exists rb_platform on public.recycle_bin;
create policy rb_platform on public.recycle_bin for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
drop policy if exists rb_admin on public.recycle_bin;
create policy rb_admin on public.recycle_bin for all
  using (public.has_isp_role(isp_id,'admin'))
  with check (public.has_isp_role(isp_id,'admin'));
