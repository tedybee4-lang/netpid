-- NETPID Phase 2 RLS (b): staff writes + devices + payments + creds lockdown
drop policy if exists cust_staff_write on public.customers;
create policy cust_staff_write on public.customers for all
  using (public.has_isp_role(isp_id,'cashier') or public.has_isp_role(isp_id,'support'))
  with check (public.has_isp_role(isp_id,'cashier') or public.has_isp_role(isp_id,'support'));
alter table public.customer_devices enable row level security;
drop policy if exists cd_member on public.customer_devices;
create policy cd_member on public.customer_devices for all
  using (public.is_isp_member(isp_id)) with check (public.is_isp_member(isp_id));
drop policy if exists cd_platform on public.customer_devices;
create policy cd_platform on public.customer_devices for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
alter table public.customer_addresses enable row level security;
drop policy if exists ca_member on public.customer_addresses;
create policy ca_member on public.customer_addresses for all
  using (public.is_isp_member(isp_id)) with check (public.is_isp_member(isp_id));
drop policy if exists ca_platform on public.customer_addresses;
create policy ca_platform on public.customer_addresses for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
alter table public.payment_providers enable row level security;
drop policy if exists pp_member_read on public.payment_providers;
create policy pp_member_read on public.payment_providers for select
  using (public.is_isp_member(isp_id));
drop policy if exists pp_admin_write on public.payment_providers;
create policy pp_admin_write on public.payment_providers for all
  using (public.has_isp_role(isp_id,'admin')) with check (public.has_isp_role(isp_id,'admin'));
drop policy if exists pp_platform on public.payment_providers;
create policy pp_platform on public.payment_providers for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
-- credentials: NO policies for anon/authenticated → only service-role can read
alter table public.payment_provider_credentials enable row level security;
alter table public.sms_credentials enable row level security;
alter table public.payments enable row level security;
drop policy if exists pay_member_read on public.payments;
create policy pay_member_read on public.payments for select
  using (public.is_isp_member(isp_id));
drop policy if exists pay_cashier_write on public.payments;
create policy pay_cashier_write on public.payments for insert
  with check (public.has_isp_role(isp_id,'cashier'));
drop policy if exists pay_platform on public.payments;
create policy pay_platform on public.payments for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
drop policy if exists pay_owner_read on public.payments;
create policy pay_owner_read on public.payments for select
  using (exists (select 1 from public.customers c where c.id = customer_id and c.user_id = auth.uid()));
alter table public.payment_webhooks enable row level security;
drop policy if exists pwh_platform on public.payment_webhooks;
create policy pwh_platform on public.payment_webhooks for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
alter table public.payment_reconciliation enable row level security;
drop policy if exists prec_member on public.payment_reconciliation;
create policy prec_member on public.payment_reconciliation for select
  using (public.is_isp_member(isp_id));
drop policy if exists prec_platform on public.payment_reconciliation;
create policy prec_platform on public.payment_reconciliation for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
