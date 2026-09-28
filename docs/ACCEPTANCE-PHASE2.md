# NETPID Phase 2 acceptance
- Packages: create PPPoE/HotSpot/voucher/static with price/duration/speed/cap; cross-ISP read returns 0 rows
- Customers: create + search/filter; owner sees own row; forged isp_id insert fails
- PayHero: initiate creates pending + reconciliation + payhero-stk job, never activates; bad signature → 401 rejected; good webhook activates once (payment, entitlement, receipt, invoice, matched); duplicate tx → duplicate, no double-activate; amount mismatch → 422
- SMS: 07…/+254…/712… normalize to 254…; queue → sms-send respects limits; no key → queued + "provider unavailable", never fake sent
- Dashboard shows live revenue/customers/payments/SMS; network still "Not connected."
