-- NETPID Phase 6: RLS for Resellers, Referrals, Inventory, Expenses, Loyalty Ledger

-- Helper: active member with owner/admin role in the ISP (used by *_admin policies below)
create or replace function public.is_isp_admin(p_isp_id uuid)
returns boolean language sql security definer stable
set search_path = public as $$
  select public.has_isp_role(p_isp_id, 'owner') or public.has_isp_role(p_isp_id, 'admin');
$$;

-- Resellers
alter table public.resellers enable row level security;
drop policy if exists res_member on public.resellers;
create policy res_member on public.resellers for select using (public.is_isp_member(isp_id));
drop policy if exists res_admin on public.resellers;
create policy res_admin on public.resellers for all
  using (public.is_isp_admin(isp_id)) with check (public.is_isp_admin(isp_id));
drop policy if exists res_platform on public.resellers;
create policy res_platform on public.resellers for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());

-- Referrals
alter table public.referrals enable row level security;
drop policy if exists ref_member on public.referrals;
create policy ref_member on public.referrals for all
  using (public.is_isp_member(isp_id)) with check (public.is_isp_member(isp_id));
drop policy if exists ref_platform on public.referrals;
create policy ref_platform on public.referrals for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());

-- Inventory
alter table public.inventory_items enable row level security;
drop policy if exists inv_member on public.inventory_items;
create policy inv_member on public.inventory_items for select using (public.is_isp_member(isp_id));
drop policy if exists inv_admin on public.inventory_items;
create policy inv_admin on public.inventory_items for all
  using (public.is_isp_admin(isp_id)) with check (public.is_isp_admin(isp_id));
drop policy if exists inv_platform on public.inventory_items;
create policy inv_platform on public.inventory_items for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());

-- Expenses
alter table public.expenses enable row level security;
drop policy if exists exp_member on public.expenses;
create policy exp_member on public.expenses for select using (public.is_isp_member(isp_id));
drop policy if exists exp_admin on public.expenses;
create policy exp_admin on public.expenses for all
  using (public.is_isp_admin(isp_id)) with check (public.is_isp_admin(isp_id));
drop policy if exists exp_platform on public.expenses;
create policy exp_platform on public.expenses for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());

-- Loyalty Ledger
alter table public.loyalty_ledger enable row level security;
drop policy if exists loy_member on public.loyalty_ledger;
create policy loy_member on public.loyalty_ledger for all
  using (public.is_isp_member(isp_id)) with check (public.is_isp_member(isp_id));
drop policy if exists loy_platform on public.loyalty_ledger;
create policy loy_platform on public.loyalty_ledger for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
