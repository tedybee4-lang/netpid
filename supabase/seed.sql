-- NETPID seed: roles, plans, feature flags (idempotent)
insert into public.isp_roles (slug, name, description, permissions) values
 ('owner','ISP Owner','Full ISP access','["*"]'),
 ('admin','ISP Admin','Manage staff, settings, billing','["customers.*","payments.*","reports.*","staff.read"]'),
 ('technician','Technician','Routers, network, sessions','["routers.*","network.*","sessions.*"]'),
 ('cashier','Cashier','Payments, customers, receipts','["payments.*","customers.read","receipts.*"]'),
 ('support','Support Agent','Customers, tickets','["customers.read","tickets.*"]'),
 ('reseller','Reseller','Assigned customers only','["reseller.*"]')
on conflict (slug) do nothing;

insert into public.netpid_plans (slug,name,price_monthly,price_yearly,currency,limits,features) values
 ('starter','Starter',150000,1500000,'KES',
  '{"customers":200,"routers":2,"radius_users":200,"sms":500,"staff":3,"resellers":5}'::jsonb,
  '["dashboard","customers","payments","sms","basic_reports"]'),
 ('professional','Professional',350000,3500000,'KES',
  '{"customers":1000,"routers":10,"radius_users":1000,"sms":2000,"staff":10,"resellers":20}'::jsonb,
  '["everything_in_starter","hotspot","pppoe","vouchers","advanced_reports","api"]'),
 ('business','Business',750000,7500000,'KES',
  '{"customers":5000,"routers":30,"radius_users":5000,"sms":5000,"staff":30,"resellers":100}'::jsonb,
  '["everything_in_professional","resellers","inventory","expenses","ai_assistant"]'),
 ('enterprise','Enterprise',1500000,15000000,'KES',
  '{"customers":-1,"routers":-1,"radius_users":-1,"sms":-1,"staff":-1,"resellers":-1}'::jsonb,
  '["everything_in_business","sla","dedicated_support","custom_limits"]')
on conflict (slug) do nothing;

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
