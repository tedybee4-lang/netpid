// Diagnostic: report where the generated script's brace depth goes wrong.
import { writeFileSync } from "node:fs";
import { buildRouterosInstaller } from "../src/installer.mjs";
const S = buildRouterosInstaller({
  identity: "T", lanSubnet: "192.168.88.0/24", lanGateway: "192.168.88.1",
  dhcpPool: "p", hotspotSubnet: "10.5.50.0/24", hotspotPool: "h",
  hotspotDnsName: "d", pppoePool: "pp", radiusServer: "9.9.9.9",
  nasShortname: "n", radiusSecret: "s",
  wgServerPublicKey: "iHtSz+Y0QLqLS+KxUqoTUn45AvMEvUe9NXGMAcK6QmY=",
  wgRouterTunnelIp: "10.90.0.2", wgServerTunnelIp: "10.90.0.1",
}, { strict: false });
let depth = 0;
const out = [];
const L = S.split("\n");
L.forEach((raw, i) => {
  const l = raw.trim();
  if (!l || l.startsWith("#")) return;
  for (const ch of l) { if (ch === "{") depth++; if (ch === "}") depth--; }
  if (depth < 0) out.push(`L${i + 1} depth went NEGATIVE: ${l.slice(0, 70)}`);
});
// Single pass: record the depth in force when each section starts.
const marks = [];
let d = 0, last = 0;
L.forEach((raw, i) => {
  const l = raw.trim();
  if (!l) return;
  if (l.startsWith("#")) {
    if (/^# SECTION [A-L] -/.test(l)) {
      marks.push(`L${i + 1}: depth-on-entry=${d}  ${l.slice(0, 46)}`);
    }
    return;
  }
  for (const ch of l) { if (ch === "{") d++; if (ch === "}") d--; }
  if (d > 0) last = i;
});
out.push(`final depth ${d}; last line with depth>0 is L${last + 1}`);
out.push("--- depth on entry to each section (must be 0) ---");
out.push(...marks);
out.push("--- window around the last unclosed line ---");
for (let i = Math.max(0, last - 14); i <= last + 1; i++) {
  out.push(`L${i + 1}: ${(L[i] ?? "").slice(0, 92)}`);
}
writeFileSync(process.env.TEMP + "/depth.txt", out.join("\n"));
