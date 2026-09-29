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
   - No Docker / no local database? `supabase db push` cannot run. Use the Management
     API runner instead — it applies the same files and records them in
     `supabase_migrations.schema_migrations`:
     ```sh
     SUPABASE_ACCESS_TOKEN=sbp_xxx node supabase/scripts/apply-migration.mjs --dry-run
     SUPABASE_ACCESS_TOKEN=sbp_xxx node supabase/scripts/apply-migration.mjs
     ```
     (Token: <https://supabase.com/dashboard/account/tokens> with `database_migrations_write`.)
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

## Verifying a change locally

```sh
cd apps/web       && npm run typecheck && npm run build   # tsc --noEmit + production build
cd network-worker && node --test                          # routeros + RADIUS unit tests
node supabase/scripts/apply-migration.mjs --dry-run       # "0 to apply" = schema in sync
```

All three should be green before committing. After `npm run build`, `npm start` serves the
compiled app (override the port with `next start -p 4311`): `/`, `/login`, `/portal/[slug]`
are public, `/dashboard/*` and `/platform-admin/*` redirect to `/login` when unauthenticated.

## Provisioning a router

`network-worker/scripts/provision-router.mjs` creates the router row (the RouterOS password is
AES-256-GCM encrypted with `APP_ENCRYPTION_KEY`), registers the RADIUS NAS and can emit the
generated `<shortname>.rsc` bundle. It runs standalone — no worker process needed.

```sh
cd network-worker
node scripts/provision-router.mjs --isp <slug> --name "Nairobi Core 1" \
  --host 196.201.214.10 --pass '<api-password>' --radius-server 10.0.0.5 \
  --site Nairobi --out ./out --dry-run     # run --help for every flag
```

RouterOS script generation lives in `network-worker/src/routeros.mjs`, the single source of
truth shared by the worker and the dashboard (`POST /api/routers`).

## Troubleshooting

**`Cannot find module …/dist/index.mjs` at startup.** A partially written `node_modules` can
leave a package missing files that its own `package.json` declares, while `npm install` still
reports "up to date" (npm compares versions, not file contents). Verify and repair:

```sh
node scripts/check-node-modules.mjs network-worker/node_modules   # lists every missing entry point
cd network-worker && npm ci                                       # clean reinstall from the lockfile
```

**`supabase db push` fails / "Docker is not running".** Docker is only needed for the local
CLI stack. Use the Management API runner instead (see Quick start step 1).
