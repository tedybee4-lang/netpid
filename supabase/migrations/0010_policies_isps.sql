alter table public.announcements enable row level security;
drop policy if exists ann_read on public.announcements;
create policy ann_read on public.announcements for select
  using (published = true or public.is_platform_admin());
drop policy if exists ann_write on public.announcements;
create policy ann_write on public.announcements for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
alter table public.system_settings enable row level security;
drop policy if exists sys_read on public.system_settings;
create policy sys_read on public.system_settings for select
  using (public.is_platform_admin());
drop policy if exists sys_write on public.system_settings;
create policy sys_write on public.system_settings for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
alter table public.system_health enable row level security;
drop policy if exists health_read on public.system_health;
create policy health_read on public.system_health for select
  using (public.is_platform_admin());
drop policy if exists health_write on public.system_health;
create policy health_write on public.system_health for insert
  with check (public.is_platform_admin());
alter table public.isps enable row level security;
drop policy if exists isps_platform on public.isps;
create policy isps_platform on public.isps for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
drop policy if exists isps_member_read on public.isps;
create policy isps_member_read on public.isps for select
  using (public.is_isp_member(id));
drop policy if exists isps_owner_update on public.isps;
create policy isps_owner_update on public.isps for update
  using (public.has_isp_role(id,'owner') or public.has_isp_role(id,'admin'))
  with check (public.has_isp_role(id,'owner') or public.has_isp_role(id,'admin'));
drop policy if exists isps_create on public.isps;
create policy isps_create on public.isps for insert
  with check (created_by = auth.uid() or public.is_platform_admin());
