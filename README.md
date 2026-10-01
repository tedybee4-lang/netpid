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
4. Run the web app from its own directory (Next.js only reads `.env.local` from the app root):
   ```sh
   cd apps/web
   cp .env.example .env.local   # then OPEN it and paste the REAL Supabase keys
   npm i
   npm run dev                  # http://localhost:3000 - must log "Environments: .env.local"
   ```
   Starting from the repo root (there is no root `package.json`), or leaving the
   `replace-me` / localhost placeholders from `.env.example` in place, produces
   "Invalid API key" (HTTP 401 `invalid_api_key`) plus an unstyled page.
5. Deploy `apps/web` to Vercel. Deploy `network-worker` to VPS (Fly/Render/VPS with systemd). Deploy FreeRADIUS per `docs/FREERADIUS-DEPLOYMENT.md`.

## Deploying to Vercel

What Vercel runs is exactly the local gate: `npm ci && next build` inside `apps/web`. That build
is green (56 routes — `/`, `/login`, `/signup`, `/onboarding`, `/reset-password` prerendered;
everything under `/dashboard/*`, `/portal/[slug]/*`, `/platform-admin` and `/api/*` server-rendered
on demand, so all runtime reads happen against live env vars, never at build time).

1. <https://vercel.com/new> → import `tedybee4-lang/netpid`.
2. **Root Directory → `apps/web`** (Settings → General). This is the one setting that CANNOT be
   committed — `vercel.json` has no such field and the repo deliberately has no root
   `package.json`. Without it Vercel finds nothing to install. With it, Framework / Build Command /
   Output Directory auto-detect as `Next.js` / `next build` / `.next`; leave them alone.
3. **Environment Variables** — the same names as `apps/web/.env.example`:

   | Key | Value from | Scope |
   | --- | --- | --- |
   | `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API → Project URL | all environments (bundled into the browser) |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | same page → `anon` `public` key | all environments (bundled into the browser; public by design, guarded by RLS) |
   | `SUPABASE_SERVICE_ROLE_KEY` | same page → `service_role` key | Production + Preview, **server only** |
   | `APP_ENCRYPTION_KEY` | `openssl rand -base64 32` (must decode to exactly 32 bytes — `lib/secrets.ts` enforces this) | Production + Preview, **server only**; must be byte-identical to `network-worker`, or router passwords already stored in the DB cannot be decrypted |
   | `PAYHERO_WEBHOOK_SECRET` | PayHero dashboard | Production + Preview, **server only**. **Legacy** — only `POST /api/payments/webhook` and pre-existing `provider = 'payhero'` rows read it. New ISPs use Daraja and can leave it unset |
   | `DARAJA_CALLBACK_URL` | `https://<your-domain>/api/payments/daraja-callback` | Production, **server only**, optional — falls back to the request origin on every STK push, so it is only needed when the app is reached through an internal hostname that Safaricom cannot resolve |

   Never prefix any of the server-only keys with `NEXT_PUBLIC_` — they are read in
   `lib/supabase/server.ts`, `lib/secrets.ts` and `lib/payment-security.ts`, and `NEXT_PUBLIC_`
   would bake them into the public browser bundle. Pasting `.env.example` placeholders verbatim is
   what produced the original "Invalid API key" failure; Vercel has no `.env.local`, so the real
   values must be entered here.
4. After the first deploy: Supabase → Authentication → URL Configuration → set the Site URL to the
   Vercel domain (otherwise reset/magic-link emails point at localhost), and point the Daraja
   callback at `https://<your-domain>/api/payments/daraja-callback`.

#### M-Pesa (direct Safaricom Daraja)

Daraja credentials are **one platform app, not per-ISP and not environment variables**. A Super Admin
enters NETPID's consumer key / consumer secret / passkey / environment once at `/admin/payments`,
which stores them as an AES-256-GCM envelope against the `payment_providers` row whose `isp_id IS NULL`
(RLS enabled, no policies on `payment_provider_credentials` → readable only by the service role).
An ISP declares **only** the Till/PayBill they own at `/dashboard/settings/mpesa` — no credentials,
no Safaricom account, nothing to apply for.

Each STK push authenticates as the platform and names that ISP's Till as the receiver
(`BusinessShortCode` and `PartyB`), so customer money lands in the ISP's own account and never passes
through NETPID. `lib/daraja.ts` composes the two halves in `getDarajaCreds()`.

**Operational requirement:** Safaricom must have every ISP's Till registered as a Receiver on the
platform app. An unregistered Till is rejected at push time and the customer sees the failure, so
onboarding a new ISP includes adding their Till to the app.

- STK push: `POST /api/payments/stk` creates a `pending` payment and never activates service.
- Callback: `POST /api/payments/daraja-callback` activates **only** on `ResultCode === 0` with a
  matching `CheckoutRequestID` and an amount equal to the stored row.
- Captive portal: STK only. There is no manual receipt path on the public portal; the number the
  customer needs is inside the M-Pesa prompt. `POST /api/payments/manual` still exists for the
  **staff dashboard** (an operator recording a payment they saw on their own handset); unique on
  `mpesa_receipt`, so a receipt can never be banked twice.

Only `apps/web` belongs on Vercel: `network-worker` needs a long-running host (VPS with systemd,
Fly, Render) and `freeradius/` runs on your own server — see Quick start step 5.

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

The authenticated half (`/dashboard/*`, guarded `/api/*`) needs an `@supabase/ssr` session
cookie, so curl cannot reach it:

```sh
node scripts/smoke-auth.mjs --provision   # test user + ISP membership (needs SERVICE_ROLE_KEY)
node scripts/smoke-auth.mjs              # mints the session cookie, hits every guarded route
node scripts/smoke-auth.mjs --cleanup    # delete the test user again (membership cascades)
```

It prints status, size, empty-state copy and ISP name per route, and re-checks that a
cookie-less request still redirects to `/login`.

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
