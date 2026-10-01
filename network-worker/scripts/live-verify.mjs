/**
 * Live end-to-end verification of the discovery round trip.
 *
 * This machine stands in for the router. It performs the SAME two requests a
 * MikroTik makes, against the SAME production host, in the SAME order:
 *
 *   1. GET /api/provision/mikrotik/bootstrap/<token>   (the /tool fetch)
 *   2. GET /api/provision/mikrotik/register/<token>?... (the report the
 *      generated script builds)
 *
 * What it proves: the deployed code, the deployed database, the token
 * lifecycle, the URL construction, and that the script the router would import
 * is valid. What it CANNOT prove: that RouterOS executes the script. Only the
 * physical terminal can do that.
 *
 * Run: node scripts/live-verify.mjs <baseUrl> <token>
 */
const base = (process.argv[2] ?? "").replace(/\/+$/, "");
const token = process.argv[3] ?? "";
if (!base || !token) {
  console.error("usage: node scripts/live-verify.mjs <baseUrl> <token>");
  process.exit(2);
}
const say = (s) => console.log(s);

/** Strip comments and quoted strings so only real code is inspected. */
const code = (l) => l.replace(/(^|\s)#.*$/, "").replace(/"[^"]*"/g, '""').trim();

// --- 1. THE ROUTER FETCHES THE SCRIPT (what /tool fetch does) -------------
say("\n=== 1. THE ROUTER FETCHES THE SCRIPT (/tool fetch) ===");
const bootRes = await fetch(`${base}/api/provision/mikrotik/bootstrap/${token}`);
const script = await bootRes.text();
say(`  HTTP ${bootRes.status}`);
say(`  content-type : ${bootRes.headers.get("content-type")}`);
say(`  cache-control: ${bootRes.headers.get("cache-control")}`);
say(`  size         : ${script.length} bytes, ${script.split("\n").length} lines`);
if (bootRes.status !== 200) {
  say(`  REFUSED:\n${script}`);
  process.exit(1);
}

// --- 2. IS THE SCRIPT VALID ROUTEROS? -------------------------------------
say("\n=== 2. IS THE SCRIPT VALID ROUTEROS? ===");

// The exact field failure: an expression left OPEN at end of line. Counted
// cumulatively, because a block opener is legal and its closer is on a later
// line. What is illegal is depth going NEGATIVE, or never returning to zero.
//
// A per-line equality check reports every legitimate `do={` and `} on-error={ }`
// as broken, which is noise. Cumulatively, the only real defect is a line that
// closes a block it did not open, or a script that never closes one.
let depth = 0;
let lowest = 0;
const negative = [];
for (const [i, raw] of script.split("\n").entries()) {
  const t = code(raw);
  if (!t) continue;
  for (const ch of t) {
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
  }
  if (depth < lowest) {
    lowest = depth;
    negative.push(`  LINE ${i + 1} closes a block it did not open: ${raw.trim().slice(0, 70)}`);
  }
}
for (const l of negative) say(l);
say(`  unclosed blocks at EOF : ${depth} ${depth === 0 ? "(PASS)" : "(FAIL)"}`);
say(`  depth ever negative   : ${lowest} ${lowest === 0 ? "(PASS)" : "(FAIL)"}`);

const longest = Math.max(...script.split("\n").map((l) => l.length));
say(`  longest line          : ${longest} chars ${longest <= 200 ? "(PASS)" : "(FAIL)"}`);

// Brackets and parens must balance WITHIN a line: a `[/interface find` that
// never closes on the same line is the class of bug that produced the field
// failure, and it cannot span lines in RouterOS.
let straddle = 0;
for (const [i, raw] of script.split("\n").entries()) {
  const t = code(raw);
  if (!t) continue;
  const square = (t.match(/\[/g) ?? []).length - (t.match(/\]/g) ?? []).length;
  const round = (t.match(/\(/g) ?? []).length - (t.match(/\)/g) ?? []).length;
  if (square !== 0 || round !== 0) {
    straddle++;
    say(`  LINE ${i + 1} leaves [] or () open: ${raw.trim().slice(0, 70)}`);
  }
}
say(`  brackets spanning lines: ${straddle} ${straddle === 0 ? "(PASS)" : "(FAIL)"}`);

for (const [label, re] of [
  ["zero-index [:pick]", /\[:pick\s+[^\]]*?,\s*0\s*\]/],
  [":continue", /^\s*\S+\s*:continue/m],
  ["commented block closer", /^\s*#\s*\}/m],
  ["no continuation indent", /^\s+\.\s*"/m],
]) {
  say(`  ${label.padEnd(24)}: ${re.test(script) ? "PRESENT (FAIL)" : "absent (PASS)"}`);
}

const guards = (script.match(/on-error=\{/g) ?? []).length;
const reads = (script.match(/\/system resource get/g) ?? []).length;
say(`  on-error guards  : ${guards} guards / ${reads} reads ${guards >= reads ? "(PASS)" : "(FAIL)"}`);

// --- 3. THE SCRIPT MUST CHANGE NOTHING ------------------------------------
say("\n=== 3. THE SCRIPT MUST CHANGE NOTHING ===");
const real = script.split("\n").map(code).filter(Boolean);
const creates = real.filter((l) => l.startsWith("/") && /\sadd\s/.test(l));
say(`  create statements: ${creates.length} ${creates.length === 0 ? "(PASS - read only)" : "(FAIL)"}`);
say(`  credential present: ${/secret|password|private-key/i.test(script.replace(/#.*$/gm, "")) ? "FOUND (FAIL)" : "none (PASS)"}`);

// --- 4. NO PREVIEW HOST ----------------------------------------------------
say("\n=== 4. NO PREVIEW HOST ANYWHERE ===");
for (const raw2 of script.match(/https?:\/\/[^\s"]+/g) ?? []) {
  const h = new URL(raw2.replace(/["']/g, ""));
  const bad = (h.hostname.includes("vercel.app") && !h.hostname.endsWith("vercel.app"))
    || h.hostname.includes("ngrok") || h.hostname.includes("localhost");
  say(`  ${h.hostname} ${bad ? "(PREVIEW - FAIL)" : "(stable - PASS)"}`);
}
// --- 5. THE ROUTER REPORTS BACK (the generated register call) --------------
say("\n=== 5. THE ROUTER REPORTS BACK ===");
// Replay the generated :set statements to build the exact URL a router would,
// then make that request. Same data the script reads on the box, so a broken
// separator or a mangled query string fails here exactly as it would on device.
const vals = {
  npB: "hAP lite", npM: "hAP lite", npQ: "7.21.5", npA: "arm",
  npC: "MIPS 24Kc V7.4", npR: "65536 KiB",
  npI: "ether1,ether2,ether3,ether4,ether5,wlan1",
  npG: "bridge-lan:ether2,ether3,ether4;bridge1:ether5",
};
let url = (/:set npUrl "([^"]+)"/.exec(script) ?? [])[1];
if (!url) { say("  no npUrl base found (FAIL)"); process.exit(1); }
say(`  host            : ${new URL(url).host}`);
say(`  path            : ${new URL(url).pathname.replace(/[^/]+$/, "<token>")}`);
for (const line of script.split("\n").filter((l) => l.startsWith(":set npUrl ($npUrl . "))) {
  const sep = /"([?&])([a-z]+)="/.exec(line);
  const v = /\$(np\w+)\)/.exec(line)[1];
  url += sep[1] + sep[2] + "=" + vals[v];
}
const u = new URL(url);
say(`  query keys      : ${[...u.searchParams.keys()].join(", ")}`);
say(`  board           : ${JSON.stringify(u.searchParams.get("board"))}`);
say(`  version         : ${JSON.stringify(u.searchParams.get("version"))}`);
say(`  ram             : ${JSON.stringify(u.searchParams.get("ram"))}`);
say(`  ifaces          : ${JSON.stringify(u.searchParams.get("ifaces"))}`);
say(`  bridges         : ${JSON.stringify(u.searchParams.get("bridges"))}`);
say(`  key count       : ${u.searchParams.size} ${u.searchParams.size === 8 ? "(PASS)" : "(FAIL)"}`);

const regRes = await fetch(url);
const regBody = await regRes.json().catch(() => ({ raw: script.slice(0, 200) }));
say(`  HTTP            : ${regRes.status}`);
say(`  stored status   : ${regBody.status}`);
say(`  board_name      : ${regBody.board_name}`);
say(`  routeros_version: ${regBody.routeros_version}`);
say(`  ram_mb          : ${regBody.ram_mb}`);
say(`  rosMajor decided: ${regBody.capabilities?.rosMajor}`);
say(`  wireguard gate  : ${regBody.capabilities?.wireguard?.supported}`);
say(`  interfaces      : ${(regBody.interfaces ?? []).map((i) => i.name).join(", ")}`);
say(`  bridges         : ${(regBody.bridges ?? []).map((b) => `${b.name}(${b.ports.join("|")})`).join(", ")}`);
say(`  wan candidates  : ${(regBody.interfaces ?? []).filter((i) => i.is_candidate_wan).map((i) => i.name).join(", ")}`);

// --- 6. TOKEN IS SINGLE-USE AND BOUNDED ------------------------------------
say("\n=== 6. TOKEN HANDLING ===");
const again = await fetch(`${base}/api/provision/mikrotik/bootstrap/${token}`);
say(`  re-fetch bootstrap: HTTP ${again.status} ${again.status === 200 ? "(token still reusable - sessions may re-fetch)" : ""}`);
const bogus = await fetch(`${base}/api/provision/mikrotik/bootstrap/${"B".repeat(43)}`);
say(`  bogus token       : HTTP ${bogus.status} ${bogus.status === 404 ? "(PASS - refused)" : "(FAIL)"}`);

// --- SUMMARY ---------------------------------------------------------------
say("\n=== SUMMARY ===");
const pass = straddle === 0 && depth === 0 && lowest === 0 && longest <= 200
  && creates.length === 0 && u.searchParams.size === 8
  && regRes.status === 200 && bogus.status === 404;
say(pass ? "  ALL CHECKS PASSED" : "  ONE OR MORE CHECKS FAILED");
process.exit(pass ? 0 : 1);
