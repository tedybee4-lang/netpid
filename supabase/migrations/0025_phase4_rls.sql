-- NETPID Phase 4 RLS: routers, services, vouchers, sessions, APs.
-- router_credentials: NO policies (service-role only, like other secret tables).
alter table public.routers enable row level security;
drop policy if exists rt_platform on public.routers;
create policy rt_platform on public.routers for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
drop policy if exists rt_member_read on public.routers;
create policy rt_member_read on public.routers for select using (public.is_isp_member(isp_id));
drop policy if exists rt_tech_write on public.routers;
create policy rt_tech_write on public.routers for all
  using (public.has_isp_role(isp_id,'technician'))
  with check (public.has_isp_role(isp_id,'technician'));
alter table public.router_credentials enable row level security;
alter table public.router_health enable row level security;
drop policy if exists rh_platform on public.router_health;
create policy rh_platform on public.router_health for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
drop policy if exists rh_member on public.router_health;
create policy rh_member on public.router_health for select
  using (exists (select 1 from public.routers r where r.id = router_id and public.is_isp_member(r.isp_id)));
alter table public.router_backups enable row level security;
drop policy if exists rb_platform on public.router_backups;
create policy rb_platform on public.router_backups for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
drop policy if exists rb_member on public.router_backups;
create policy rb_member on public.router_backups for select using (public.is_isp_member(isp_id));
alter table public.ip_pools enable row level security;
drop policy if exists ipp_member on public.ip_pools;
create policy ipp_member on public.ip_pools for all
  using (public.is_isp_member(isp_id)) with check (public.is_isp_member(isp_id));

alter table public.pppoe_accounts enable row level security;
drop policy if exists ppp_member on public.pppoe_accounts;
create policy ppp_member on public.pppoe_accounts for all
  using (public.is_isp_member(isp_id)) with check (public.is_isp_member(isp_id));
alter table public.hotspot_users enable row level security;
drop policy if exists hs_member on public.hotspot_users;
create policy hs_member on public.hotspot_users for all
  using (public.is_isp_member(isp_id)) with check (public.is_isp_member(isp_id));
alter table public.voucher_batches enable row level security;
drop policy if exists vb_member on public.voucher_batches;
create policy vb_member on public.voucher_batches for all
  using (public.is_isp_member(isp_id)) with check (public.is_isp_member(isp_id));
alter table public.vouchers enable row level security;
drop policy if exists v_member on public.vouchers;
create policy v_member on public.vouchers for select using (public.is_isp_member(isp_id));
drop policy if exists v_cashier_write on public.vouchers;
create policy v_cashier_write on public.vouchers for all
  using (public.has_isp_role(isp_id,'cashier')) with check (public.has_isp_role(isp_id,'cashier'));

alter table public.radius_sessions enable row level security;
drop policy if exists sess_platform on public.radius_sessions;
create policy sess_platform on public.radius_sessions for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
drop policy if exists sess_member on public.radius_sessions;
create policy sess_member on public.radius_sessions for select using (public.is_isp_member(isp_id));
alter table public.access_points enable row level security;
drop policy if exists ap_member on public.access_points;
create policy ap_member on public.access_points for all
  using (public.is_isp_member(isp_id)) with check (public.is_isp_member(isp_id));
