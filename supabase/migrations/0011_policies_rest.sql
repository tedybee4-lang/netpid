-- NETPID Phase 1: remaining RLS (settings, roles, users, billing, logs, jobs)
alter table public.isp_settings enable row level security;
drop policy if exists ispset_platform on public.isp_settings;
create policy ispset_platform on public.isp_settings for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
drop policy if exists ispset_member on public.isp_settings;
create policy ispset_member on public.isp_settings for select
  using (public.is_isp_member(isp_id));
drop policy if exists ispset_admin_write on public.isp_settings;
create policy ispset_admin_write on public.isp_settings for all
  using (public.has_isp_role(isp_id,'admin'))
  with check (public.has_isp_role(isp_id,'admin'));
alter table public.isp_roles enable row level security;
drop policy if exists roles_read on public.isp_roles;
create policy roles_read on public.isp_roles for select using (true);
drop policy if exists roles_write on public.isp_roles;
create policy roles_write on public.isp_roles for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
alter table public.isp_users enable row level security;
drop policy if exists iu_platform on public.isp_users;
create policy iu_platform on public.isp_users for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
drop policy if exists iu_member_read on public.isp_users;
create policy iu_member_read on public.isp_users for select
  using (public.is_isp_member(isp_id));
drop policy if exists iu_admin_write on public.isp_users;
create policy iu_admin_write on public.isp_users for all
  using (public.has_isp_role(isp_id,'admin'))
  with check (public.has_isp_role(isp_id,'admin'));
alter table public.isp_user_roles enable row level security;
drop policy if exists iur_platform on public.isp_user_roles;
create policy iur_platform on public.isp_user_roles for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
alter table public.netpid_plans enable row level security;
drop policy if exists plans_read on public.netpid_plans;
create policy plans_read on public.netpid_plans for select using (true);
drop policy if exists plans_write on public.netpid_plans;
create policy plans_write on public.netpid_plans for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
alter table public.netpid_subscriptions enable row level security;
drop policy if exists subs_platform on public.netpid_subscriptions;
create policy subs_platform on public.netpid_subscriptions for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
drop policy if exists subs_member on public.netpid_subscriptions;
create policy subs_member on public.netpid_subscriptions for select
  using (public.is_isp_member(isp_id));
alter table public.netpid_subscription_payments enable row level security;
drop policy if exists subpay_platform on public.netpid_subscription_payments;
create policy subpay_platform on public.netpid_subscription_payments for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
drop policy if exists subpay_member on public.netpid_subscription_payments;
create policy subpay_member on public.netpid_subscription_payments for select
  using (public.is_isp_member(isp_id));
alter table public.netpid_invoices enable row level security;
drop policy if exists inv_platform on public.netpid_invoices;
create policy inv_platform on public.netpid_invoices for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
drop policy if exists inv_member on public.netpid_invoices;
create policy inv_member on public.netpid_invoices for select
  using (public.is_isp_member(isp_id));
alter table public.audit_logs enable row level security;
drop policy if exists audit_platform on public.audit_logs;
create policy audit_platform on public.audit_logs for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
drop policy if exists audit_member on public.audit_logs;
create policy audit_member on public.audit_logs for select
  using (isp_id is not null and public.has_isp_role(isp_id,'admin'));
alter table public.security_events enable row level security;
drop policy if exists sec_platform on public.security_events;
create policy sec_platform on public.security_events for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
alter table public.login_attempts enable row level security;
drop policy if exists login_platform on public.login_attempts;
create policy login_platform on public.login_attempts for select
  using (public.is_platform_admin());
alter table public.support_sessions enable row level security;
drop policy if exists sup_platform on public.support_sessions;
create policy sup_platform on public.support_sessions for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
alter table public.network_jobs enable row level security;
drop policy if exists jobs_platform on public.network_jobs;
create policy jobs_platform on public.network_jobs for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
drop policy if exists jobs_member on public.network_jobs;
create policy jobs_member on public.network_jobs for select
  using (isp_id is not null and public.is_isp_member(isp_id));
alter table public.job_runs enable row level security;
drop policy if exists runs_platform on public.job_runs;
create policy runs_platform on public.job_runs for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
alter table public.network_job_logs enable row level security;
drop policy if exists jlog_platform on public.network_job_logs;
create policy jlog_platform on public.network_job_logs for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
