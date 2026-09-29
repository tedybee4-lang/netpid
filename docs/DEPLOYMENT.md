# NETPID — VPS integration and M-Pesa: what is already there, what is missing

Written before the VPS is provisioned, so nothing here depends on a machine you
have not bought yet. Read the "State" column before assuming a module works.

---

## 1. What the codebase already has

| Piece | Where | State |
|---|---|---|
| RouterOS API client (TCP + TLS, binary protocol) | `network-worker/src/routeros.mjs` | **done, 55 tests** |
| Script generator, v6 + v7 | `network-worker/src/routeros.mjs`, `apps/web/lib/routeros.ts` | **done** |
| RADIUS NAS/user/profile tables | migrations `0010`, `0024` | **done** |
| Session accounting mirror | migration `0027` | **done** |
| M-Pesa STK push | `apps/web/app/api/payments`, `payments/webhook` | **scaffolded** |
| SMS queue (provider-agnostic) | migration `0014` | **table ready, no provider wired** |
| Encrypted secret storage | `apps/web/lib/secrets.ts` | **done** |

Read `network-worker/src/routeros.mjs` before writing anything against it — the
rate ordering and v6/v7 menu paths are pinned by tests and are easy to get wrong.

---

## 2. The VPS: what it is for

One box, three jobs. Nothing needs a VPS to develop against; this is the order
to provision in.

### 2a. FreeRADIUS (required first — everything else depends on it)

The dashboard holds the *intent* (users, limits, expiry). RADIUS is what actually
authenticates a subscriber at 09:00 on a Tuesday.

- Ubuntu 22.04, 2 vCPU / 2 GB is plenty for 2,000 subscribers.
- Install `freeradius` + `postgresql`. Point its SQL module at the **same**
  Postgres as Supabase, as a read-only role.
- `mods-available/sql` → set `sql_query` to the lookup in
  `docs/RADIUS-QUERIES.sql`.
- Set `Auth-Type = SQL` and confirm a test user authenticates:
  `radtest localhost <user> <pass>`.
- Open 1812/udp, 1813/udp, and 3799/udp (CoA) to the routers only — never
  0.0.0.0/0.

**The lookup query is the delicate part.** RADIUS needs `Cleartext-Password` or a
hash it can verify. NETPID does not store a plaintext password for PPPoE
subscribers (it stores a hash for the portal). Resolve this before writing SQL:
either add a `radius_password` column holding a value FreeRADIUS can check, or
authenticate via `Auth-Type := Accept` with the shared secret. **Do not** put
`Cleartext-Password := SELECT password FROM ...` against a hashed column — it
will silently fail every login.

### 2b. network-worker (the poller)

This is what makes the dashboard live: it polls every router, pulls sessions,
and pushes changes.

- Node 20 LTS, run under `systemd` with `Restart=always`.
- `network-worker/` already has the RouterOS client. It needs a scheduler
  (a plain `setInterval` is fine to start; `node-cron` if you want windows).
- Environment: the Supabase service-role key, `RADIUS_HOST`, and the
  `APP_ENCRYPTION_KEY` the web app uses. **They must match** — the worker
  decrypts router API passwords the web app encrypted.
- Start with one router, confirm its `last_seen_at` moves, then add the rest.

### 2c. The web app

- Vercel already hosts it. If you self-host instead, it is a standard Next.js
  standalone build behind nginx with TLS.
- Do **not** expose the Postgres port. Supabase is reached over TLS on its
  pooled connection string.

---

## 3. M-Pesa (Daraja)

### What has to be true before any of this works

1. **A Safaricom paybill.** This is the slow part — approval is not instant and
   is not something code can substitute for. Start it first.
2. **Daraja app credentials** from the Safaricom developer portal.
3. **A public HTTPS callback URL** for the result/timeout notification. A VPS
   with a domain is the simplest way to get this; a tunnel works for testing.

### Credentials to add (never in git)

```
MPESA_CONSUMER_KEY
MPESA_CONSUMER_SECRET
MPESA_SHORTCODE      # your paybill
MPESA_PASSKEY
MPESA_ENVIRONMENT    # sandbox | production
MPESA_CALLBACK_URL   # https://api.safaricom.co.ke/mpesa/stkcallback/v1
```

### The flow, and where it is already wired

```
Customer clicks "Pay"
  → POST /api/payments        creates a payments row in 'pending',
                               STK push to the customer's phone
  → Customer approves on the handset
  → Safaricom POSTs to /api/payments/webhook
  → verify the callback, mark the payment 'success',
    extend the customer's expiry, write loyalty points
```

`payments` rows and the webhook route exist. **The parts still to write:**

- Daraja request signing (timestamp + base64 of a `{BusinessShortCode, Timestamp, Password}` digest).
- The STK push call itself.
- **Callback verification.** Safaricom does not sign the callback the way
  Daraja signs the request. Validate the `ResultCode`, check the
  `AccountReference`/`CheckoutRequestID` match the row you created, and reject
  anything else. An unvalidated callback endpoint is a free top-up button.
- Idempotency: Darama retries a callback. A second success callback for the
  same request must not extend the subscription twice.
- A `stkcallback` route in `network-worker` if you want pushes when the browser
  is closed.

### Sandbox first

Use `MPESA_ENVIRONMENT=sandbox` and the Safaricom test MSISDN
`254700000000` / any PIN. Do not point production at a live paybill until a
sandbox payment has gone all the way through the callback, twice, without
double-extending the subscription.

---

## 4. Order of work

1. Safaricom paybill application — **start today, it is not code**
2. FreeRADIUS on the VPS, verified with `radtest`
3. network-worker polling one router
4. M-Pesa in sandbox, full callback round trip
5. Add routers and subscribers
6. Flip M-Pesa to production
7. Add a public portal domain + TLS

Each step is verifiable on its own. Nothing above needs the step after it.
