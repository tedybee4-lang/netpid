/**
 * List every RouterOS menu path the configure script touches, so a path that
 * moved between RouterOS 6 and 7 can be found in one pass instead of one
 * field report at a time.
 *
 * DHCP client was found this way: the router answered
 *   bad command name dhcp-client (line 9 column 26)
 * because v7 moved it to /ip/dhcp-client. RADIUS had already been caught the
 * same way. Every move between the two versions is a silent failure of exactly
 * the same shape, so the paths are listed and reviewed together.
 *
 * Run: node scripts/menu-paths.mjs
 */
import { buildConfigureScript } from "../../apps/web/lib/mikrotik-provision-script.ts";

const base = {
  routerId: "11111111-2222-3333-4444-555555555555",
  rosMajor: 7,
  mode: "HOTSPOT",
  wan: "ether1",
  hotspotPorts: ["ether2"],
  hotspotIface: "bridge-lan",
  hotspotSubnet: "10.5.50.0/24",
  hotspotRange: "10.5.50.10-10.5.50.250",
  hotspotDnsName: "login.example.net",
  pppoePorts: ["ether3"],
  pppoePool: "pool-pppoe",
  pppoeRanges: "100.64.10.10-100.64.10.250",
  pppoeLocal: "100.64.10.1",
  radiusServer: "10.0.0.1",
  radiusSecret: "s",
  nasShortname: "n",
  radiusAuthPort: 1812,
  radiusAcctPort: 1813,
  radiusCoaPort: 3799,
  pppoeService: "p",
  bridgeIface: "bridge-lan",
  heartbeatUrl: "https://example.net/api/provision/mikrotik/heartbeat/r1",
  heartbeatName: "hb",
};

for (const major of [7, 6]) {
  const s = buildConfigureScript({ ...base, rosMajor: major });
  const paths = new Set();
  for (const line of s.split(/\r?\n/)) {
    if (line.trim().startsWith("#")) continue;
    for (const m of line.matchAll(/\/(?:interface|ip|radius|queue|tool|system|caps)[a-z0-9]*(?:[ /-][a-z0-9]+)*/g)) {
      paths.add(m[0].replace(/\s*(find|get|add|set|remove|print|enable|disable)\s*$/, "").trim());
    }
  }
  console.log(`\n  RouterOS ${major}.x menu paths:`);
  for (const p of [...paths].sort()) console.log(`    ${p}`);
}

// The paths that must differ between the two versions.
const v7 = buildConfigureScript({ ...base, rosMajor: 7 });
const v6 = buildConfigureScript({ ...base, rosMajor: 6 });
const grab = (s) => new Set([...s.matchAll(/\/(?:interface|ip|radius)[a-z0-9 -]*(?:dhcp-client|radius)/g)].map((m) => m[0]));
const a = grab(v7), b = grab(v6);
console.log("\n  version-specific paths:");
for (const p of a) if (!b.has(p)) console.log(`    v7 only : ${p}`);
for (const p of b) if (!a.has(p)) console.log(`    v6 only : ${p}`);
