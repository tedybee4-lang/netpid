/**
 * Verify the heartbeat host decision under both environments.
 *
 * Two questions, answered against the REAL generator rather than by reading
 * source:
 *
 *   1. With NETPID_STABLE_HOSTS naming the production host, does the generated
 *      script bake in that host?
 *   2. Can a Vercel PREVIEW host ever become the permanent scheduler URL, even
 *      when the production host is listed?
 *
 * The host below is a PLACEHOLDER, not the real deployment. This file is
 * checked in, and a live hostname written into it goes stale the moment the
 * domain changes, then quietly keeps asserting the wrong thing. Point
 * NETPID_PROD_HOST at the real host to assert against production.
 *
 * Runs the library in child processes because the stable-host list is read from
 * the environment at module load, so it cannot be varied within one process.
 *
 * Run: node scripts/heartbeat-check.mjs
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// Absolute file URLs: the child runs with this process's cwd, so a relative
// specifier would resolve against the wrong directory.
const LIB = pathToFileURL(resolve("../apps/web/lib/mikrotik-provision.ts")).href;
const GEN = pathToFileURL(resolve("../apps/web/lib/mikrotik-provision-script.ts")).href;

const CHILD = `
const m = await import(${JSON.stringify(LIB)});
const s = await import(${JSON.stringify(GEN)});
const cb = m.stableCallbackBase();
const sc = s.buildConfigureScript({
  routerId: "r1", rosMajor: 7, mode: "HOTSPOT", wan: "ether1",
  hotspotPorts: ["ether2"], hotspotIface: "b",
  hotspotSubnet: "10.0.0.0/24", hotspotRange: "10.0.0.10-10.0.0.99",
  hotspotDnsName: "d", pppoePorts: [], pppoePool: "", pppoeRanges: "", pppoeLocal: "",
  radiusServer: "1.1.1.1", radiusSecret: "x", nasShortname: "n",
  radiusAuthPort: 1812, radiusAcctPort: 1813, radiusCoaPort: 3799,
  pppoeService: "p", bridgeIface: "bridge-lan",
  heartbeatUrl: cb.stable ? cb.base + "/api/provision/mikrotik/heartbeat/r1" : "",
  heartbeatName: "hb",
});
const url = /url=([^"]+)"/.exec(sc)?.[1] ?? null;
console.log(JSON.stringify({
  stable: cb.stable,
  base: cb.base,
  reason: cb.reason,
  schedulerUrl: url,
  hasPreviewHost: /projects\\.vercel\\.app/.test(sc),
  saysOmitted: /heartbeat: NOT installed/.test(sc),
}));
`;

function run(env) {
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", CHILD], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return JSON.parse(out.trim().split("\n").pop());
}

// A placeholder apex host, deliberately not the real deployment. Override with
// NETPID_PROD_HOST to assert against production.
const PROD = process.env.NETPID_PROD_HOST ?? "example.vercel.app";
const PREVIEW = "https://netpid-2b9dmps30-malariachrome-7756s-projects.vercel.app";
let failures = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}: ${JSON.stringify(actual)}`);
};

console.log(`\n  production host under test: ${PROD}`);

console.log("\n=== A. UNCONFIGURED (today's production) ===");
const bare = run({ VERCEL_URL: PROD, NETPID_STABLE_HOSTS: "" });
check("stable is false", bare.stable, false);
check("no scheduler URL is emitted", bare.schedulerUrl, null);
check("script states it was omitted", bare.saysOmitted, true);
check("no preview host anywhere", bare.hasPreviewHost, false);

console.log("\n=== B. CONFIGURED for production ===");
const prod = run({
  VERCEL_URL: PROD,
  NETPID_STABLE_HOSTS: PROD,
});
check("stable is true", prod.stable, true);
check("scheduler URL is the production host",
  prod.schedulerUrl, `https://${PROD}/api/provision/mikrotik/heartbeat/r1`);
check("no preview host in the script", prod.hasPreviewHost, false);

console.log("\n=== C. A PREVIEW DEPLOYMENT SERVES THE REQUEST ===");
// This is the real attack: the operator loads a preview build and provisions
// from it. The preview must not inherit the production heartbeat.
const preview = run({
  VERCEL_URL: PREVIEW,
  NETPID_STABLE_HOSTS: PROD,
});
check("preview is refused as stable", preview.stable, false);
check("no scheduler URL emitted from a preview", preview.schedulerUrl, null);
check("no preview host in the script", preview.hasPreviewHost, false);
console.log(`        reason: ${preview.reason.slice(0, 96)}...`);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
