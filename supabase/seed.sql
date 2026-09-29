-- NETPID seed: roles, plans, feature flags (idempotent)
insert into public.isp_roles (slug, name, description, permissions) values
 ('owner','ISP Owner','Full ISP access','["*"]'),
 ('admin','ISP Admin','Manage staff, settings, billing','["customers.*","payments.*","reports.*","staff.read"]'),
 ('technician','Technician','Routers, network, sessions','["routers.*","network.*","sessions.*"]'),
 ('cashier','Cashier','Payments, customers, receipts','["payments.*","customers.read","receipts.*"]'),
 ('support','Support Agent','Customers, tickets','["customers.read","tickets.*"]'),
 ('reseller','Reseller','Assigned customers only','["reseller.*"]')
on conflict (slug) do nothing;

-- Pricing mirrors apps/web/lib/pricing.ts (single source of truth).
-- Usage-based: KSh 500/router/month capped at 2,999, +20/PPPoE sub, +25/static
-- sub, +0.75/SMS, optional KSh 1,000 one-time installation.
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

insert into public.feature_flags (key,name,description,enabled_default) values
 ('pppoe','PPPoE','PPPoE service management',true),
 ('hotspot','HotSpot','Captive portal + HotSpot',true),
 ('radius','RADIUS','FreeRADIUS integration',true),
 ('tr069','TR-069','TR-069 ACS (future)',false),
 ('resellers','Resellers','Reseller module',true),
 ('loyalty','Loyalty','Customer loyalty',false),
 ('ai_assistant','AI Assistant','RLS-scoped assistant',false),
 ('page_builder','Page Builder','Public ISP pages',true),
 ('advanced_reports','Advanced Reports','Full reporting suite',true)
on conflict (key) do nothing;
