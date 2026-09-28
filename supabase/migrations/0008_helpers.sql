-- NETPID Phase 1: auth helpers (tables already exist at this point)
create or replace function public.is_platform_admin()
returns boolean language sql security definer stable
set search_path = public as $$
  select exists (select 1 from public.platform_admins pa
    where pa.user_id = auth.uid() and pa.is_active = true);
$$;
create or replace function public.is_isp_member(p_isp_id uuid)
returns boolean language sql security definer stable
set search_path = public as $$
  select exists (select 1 from public.isp_users iu
    where iu.isp_id = p_isp_id and iu.user_id = auth.uid() and iu.is_active = true);
$$;
create or replace function public.has_isp_role(p_isp_id uuid, p_role text)
returns boolean language sql security definer stable
set search_path = public as $$
  select exists (
    select 1 from public.isp_users iu
    join public.isp_user_roles iur on iur.isp_user_id = iu.id
    join public.isp_roles r on r.id = iur.role_id
    where iu.isp_id = p_isp_id and iu.user_id = auth.uid() and iu.is_active = true
      and (r.slug = p_role or r.slug in ('owner','admin')));
$$;
create or replace function public.isp_access_allowed(p_isp_id uuid)
returns boolean language sql security definer stable
set search_path = public as $$
  select exists (
    select 1 from public.isps i where i.id = p_isp_id
      and i.status not in ('suspended','cancelled')
      and (i.subscription_status in ('trialing','active','grace')
        or (i.subscription_status = 'past_due' and coalesce(i.grace_until, now()) >= now())
        or (i.trial_ends_at is not null and i.trial_ends_at >= now())));
$$;
-- Phase-2 stubs (real versions land with customers/resellers tables)
create or replace function public.is_customer_owner(p_customer_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select false; $$;
create or replace function public.is_reseller_customer(p_customer_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select false; $$;
