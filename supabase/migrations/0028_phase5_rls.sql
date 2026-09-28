-- NETPID Phase 5 RLS: usage tables member-read, platform-all
alter table public.data_usage enable row level security;
drop policy if exists du_member on public.data_usage;
create policy du_member on public.data_usage for select using (public.is_isp_member(isp_id));
drop policy if exists du_platform on public.data_usage;
create policy du_platform on public.data_usage for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
alter table public.package_sales_daily enable row level security;
drop policy if exists psd_member on public.package_sales_daily;
create policy psd_member on public.package_sales_daily for select using (public.is_isp_member(isp_id));
drop policy if exists psd_platform on public.package_sales_daily;
create policy psd_platform on public.package_sales_daily for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
