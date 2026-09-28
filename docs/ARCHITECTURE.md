# NETPID Architecture

## Topology

```
Browser/Mobile → Vercel (Next.js) → Supabase (Postgres + Auth + Edge Functions)
                                          ↓
                                   Network API (authenticated)
                                          ↓
                              Network Worker (persistent, VPS)
                                   ┌────────┴────────┐
                              MikroTik API      FreeRADIUS (radclient/CoA)
                                   │                    │
                              ISP routers         RADIUS SQL DB
                                   │                    │
                              PPPoE/HotSpot ←→ AAA + Accounting
```

Web app = business management. Supabase = app data/auth/logic. FreeRADIUS = AAA only. MikroTik = enforcement. Worker = persistent network ops. PayHero = ISP customer payments (per-ISP credentials, never mixed with NETPID SaaS billing). TOPSPEED = SMS.

## Multi-tenancy

- `isps` is root tenant. All tenant tables carry `isp_id`.
- Auth: Supabase Auth (email/password + MFA for platform admins via `auth.mfa`).
- Authorization helpers (SECURITY DEFINER):
  - `public.is_platform_admin()` — exists in `platform_admins` + active
  - `public.is_isp_member(p_isp uuid)` — exists in `isp_users` active
  - `public.has_isp_role(p_isp uuid, p_role text)` — role check incl. owner/admin wildcard
  - `public.is_customer_owner(p_customer uuid)` — auth.uid linked via `customers.user_id` or portal session
  - `public.is_reseller_customer(p_customer uuid)` — reseller owns customer
- RLS: deny by default; policies per table for platform_admin (bypass via function), isp roles, customer, reseller, anon (public portal / captive portal read-only published data only).
- API: never trust client `isp_id`; derive from session → `isp_users` (header `x-isp-id` validated against membership).

## RADIUS separation (§48)

```
App DB (Supabase) → sync service/worker → RADIUS DB (VPS Postgres) → FreeRADIUS sql module
```

Same-cluster separation also allowed with distinct roles: `radius_auth` (SELECT on auth views only), `radius_acct` (INSERT/UPDATE acct only). No app privileges to AAA. Standard tables `radcheck, radreply, radusergroup, radacct, nas` + NETPID mapping tables `radius_users, radius_groups, radius_nas`.

Tenant isolation in RADIUS: composite identity — FreeRADIUS authorize query filters by `isp_id` resolved from NAS (`nas.isp_id`) or realm/suffix. Same username may exist in two ISPs without collision. Never a global username unique constraint; unique is `(isp_id, username)`.

## Background jobs

`network_jobs` queue (queued/running/completed/failed/retrying/cancelled) + `job_runs` + `network_job_logs`. Worker polls with `FOR UPDATE SKIP LOCKED`, exponential backoff. Scheduled via pg_cron (Supabase) or worker scheduler: expire-packages, sms-queue, radius-sync, session-cleanup, router-health, reconciliation, reports.

## Security

RLS everywhere, encrypted secrets (pgcrypto + app-level AES-GCM via `APP_ENCRYPTION_KEY`, only in server/worker), webhook signature verification, idempotency keys with unique constraints, rate limits (login, OTP, STK, SMS, test-auth), audit_logs (never log secrets), login-attempt tracking + lockout.
