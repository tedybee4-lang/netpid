# NETPID Phase 3 acceptance (§§9-14, §75 TESTs 1-4, 10)
- NAS: register → unique secret shown once, encrypted at rest, never returned by API; cross-ISP NAS read returns 0 rows
- Users: same username in two ISPs coexists (unique isp_id+username); disabled customer → enabled=false, radcheck rows removed → auth fails (TEST 3); reactivated → re-synced → accept (TEST 4)
- Groups: package create/update auto-provisions tenant group + Mikrotik-Rate-Limit/Session-Timeout/Idle-Timeout/Port-Limit from package fields, never hard-coded
- Health: statuses from real checks only; unchecked → unknown; TCP fail → offline; no fake ONLINE
- Test-auth: server-side radtest only; rate-limited (10/10min); passwords never logged; results SUCCESS/REJECT/TIMEOUT/ERROR
- Worker: radius-nas-sync/user-sync/health jobs retry with backoff; missing RADIUS_DB_URL → clear error, job retrying
