// Drives the EXACT call app/api/routers/quick/route.ts makes, through the EXACT
// module the dashboard imports, with the real database defaults (site networks
// NULL for an ISP that has not set them). This is the user flow, not a unit
// test of the generator in isolation.
//
// Run: node scripts/quickadd-flow-check.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const web = await import(pathToFileURL(
  join(process.cwd(), "..", "apps", "web", "lib", "routeros-installer.ts")).href);

// The isp_router_defaults row as it actually exists in the database today.
const d = {
  mode: "EXISTING", wan: null, lan_bridge: null, lan_ports: null,
  lan_subnet: null, lan_gateway: null, dhcp_pool: null,
  hotspot_enabled: true, hotspot_subnet: null, hotspot_pool: null, hotspot_dns: null,
  pppoe_enabled: true, pppoe_pool: null,
};
const radius = { host: "10.90.0.1", source: "platform" };
const tunnel = { subnet: "10.90.3.0/30", vpsIp: "10.90.3.1", routerIp: "10.90.3.2" };
const keys = { publicKey: "iHtSz+Y0QLqLS+KxUqoTUn45AvMEvUe9NXGMAcK6QmY=" };
const shortname = "netpid-DASHBOARD-FLOW";
const name = "DASHBOARD-FLOW";
const secretOnce = "OPERATOR-SUPPLIED-AT-REQUEST-TIME";

const installerOpts = {
  mode: d.mode,
  identity: name,
  wan: d.wan ?? "ether1",
  lanBridge: d.lan_bridge ?? "bridge-lan",
  lanPorts: d.lan_ports?.length ? d.lan_ports : ["ether2", "ether3", "ether4", "ether5"],
  lanSubnet: d.lan_subnet ?? "",
  lanGateway: d.lan_gateway ?? "",
  dhcpPool: d.dhcp_pool ?? "",
  hotspotEnabled: d.hotspot_enabled !== false,
  hotspotSubnet: d.hotspot_subnet ?? "",
  hotspotPool: d.hotspot_pool ?? "",
  hotspotDnsName: d.hotspot_dns ?? "",
  pppoeEnabled: d.pppoe_enabled !== false,
  pppoePool: d.pppoe_pool ?? "",
  radiusServer: radius.host,
  radiusSecret: secretOnce,
  nasShortname: shortname,
  wgServerPublicKey: keys.publicKey,
  wgServerTunnelIp: tunnel.vpsIp,
  wgRouterTunnelIp: tunnel.routerIp,
  wgEndpoint: "87.76.137.72",
  mgmtNetwork: tunnel.subnet,
};

const response = {
  router: { id: "00000000-0000-0000-0000-000000000000", name, host: tunnel.routerIp },
  detected_version: "7",
  secret_once: secretOnce,
  api_password_once: "GENERATED-AT-REQUEST-TIME",
  installer: web.buildRouterosInstaller(installerOpts, { strict: false }),
  installer_missing: web.installerMissing(installerOpts),
};

mkdirSync(join(process.cwd(), "..", ".kalai", "out"), { recursive: true });
writeFileSync(join(process.cwd(), "..", ".kalai", "out", "quickadd-flow.rsc"),
  response.installer + "\n");

const S = response.installer;
console.log("LINE COUNT :", S.split("\n").length);
console.log("SECTIONS   :");
for (const m of S.matchAll(/^# SECTION ([A-L]) - (.+)$/gm)) {
  console.log(`   ${m[1]}. ${m[2]}`);
}
const need = {
  "A preflight/validation": /NETPID INSTALLER STOPPED/,
  "B identity": /\/system identity set name=\$NP_IDENTITY/,
  "B clock/timezone": /\/system clock set time-zone-name=\$NP_TIMEZONE/,
  "B NTP": /\/system ntp client set servers=\$NP_NTP_SERVERS/,
  "B DNS": /\/ip dns set servers=\$NP_DNS_SERVERS/,
  "C WAN": /\/interface list add name=NETPID-WAN/,
  "C WAN dhcp client": /\/interface dhcp-client add interface=\$NP_WAN/,
  "D LAN bridge": /\/interface bridge add name=\$NP_LAN_BRIDGE/,
  "D LAN address": /\/ip address add address=\$NP_LAN_NET/,
  "D LAN ports": /\/interface bridge port add bridge=\$NP_LAN_BRIDGE/,
  "E DHCP pool": /\/ip pool add name=\$NP_DHCP_POOL/,
  "E DHCP server": /\/ip dhcp-server add name=\$NP_TAG/,
  "E DHCP network": /\/ip dhcp-server network add/,
  "F NAT masquerade": /action=masquerade/,
  "G firewall": /\/ip firewall filter add chain=input/,
  "H WireGuard iface": /\/interface wireguard add name=\$NP_WG_IFACE/,
  "H WireGuard peer": /\/interface wireguard peers add/,
  "I API-SSL": /\/ip service set api-ssl disabled=no/,
  "I API restricted": /address-list=NETPID-MGMT/,
  "J RADIUS client": /\/radius add service=ppp,hotspot/,
  "J accounting": /\/ppp\/aaa set use-radius=yes accounting=yes/,
  "J CoA": /\/radius incoming set accept=yes/,
  "K HotSpot": /\/ip hotspot add name=netpid/,
  "L PPPoE": /\/interface pppoe-server server add/,
  "final report": /NETPID INSTALLATION REPORT/,
};
console.log("SECTIONS PRESENT:");
let bad = 0;
for (const [k, re] of Object.entries(need)) {
  const ok = re.test(S);
  if (!ok) bad++;
  console.log(`   ${ok ? "OK  " : "MISS"} ${k}`);
}
console.log("MISSING            :", bad);
console.log("secret in .rsc     :", S.includes(secretOnce));
console.log("stale 10.10.10.x   :", /10\.10\.10\./.test(S));
console.log("installer_missing  :", response.installer_missing.length, "values");
if (bad) process.exitCode = 1;
