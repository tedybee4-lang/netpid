# Acceptance Test Plan — Phase 6: Resellers, Referrals, Inventory, Expenses, Loyalty

## 1. Resellers & Agents
- [ ] Create reseller via `/api/resellers` with name, phone, and commission percentage.
- [ ] Verify agent list in `/dashboard/resellers`.
- [ ] Test RLS: ISP admins can create/update resellers; ISP members can view; non-members receive 403/empty list.

## 2. Hardware & Inventory Tracking
- [ ] Add hardware device (ONU, Router, Switch, Fiber Cable) via `/dashboard/inventory`.
- [ ] Verify serial number, MAC address, and inventory status (`in_stock`, `assigned`, `faulty`).
- [ ] Test RLS isolation: only ISP members/admins access their own hardware stock.

## 3. Operating Expenses Tracking
- [ ] Log operating expense in `/dashboard/expenses` under categories (`upstream_bandwidth`, `rent`, `power`, `transport`, `salaries`).
- [ ] Verify total expense metric calculation in KSh.
- [ ] Verify RLS data isolation across tenants.

## 4. Customer Referrals & Loyalty
- [ ] Verify `referrals` and `loyalty_ledger` tables with customer loyalty balance increment triggers.
- [ ] Confirm RLS policies guard member-read and platform-admin access.
