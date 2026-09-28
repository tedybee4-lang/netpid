-- NETPID Phase 2 RLS (c): invoices/receipts/sms/notifications
alter table public.invoices enable row level security;
drop policy if exists invc_member on public.invoices;
create policy invc_member on public.invoices for select using (public.is_isp_member(isp_id));
drop policy if exists invc_platform on public.invoices;
create policy invc_platform on public.invoices for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
drop policy if exists invc_owner on public.invoices;
create policy invc_owner on public.invoices for select
  using (exists (select 1 from public.customers c where c.id = customer_id and c.user_id = auth.uid()));
alter table public.receipts enable row level security;
drop policy if exists rct_member on public.receipts;
create policy rct_member on public.receipts for select using (public.is_isp_member(isp_id));
drop policy if exists rct_platform on public.receipts;
create policy rct_platform on public.receipts for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
alter table public.sms_providers enable row level security;
drop policy if exists smspr_member on public.sms_providers;
create policy smspr_member on public.sms_providers for select using (public.is_isp_member(isp_id));
drop policy if exists smspr_admin on public.sms_providers;
create policy smspr_admin on public.sms_providers for all
  using (public.has_isp_role(isp_id,'admin')) with check (public.has_isp_role(isp_id,'admin'));
alter table public.sms_settings enable row level security;
drop policy if exists smss_member on public.sms_settings;
create policy smss_member on public.sms_settings for select using (public.is_isp_member(isp_id));
drop policy if exists smss_admin on public.sms_settings;
create policy smss_admin on public.sms_settings for all
  using (public.has_isp_role(isp_id,'admin')) with check (public.has_isp_role(isp_id,'admin'));
alter table public.sms_templates enable row level security;
drop policy if exists smst_member on public.sms_templates;
create policy smst_member on public.sms_templates for select using (public.is_isp_member(isp_id));
drop policy if exists smst_admin on public.sms_templates;
create policy smst_admin on public.sms_templates for all
  using (public.has_isp_role(isp_id,'admin')) with check (public.has_isp_role(isp_id,'admin'));
alter table public.sms_logs enable row level security;
drop policy if exists smsl_member on public.sms_logs;
create policy smsl_member on public.sms_logs for select using (public.is_isp_member(isp_id));
alter table public.sms_usage enable row level security;
drop policy if exists smsu_member on public.sms_usage;
create policy smsu_member on public.sms_usage for select using (public.is_isp_member(isp_id));
alter table public.notifications enable row level security;
drop policy if exists not_member on public.notifications;
create policy not_member on public.notifications for select using (public.is_isp_member(isp_id));
drop policy if exists not_self on public.notifications;
create policy not_self on public.notifications for select using (recipient_user_id = auth.uid());
