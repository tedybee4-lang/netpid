# NETPID Phases — build order (spec §77)

## PHASE 1 (this scaffold) — Foundation
- Supabase schema: platform_admins, isps, isp_settings, isp_users, plans, subscriptions, invoices, audit/security logs, feature flags, announcements, system tables, job tables.
- RLS + auth helpers on every table. No frontend-only isolation.
- Web: marketing landing, auth (login/signup/reset), onboarding wizard (ISP create), `/dashboard` (ISP admin), `/platform-admin` (super admin, guarded), setup-progress.
- Subscription enforcement middleware (trial/grace/suspended).
- Seed: netpid_plans (Starter/Professional/Business/Enterprise), feature_flags.
- Acceptance: login/logout/reset/MFA roles; ISP isolation (attempt cross-ISP read DENIED); RLS tests.

## PHASE 2 — Customers/Packages/Payments/SMS
Tables: customers, packages, payments, payment_providers/webhooks/reconciliation, invoices/receipts, sms_* , notifications. PayHero STK + webhook idempotency. TOPSPEED queue + KE normalization to 254….

## PHASE 3 — FreeRADIUS
VPS deploy per FREERADIUS-DEPLOYMENT.md. Tables radcheck/radreply/radusergroup/radacct/nas + radius_* mapping. NAS auto-provision on router add. Health dashboard + test-auth (server-side radclient, never browser→RADIUS).

## PHASE 4 — MikroTik/PPPoE/HotSpot/Portal
Router onboarding (encrypted creds), health poller, pppoe_accounts/hotspot_users, captive portal `portal/[ispSlug]`, voucher batches, accounting ingest.

## PHASE 5 — Expiry/CoA/Usage/Reports
Expiry worker → RADIUS update → disconnect/CoA → SMS. Usage aggregation (data_usage), reports + CSV/PDF export.

## PHASE 6 — Resellers/Referrals/Inventory/Expenses/Loyalty

## PHASE 7 — TR-069 (NOT CONNECTED until ACS), AI assistant (RLS-scoped), topology, diagnostics (Fix PPPoE checklist).
