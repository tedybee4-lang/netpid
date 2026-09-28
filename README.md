# NETPID — Complete ISP Management Platform
**Manage. Connect. Bill.**

Production-ready multi-tenant SaaS for ISPs (Kenya-first, KES/KSh).

## Structure

```
netpid/
  apps/web/            # Next.js 14 App Router (Vercel)
  supabase/migrations/ # PostgreSQL schema + RLS + functions/triggers
  supabase/seed.sql    # Plans, feature flags, bootstrap
  network-worker/      # Persistent Node.js worker (MikroTik, RADIUS ops, jobs)
  freeradius/          # FreeRADIUS SQL config + deployment docs (runs on VPS, NOT Vercel)
  docs/                # Architecture, phases, runbooks
```

## Phase plan (per spec §77)

- [x] PHASE 1: Supabase, DB, auth, multi-tenancy, Super Admin, ISP Admin, RLS, subscriptions
- [x] PHASE 2: customers, packages, PayHero, TOPSPEED SMS
- [x] PHASE 3: FreeRADIUS infra, RADIUS DB, NAS, health, test-auth
- [x] PHASE 4: MikroTik, PPPoE, HotSpot, captive portal, accounting
- [x] PHASE 5: expiry engine, CoA/disconnect, usage, reports
- [x] PHASE 6: resellers, referrals, inventory, expenses, loyalty
- [x] PHASE 7: TR-069, AI assistant, topology, diagnostics

See `docs/ARCHITECTURE.md`, `docs/PHASES.md`, `docs/FREERADIUS-DEPLOYMENT.md`.

## Quick start (Phase 1)

1. Create Supabase project → link CLI → `supabase db push` (applies `supabase/migrations/*`).
2. Run `supabase/seed.sql` for plans + feature flags.
3. Create first platform admin: sign up in app, then in SQL:
   ```sql
   insert into public.platform_admins (user_id, email, role, is_active)
   values ('<auth.users.id>', 'admin@netpid.app', 'super_admin', true);
   ```
4. `cd apps/web && cp .env.example .env.local && npm i && npm run dev`
5. Deploy `apps/web` to Vercel. Deploy `network-worker` to VPS (Fly/Render/VPS with systemd). Deploy FreeRADIUS per `docs/FREERADIUS-DEPLOYMENT.md`.

## Critical rules

- Every ISP-owned table has `isp_id uuid not null`. RLS enforced, never frontend filtering.
- Never expose service-role keys, PayHero secrets, SMS keys, router passwords, RADIUS secrets to browser.
- `active customer ≠ online session`. Sessions come only from RADIUS accounting.
- No fake data. Empty states say "No data yet." Unconnected integrations say "Not connected."
- Payments activate only on verified webhook, idempotent, never from frontend "success".
