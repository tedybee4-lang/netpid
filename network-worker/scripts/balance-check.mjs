/**
 * Diagnostic: brace- and bracket-balance the generated RouterOS line by line.
 * Run: node scripts/balance-check.mjs
 *
 * Counts `{` and `}` as CHARACTERS, not as line-end patterns. Several
 * statements legitimately open and close a block on one line:
 *   :if ([:len $x] = 0) do={ :set x 1 } else={ :set x 2 }
 * A line-end-only heuristic under-counts those and reports a false imbalance.
 *
 * An unbalanced script fails part way through a paste and leaves the router
 * half configured, which is the worst possible outcome of this engine.
 */
import { buildConfigureScript, buildBootstrapScript } from "../../apps/web/lib/mikrotik-provision-script.ts";

const base = {
  routerId: "r1", rosMajor: 7, mode: "HOTSPOT", wan: "ether1",
  hotspotPorts: ["ether2"], hotspotIface: "b",
  hotspotSubnet: "10.0.0.0/24", hotspotRange: "10.0.0.10-10.0.0.99", hotspotDnsName: "d.net",
  pppoePorts: [], pppoePool: "", pppoeRanges: "", pppoeLocal: "",
  radiusServer: "1.1.1.1", radiusSecret: "x", nasShortname: "n",
  radiusAuthPort: 1812, radiusAcctPort: 1813, radiusCoaPort: 3799,
  pppoeService: "p", bridgeIface: "bl",
  heartbeatUrl: "https://x/y", heartbeatName: "h",
};

const cases = {
  "HOTSPOT": buildConfigureScript(base),
  "HOTSPOT+PPPOE": buildConfigureScript({ ...base, mode: "HOTSPOT_PPPOE", pppoePorts: ["ether3"], pppoePool: "pl", pppoeRanges: "100.64.0.2-100.64.0.9", pppoeLocal: "100.64.0.1" }),
  "v6": buildConfigureScript({ ...base, rosMajor: 6 }),
  "no-secret": buildConfigureScript({ ...base, radiusSecret: "" }),
  "wireguard": buildConfigureScript({ ...base, wireguard: { serverPublicKey: "K", routerTunnelIp: "10.200.0.2/32", serverTunnelIp: "10.200.0.1" } }),
  "bootstrap": buildBootstrapScript({ baseUrl: "https://x", token: "T".repeat(43), sessionId: "s" }),
};

let bad = 0;
for (const [name, script] of Object.entries(cases)) {
  let depth = 0;
  let brackets = 0;
  let lowest = 0;
  const trace = [];
  script.split("\n").forEach((line, i) => {
    // Strip a RouterOS comment and any quoted string, leaving only code, so a
    // brace inside a string is not counted as a block delimiter.
    const t = line.replace(/(^|\s)#.*$/, "").replace(/"[^"]*"/g, '""').trim();
    if (!t) return;
    const before = depth;
    for (const ch of t) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === "[") brackets++;
      else if (ch === "]") brackets--;
    }
    if (depth < lowest) lowest = depth;
    if (depth !== before) trace.push(`d=${depth} L${i + 1}: ${t.slice(0, 70)}`);
  });
  const ok = depth === 0 && lowest === 0 && brackets === 0;
  if (!ok) {
    bad++;
    console.log(`\n${name}: UNBALANCED braces=${depth} brackets=${brackets} lowest=${lowest}`);
    console.log(trace.slice(-8).map((t) => "    " + t).join("\n"));
  } else {
    console.log(`${name}: balanced`);
  }
}
console.log(bad ? `\n${bad} script(s) unbalanced` : "\nall balanced");
