-- NETPID: let an ISP declare WHICH M-Pesa number their customers pay to.
--
-- payment_providers has carried both till_number and paybill since Phase 2, but
-- nothing ever said which one was live. An ISP could leave both filled in, and
-- the captive portal could only ever print the generic "pay the operator's
-- Till/PayBill" line, so a customer standing at the till still had to ask which
-- number to use. This adds the one explicit choice.
--
-- Backfilled from whichever number is already stored, so an existing ISP keeps
-- working with no re-entry and no loss of data. NULL is allowed and means "not
-- declared yet" — a check constraint passes on NULL, so this is safe to apply
-- to a table that already has rows.
--
-- Deliberately left NULL for payhero: the field describes an M-Pesa pay-in
-- target, which is a Till/PayBill concept, not a card or bank transfer.
alter table public.payment_providers
  add column if not exists payment_method text
    check (payment_method in ('till','paybill'));

update public.payment_providers
   set payment_method = case
         when till_number is not null and btrim(till_number) <> '' then 'till'
         when paybill   is not null and btrim(paybill)   <> '' then 'paybill'
         else null
       end
 where payment_method is null;

-- The captive portal is anonymous and reads isp_settings, which is public-read.
-- payment_providers is service-role territory, so the number the customer is told
-- to pay is mirrored onto isp_settings. These are display fields only — a Till or
-- PayBill number is printed on the till in public, so mirroring leaks nothing,
-- and it keeps the portal on a table it is already allowed to read.
alter table public.isp_settings
  add column if not exists pay_method text
    check (pay_method in ('till','paybill')),
  add column if not exists pay_number text;

-- Backfill for ISPs who configured a number before this existed.
update public.isp_settings s
   set pay_method = coalesce(s.pay_method, p.payment_method),
       pay_number = coalesce(s.pay_number, p.till_number, p.paybill)
  from public.payment_providers p
 where p.isp_id = s.isp_id
   and p.provider = 'daraja'
   and (s.pay_number is null or s.pay_method is null);
