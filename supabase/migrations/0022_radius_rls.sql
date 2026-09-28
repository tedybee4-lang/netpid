-- NETPID Phase 3 RLS: servers (global + per-ISP), nas, groups, logs.
-- Secret tables (radius_nas_secrets, radius_user_credentials) intentionally have
-- NO policies: RLS deny-by-default, service-role only. rate_limits: service only.
alter table public.radius_servers enable row level security;
drop policy if exists rserv_platform on public.radius_servers;
create policy rserv_platform on public.radius_servers for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
drop policy if exists rserv_member on public.radius_servers;
create policy rserv_member on public.radius_servers for select
  using (isp_id is null or public.is_isp_member(isp_id));

alter table public.radius_nas enable row level security;
drop policy if exists rnas_platform on public.radius_nas;
create policy rnas_platform on public.radius_nas for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
drop policy if exists rnas_member_read on public.radius_nas;
create policy rnas_member_read on public.radius_nas for select
  using (public.is_isp_member(isp_id));
drop policy if exists rnas_tech_write on public.radius_nas;
create policy rnas_tech_write on public.radius_nas for all
  using (public.has_isp_role(isp_id,'technician'))
  with check (public.has_isp_role(isp_id,'technician'));
alter table public.radius_nas_secrets enable row level security;

alter table public.radius_users enable row level security;
drop policy if exists rusr_platform on public.radius_users;
create policy rusr_platform on public.radius_users for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
drop policy if exists rusr_member_read on public.radius_users;
create policy rusr_member_read on public.radius_users for select
  using (public.is_isp_member(isp_id));
drop policy if exists rusr_write on public.radius_users;
create policy rusr_write on public.radius_users for all
  using (public.has_isp_role(isp_id,'technician') or public.has_isp_role(isp_id,'cashier'))
  with check (public.has_isp_role(isp_id,'technician') or public.has_isp_role(isp_id,'cashier'));
alter table public.radius_user_credentials enable row level security;

alter table public.radius_groups enable row level security;
drop policy if exists rgrp_platform on public.radius_groups;
create policy rgrp_platform on public.radius_groups for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
drop policy if exists rgrp_member on public.radius_groups;
create policy rgrp_member on public.radius_groups for select
  using (public.is_isp_member(isp_id));
alter table public.radius_group_attributes enable row level security;
drop policy if exists rattr_member on public.radius_group_attributes;
create policy rattr_member on public.radius_group_attributes for select
  using (exists (select 1 from public.radius_groups g
    where g.id = group_id and public.is_isp_member(g.isp_id)));

alter table public.radius_logs enable row level security;
drop policy if exists rlog_platform on public.radius_logs;
create policy rlog_platform on public.radius_logs for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
drop policy if exists rlog_member on public.radius_logs;
create policy rlog_member on public.radius_logs for select
  using (public.is_isp_member(isp_id));
alter table public.radius_health_checks enable row level security;
drop policy if exists rhc_platform on public.radius_health_checks;
create policy rhc_platform on public.radius_health_checks for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
drop policy if exists rhc_member on public.radius_health_checks;
create policy rhc_member on public.radius_health_checks for select
  using (exists (select 1 from public.radius_servers s
    where s.id = server_id and (s.isp_id is null or public.is_isp_member(s.isp_id))));
alter table public.rate_limits enable row level security;
