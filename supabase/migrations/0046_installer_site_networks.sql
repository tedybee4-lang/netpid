-- Per-ISP site network defaults for the RouterOS installer.
--
-- The installer needs to know the customer's own networks: the LAN, the
-- HotSpot subnet, the PPPoE pool. NETPID must not invent any of them, so these
-- are stored once per ISP and deliberately have NO default. An ISP that has
-- not filled these in gets an installer with blanks, and the installer's own
-- preflight stops and lists them.
--
-- This is the difference between a provisioning system that refuses to guess
-- and one that hands a live ISP router a subnet nobody chose.

alter table public.isp_router_defaults
  add column if not exists mode text not null default 'EXISTING'
    check (mode in ('NEW','EXISTING')),
  add column if not exists wan text,
  add column if not exists lan_bridge text,
  add column if not exists lan_ports text[],
  add column if not exists lan_subnet cidr,
  add column if not exists lan_gateway inet,
  add column if not exists dhcp_pool text,
  add column if not exists hotspot_enabled boolean not null default true,
  add column if not exists hotspot_subnet cidr,
  add column if not exists hotspot_pool text,
  add column if not exists hotspot_dns text,
  add column if not exists pppoe_enabled boolean not null default true,
  add column if not exists pppoe_pool text;

comment on column public.isp_router_defaults.mode is
  'NEW = clean router, EXISTING = keep what is there. EXISTING never deletes customer config.';
comment on column public.isp_router_defaults.lan_subnet is
  'Operator-supplied. NULL means the installer keeps the router''s existing LAN rather than inventing one.';
comment on column public.isp_router_defaults.hotspot_subnet is
  'Operator-supplied HotSpot subnet. The captive portal is separate from the wired LAN.';
comment on column public.isp_router_defaults.pppoe_pool is
  'Operator-supplied PPPoE address pool, e.g. 100.64.10.2-100.64.10.250.';
