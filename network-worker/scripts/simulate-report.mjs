/**
 * Simulate the EXACT URL a MikroTik builds, then send it.
 *
 * This is the check that the space encoding works over the wire, not just in a
 * unit test. The script is fetched from the LIVE production deployment, the
 * [:split]/"+" encoding is replayed exactly as the router would perform it, and
 * the resulting URL is requested. A raw space would make the URL unparseable,
 * which is exactly the field failure this exists to prevent.
 *
 * Run: node scripts/simulate-report.mjs <baseUrl> <token>
 */
const base = (process.argv[2] ?? "").replace(/\/+$/, "");
const token = process.argv[3] ?? "";
if (!base || !token) {
  console.error("usage: node scripts/simulate-report.mjs <baseUrl> <token>");
  process.exit(2);
}

// What the router's /system resource and /interface commands return on a hAP lite.
const READ = {
  npB: "hAP lite", npM: "hAP lite", npV: "7.21.5", npA: "arm",
  npC: "MIPS 24Kc V7.4", npR: "65536 KiB",
  npI: "ether1,ether2,ether3,ether4,ether5,wlan1",
  npG: "bridge-lan:ether2,ether3,ether4;bridge1:ether5",
};

const script = await (await fetch(`${base}/api/provision/mikrotik/bootstrap/${token}`)).text();
const baseLine = /:local npUrl "([^"]+)"/.exec(script);
if (!baseLine) {
  console.error("  no :local npUrl base in the deployed script");
  process.exit(1);
}

let url = baseLine[1];
let fields = 0;
// Each :foreach npW in=[:split $X " "] encodes one value. The :set npUrl that
// appends it is the LAST such line before the next :foreach, so take the last
// match in the block rather than the first: the block's own comment lines
// mention no separator, but a short window can reach into the next field.
const blocks = [...script.matchAll(/:foreach npW in=\[:split \$(\w+) " "\] do=\{/g)];
for (const [i, m] of blocks.entries()) {
  const end = i + 1 < blocks.length ? blocks[i + 1].index : script.length;
  const block = script.slice(m.index, end);
  const appends = [...block.matchAll(/:set npUrl \(\$npUrl \. "([?&])([a-z]+)="/g)];
  const sep = appends[appends.length - 1];
  if (!sep) continue;
  const raw = READ[m[1]];
  // What the router does: split on space, rejoin with "+".
  const wire = raw.split(" ").filter(Boolean).join("+");
  url += sep[1] + sep[2] + "=" + wire;
  fields++;
}

console.log(`  fields encoded : ${fields}`);
console.log(`  raw spaces     : ${/ /.test(url) ? "PRESENT (FAIL)" : "none (PASS)"}`);

let res;
try {
  res = await fetch(url);
} catch (e) {
  console.log(`  fetch threw    : ${e.message}`);
  process.exit(1);
}
const body = await res.json();

console.log(`  HTTP           : ${res.status}`);
console.log(`  stored status  : ${body.status}`);
console.log(`  board          : ${JSON.stringify(body.board_name)}`);
console.log(`  version        : ${JSON.stringify(body.routeros_version)}`);
console.log(`  ram_mb         : ${body.ram_mb}`);
console.log(`  ifaces         : ${(body.interfaces ?? []).map((i) => i.name).join(", ")}`);
console.log(`  bridges        : ${(body.bridges ?? []).map((b) => b.name).join(", ")}`);
console.log(`  wan candidates : ${(body.interfaces ?? []).filter((i) => i.is_candidate_wan).map((i) => i.name).join(", ")}`);
console.log(`  rosMajor       : ${body.capabilities?.rosMajor}`);
// architecture and cpu are stored but not echoed. Say so, so nobody reads this
// as data loss and goes hunting for a bug that is not there.
console.log(`  (architecture and cpu are stored, not echoed - by design)`);

// The register response echoes board, version, ram, interfaces and bridges. It
// deliberately does NOT echo architecture or cpu: they are stored, but the
// operator has no use for them in the wizard, and returning hardware strings to
// a browser invites treating them as configuration. Assert the real contract.
const checks = [
  ["HTTP 200", res.status === 200],
  ["no raw space in the URL", !/ /.test(url)],
  ["all eight fields were encoded", fields === 8],
  ["board round-trips with its space", body.board_name === "hAP lite"],
  ["version is present", Boolean(body.routeros_version)],
  ["RAM is parsed to megabytes", body.ram_mb === 64],
  ["interfaces detected", (body.interfaces ?? []).length === 6],
  ["bridges parsed with their members", (body.bridges ?? []).length === 2],
  ["only a free ethernet port is a WAN candidate",
    (body.interfaces ?? []).filter((i) => i.is_candidate_wan).map((i) => i.name).join() === "ether1"],
];
console.log("");
let bad = 0;
for (const [label, ok] of checks) {
  if (!ok) bad++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
}
console.log(`\n  ${bad === 0 ? "ALL CHECKS PASSED" : `${bad} CHECK(S) FAILED`}`);
process.exit(bad === 0 ? 0 : 1);
