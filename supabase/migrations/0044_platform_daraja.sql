-- NETPID runs ONE Daraja app for the whole platform.
--
-- Previously every ISP held their own Daraja app, which meant every ISP had to
-- obtain a consumer key, secret, passkey and shortcode from Safaricom before
-- they could take a single shilling. That is a multi-week onboarding wall for a
-- business whose entire premise is that NETPID does the heavy lifting.
--
-- Daraja's Initiator model removes it: the platform authenticates with its own
-- credentials and names the RECEIVER's Till/PayBill per request. So:
--
--   - one platform row (isp_id IS NULL) holds the app's encrypted envelope;
--   - each ISP declares only the Till/PayBill they own;
--   - the STK push authenticates as the platform and collects into that Till.
--
-- Customer money therefore lands in the ISP's own Till and never touches NETPID.

alter table public.payment_providers
  alter column isp_id drop not null;

-- `unique (isp_id, provider)` does NOT constrain NULLs: Postgres treats every
-- NULL as distinct, so without this a second platform daraja row could be
-- inserted and getDarajaCreds would pick an arbitrary one. One app, one row.
create unique index if not exists uq_payment_providers_platform
  on public.payment_providers (provider) where isp_id is null;

-- A platform row authenticates; it must never carry a pay target, or the app
-- would be collectable into a number that is not an ISP's. The Till/PayBill
-- belongs on the ISP row, which is what the push reads.
alter table public.payment_providers
  add constraint payment_providers_platform_has_no_target
  check (isp_id is not null or (till_number is null and paybill is null));
