# Acceptance Test Plan — Phase 5: Expiry, CoA, Usage & Reports

## 1. Automated Lifecycle & Expiry Sweeps
- [ ] Enqueue `expire-sweep` job via `enqueue_job(p_kind => 'expire-sweep', p_isp_id => '<isp>')`.
- [ ] Confirm worker sets `customers.status = 'expired'` for all active accounts past `expiry_date`.
- [ ] Confirm RADIUS credentials are set to `enabled = false` and worker syncs radcheck deletion.
- [ ] Confirm pre-expiry SMS reminder sent within 24h of expiry via `expiry-reminders` job and `expiry_reminded_at` timestamp is updated to prevent duplicates.

## 2. Dynamic CoA & Disconnect Execution
- [ ] Trigger `session-kick` job with `username`.
- [ ] Verify CoA Disconnect-Request sent to active NAS via `radclient <nas_ip>:<coa_port> disconnect <secret>` with 8s timeout.
- [ ] Verify fallback: if CoA fails or no NAS is reachable, worker enqueues `router-disconnect` targeting MikroTik `/ppp/active/remove` or `/ip/hotspot/active/remove`.

## 3. Bandwidth Usage Aggregation
- [ ] Execute `usage-rollup` job.
- [ ] Verify user upload/download bytes and session seconds aggregate into `public.data_usage` daily grain.
- [ ] Verify package sales revenue and transaction count aggregate into `public.package_sales_daily`.
- [ ] Test RLS: tenant users only read their own usage rollups; platform admin has global read.

## 4. Reports & CSV Export
- [ ] Access `/dashboard/reports`.
- [ ] Test tab switching between **Revenue**, **Usage**, and **Expiry**.
- [ ] Test date range filtering (7, 30, 90 days).
- [ ] Download CSV export via `/api/reports/export?kind=revenue`, `/api/reports/export?kind=customers`, and `/api/reports/export?kind=usage` and verify headers and formatting.
