-- NETPID: switch plan pricing to the usage-based VunaFlow model.
--
-- Monthly = min(routers x KSh 500, KSh 2,999) + KSh 20/PPPoE sub
--           + KSh 25/static sub, SMS KSh 0.75, optional KSh 1,000 install.
-- Tiers are the router counts ISPs typically run at. Mirrors
-- apps/web/lib/pricing.ts; keeping the numbers in one place stops the
-- marketing site and the database from drifting apart.
--
-- Legacy fixed-price plans are retired with is_active = false rather than
-- deleted: netpid_subscriptions.plan_id references them, so existing ISPs
-- keep a valid plan row.
insert into public.netpid_plans (slug,name,price_monthly,price_yearly,currency,limits,features) values
  ('starter-pilot','Starter Pilot',50000,600000,'KES',
   '{"routers":1,"customers":50,"radius_users":100,"sms":200,"staff":2,"resellers":0}'::jsonb,
   '["router_1","mpesa_stk","captive_portal","vouchers","live_dashboard","email_whatsapp_support"]'),
  ('growth-isp','Growth ISP',150000,1800000,'KES',
   '{"routers":3,"customers":300,"radius_users":500,"sms":1000,"staff":5,"resellers":10}'::jsonb,
   '["everything_in_starter_pilot","routers_3","pppoe","hotspot","staff_roles","resellers","freeradius","guided_onboarding"]'),
  ('scaled-isp','Scaled ISP',299900,3598800,'KES',
   '{"routers":10,"customers":2000,"radius_users":3000,"sms":5000,"staff":15,"resellers":50}'::jsonb,
   '["everything_in_growth_isp","routers_10_capped","free_router_config_call","inventory","expenses","advanced_reports","topology","diagnostics","tr069"]'),
  ('white-label','White-Label',-1,-1,'KES',
   '{"routers":-1,"customers":-1,"radius_users":-1,"sms":-1,"staff":-1,"resellers":-1}'::jsonb,
   '["perpetual_licensing","on_premise","custom_integrations","white_label","account_manager","sla","support_24_7"]')
on conflict (slug) do update set
  name = excluded.name,
  price_monthly = excluded.price_monthly,
  price_yearly = excluded.price_yearly,
  limits = excluded.limits,
  features = excluded.features,
  is_active = true;

-- Retire the old four fixed-price plans. is_active = false (not DELETE) so
-- existing netpid_subscriptions rows keep a valid plan_id reference.
update public.netpid_plans set is_active = false
where slug in ('starter','professional','business','enterprise')
  and slug not in ('starter-pilot','growth-isp','scaled-isp','white-label');
