-- NETPID Phase 7: Row Level Security for TR-069, Topology Nodes, and AI Diagnostics

-- TR-069 Devices
alter table public.tr069_devices enable row level security;
drop policy if exists tr_member on public.tr069_devices;
create policy tr_member on public.tr069_devices for select using (public.is_isp_member(isp_id));
drop policy if exists tr_admin on public.tr069_devices;
create policy tr_admin on public.tr069_devices for all
  using (public.is_isp_admin(isp_id)) with check (public.is_isp_admin(isp_id));
drop policy if exists tr_platform on public.tr069_devices;
create policy tr_platform on public.tr069_devices for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());

-- Network Nodes
alter table public.network_nodes enable row level security;
drop policy if exists nn_member on public.network_nodes;
create policy nn_member on public.network_nodes for select using (public.is_isp_member(isp_id));
drop policy if exists nn_admin on public.network_nodes;
create policy nn_admin on public.network_nodes for all
  using (public.is_isp_admin(isp_id)) with check (public.is_isp_admin(isp_id));
drop policy if exists nn_platform on public.network_nodes;
create policy nn_platform on public.network_nodes for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());

-- AI Diagnostic Logs
alter table public.ai_diagnostic_logs enable row level security;
drop policy if exists ai_member on public.ai_diagnostic_logs;
create policy ai_member on public.ai_diagnostic_logs for all
  using (public.is_isp_member(isp_id)) with check (public.is_isp_member(isp_id));
drop policy if exists ai_platform on public.ai_diagnostic_logs;
create policy ai_platform on public.ai_diagnostic_logs for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
