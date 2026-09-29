-- NETPID: operator support contact, and the super-admin session policy.
--
-- 1. The support number the operator supplied: 0112973941, used for BOTH the
--    voice line and WhatsApp. Set as a backfill for ISPs created before this
--    migration that have no support number yet, so the public portal shows a
--    real contact instead of an em dash. Existing rows that already have their
--    own number are left alone — this is a default, not an override.
update public.isps
   set support_phone = '0112973941',
       support_whatsapp = '0112973941'
 where (support_phone is null or support_phone = '')
   and (support_whatsapp is null or support_whatsapp = '');

-- New ISPs get it as the column default too, so an operator who never opens
-- Settings still publishes a contactable number on their portal.
alter table public.isps
  alter column support_phone set default '0112973941',
  alter column support_whatsapp set default '0112973941';
