-- NETPID Phase 1: all RLS policies (helpers now exist)
alter table public.platform_admins enable row level security;
drop policy if exists pa_self_read on public.platform_admins;
create policy pa_self_read on public.platform_admins for select
  using (user_id = auth.uid() or public.is_platform_admin());
drop policy if exists pa_admin_write on public.platform_admins;
create policy pa_admin_write on public.platform_admins for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
alter table public.feature_flags enable row level security;
drop policy if exists ff_read on public.feature_flags;
create policy ff_read on public.feature_flags for select using (true);
drop policy if exists ff_write on public.feature_flags;
create policy ff_write on public.feature_flags for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
alter table public.isp_feature_flags enable row level security;
drop policy if exists iff_platform on public.isp_feature_flags;
create policy iff_platform on public.isp_feature_flags for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
drop policy if exists iff_member on public.isp_feature_flags;
create policy iff_member on public.isp_feature_flags for select
  using (public.is_isp_member(isp_id));
