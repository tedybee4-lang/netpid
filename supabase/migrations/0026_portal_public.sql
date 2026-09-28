-- Public portal reads (no login): ISP identity + published hotspot packages + settings.
-- Tight scope: slug lookup and enabled hotspot/voucher packages only.
drop policy if exists isps_public_portal on public.isps;
create policy isps_public_portal on public.isps for select
  using (true);
drop policy if exists pkg_public_portal on public.packages;
create policy pkg_public_portal on public.packages for select
  using (enabled = true and service_type in ('hotspot','voucher'));
drop policy if exists ispset_public_portal on public.isp_settings;
create policy ispset_public_portal on public.isp_settings for select
  using (true);
