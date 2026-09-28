-- NETPID Phase 2: real auth helpers (replace stubs) + Kenya phone normalize
create or replace function public.is_customer_owner(p_customer_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.customers c
    where c.id = p_customer_id and c.user_id = auth.uid());
$$;
create or replace function public.is_reseller_customer(p_customer_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.customers c
    join public.isp_users iu on iu.isp_id = c.isp_id and iu.user_id = auth.uid()
    where c.id = p_customer_id and c.reseller_id is not null
      and c.reseller_id::text = iu.id::text);
$$;
-- Kenya phone normalization to 254XXXXXXXXX (spec §28)
create or replace function public.normalize_ke_phone(p text)
returns text language plpgsql immutable as $$
declare d text;
begin
  d := regexp_replace(coalesce(p,''), '\D', '', 'g');
  if d like '254%' and length(d) = 12 then return d; end if;
  if d like '0%' and length(d) = 10 then return '254' || substring(d from 2); end if;
  if length(d) = 9 then return '254' || d; end if;
  return d;
end $$;
-- RLS: packages + customers
alter table public.packages enable row level security;
drop policy if exists pkg_platform on public.packages;
create policy pkg_platform on public.packages for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
drop policy if exists pkg_member_read on public.packages;
create policy pkg_member_read on public.packages for select
  using (public.is_isp_member(isp_id));
drop policy if exists pkg_staff_write on public.packages;
create policy pkg_staff_write on public.packages for all
  using (public.has_isp_role(isp_id,'admin')) with check (public.has_isp_role(isp_id,'admin'));
alter table public.package_features enable row level security;
drop policy if exists pf_member on public.package_features;
create policy pf_member on public.package_features for select
  using (exists (select 1 from public.packages p where p.id = package_id and public.is_isp_member(p.isp_id)));
alter table public.customers enable row level security;
drop policy if exists cust_platform on public.customers;
create policy cust_platform on public.customers for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
drop policy if exists cust_member_read on public.customers;
create policy cust_member_read on public.customers for select
  using (public.is_isp_member(isp_id));
drop policy if exists cust_owner_read on public.customers;
create policy cust_owner_read on public.customers for select
  using (user_id = auth.uid());
