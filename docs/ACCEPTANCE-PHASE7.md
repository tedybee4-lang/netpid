# Acceptance Test Plan — Phase 7: TR-069, AI Assistant, Topology & Diagnostics

## 1. TR-069 ACS CPE Device Management
- [ ] List TR-069 CPEs via `/api/tr069`.
- [ ] Register new ONU/ONT device with serial number, vendor, and product class.
- [ ] View devices on `/dashboard/tr069` with live inform timestamps and optical power parameters.
- [ ] Confirm RLS multi-tenant data isolation.

## 2. Network Topology & Distribution Mapping
- [ ] Create core PoP, transmission tower, and fiber splitter nodes via `/api/topology`.
- [ ] Inspect node hierarchy and parent-child linkages on `/dashboard/topology`.
- [ ] Confirm RLS guards prevent cross-ISP network topology visibility.

## 3. Heuristic AI Diagnostics Engine
- [ ] Execute diagnostic check via `POST /api/ai/diagnostics` for an active customer.
  - Verify detection of active vs. missing RADIUS sessions.
  - Verify detection of expired customer billing status.
  - Confirm appropriate severity level (`info`, `medium`, `high`) and actionable advice.
- [ ] Execute diagnostic check for a MikroTik router.
  - Verify detection of offline/unreachable states vs. normal CPU/RAM metrics.
- [ ] Verify log creation in `ai_diagnostic_logs` table.
- [ ] Test UI on `/dashboard/diagnostics` with form submission and output rendering.
