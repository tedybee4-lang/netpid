# NETPID Phase 1 acceptance (subset of §§75-76)
- Auth: signup → /onboarding; login/logout; reset email; MFA for platform admins
- Tenancy TEST 10: ISP A user cannot read ISP B row (RLS returns 0 rows); forged isp_id insert fails
- Subscriptions: new ISP gets trialing + 14d trial; isp_access_allowed true in trial, false suspended
- Platform: non-admin /platform-admin → /dashboard; /api/platform/summary 403 vs 200
- Jobs: enqueue_job('health-report') → worker completes
- No fakes: "No data yet." / "Not connected." states verified
