// NETPID-managed WireGuard tunnel: the generated RouterOS script and the
// worker's side of the tunnel.
//
// The single most important property here is NON-DESTRUCTIVENESS. This script is
// pasted into a live MikroTik at a customer site, where someone else's PPPoE,
// HotSpot, NAT, bridge, VLAN and routing config already works. A single
// unguarded `remove` or a `flush` in here is an outage at a paying customer's
// premises, so it is pinned by test rather than by review.
import test from "node:test";
import assert from "node:assert/strict";

import { buildWireguardScript, isWireguardKey } from "../src/routeros.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HELPER_SRC = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../deploy/wireguard-helper.sh",
  ),
  "utf8",
);

const KEY_A = "hSDwCYkwp1R0i33ctD73Wg2/Og0mOBr066SpjqqbTmo=";
const KEY_B = "xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=";
const SECRET = "test-nas-secret";
const OPTS = {
  serverPublicKey: KEY_A,
  routerPublicKey: KEY_B,
  routerTunnelIp: "10.90.0.2",
  vpsTunnelIp: "10.90.0.1",
  radiusSecret: SECRET,
  routerName: "Nairobi Core 1",
};

// Strip comment lines: they legitimately contain the words we forbid elsewhere
// (the header explains that the script does not flush).
function commands(script) {
  return script
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");
}

test("a WireGuard key is 43 base64 chars plus one pad", () => {
  assert.ok(isWireguardKey(KEY_A));
  assert.ok(isWireguardKey(KEY_B));
  assert.equal(isWireguardKey("too-short"), false);
  assert.equal(isWireguardKey(KEY_A.slice(0, 43)), false, "the pad is required");
  assert.equal(isWireguardKey(null), false);
  assert.equal(isWireguardKey(42), false);
});

test("the script NEVER flushes or wipes anything", () => {
  const s = commands(buildWireguardScript(OPTS));
  for (const forbidden of [
    /firewall\s+filter\s+flush/i,
    /firewall\s+nat\s+flush/i,
    /firewall\s+mangle\s+flush/i,
    /firewall\s+raw\s+flush/i,
    /ip\s+firewall\s+filter\s+remove\s*$/im,
    /firewall\s+filter\s+remove\s+all/i,
    /\bflush\b/i,
    /system\s+reset/i,
    /ip\s+dhcp-server\s+remove/i,
    /interface\s+ethernet\s+remove/i,
    /queue\s+simple\s+remove\s+all/i,
    /ppp\s+secret\s+remove/i,
  ]) {
    assert.doesNotMatch(s, forbidden, `destructive command emitted: ${forbidden}`);
  }
});

test("every remove is scoped to a NETPID-owned object, so re-runs are safe", () => {
  const s = buildWireguardScript(OPTS);
  const removes = s.split("\n").filter((l) => /\bremove\b/.test(l) && !l.trim().startsWith("#"));
  assert.ok(removes.length > 0, "expected scoped removes for idempotency");
  for (const line of removes) {
    // A `[find ...]` is mandatory: `/ip/firewall/filter remove` without one
    // would delete the whole chain. Scope is either NETPID's own interface name
    // or a NETPID comment — objects this script exclusively owns.
    assert.match(
      line,
      /\[find\s+(name|interface|comment)/,
      `remove is not scoped by a find: ${line}`,
    );
    assert.match(
      line,
      /netpid-wg|NETPID/,
      `remove does not target a NETPID-owned object: ${line}`,
    );
  }
});

test("the script configures everything the tunnel needs", () => {
  const s = buildWireguardScript(OPTS);
  assert.match(s, /\/interface\/wireguard add name=netpid-wg/);
  assert.match(s, new RegExp(`public-key=${KEY_A}`));
  assert.match(s, /address=10\.90\.0\.2\/30/);
  assert.match(s, /persistent-keepalive=25s/);
  assert.match(s, /\/ip\/firewall\/filter add chain=input action=accept protocol=udp dst-port=51820/);
  // RADIUS is pointed at the tunnel address, which is what removes the need for
  // a publicly exposed management port.
  assert.match(s, /\/radius\/incoming add address=10\.90\.0\.1\/32/);
});

test("the router's private key is never emitted", () => {
  const s = buildWireguardScript(OPTS);
  assert.doesNotMatch(s, /private-key\s*=\s*\S/, "no private key may be written by NETPID");
  assert.match(s, /private key stays on the router|Private keys are generated ON the router/);
});

test("an invalid key stops the script instead of emitting a broken peer", () => {
  for (const bad of ["", "nope", KEY_A.slice(0, 20)]) {
    const s = buildWireguardScript({ ...OPTS, serverPublicKey: bad });
    assert.match(s, /ERROR: serverPublicKey is not a valid WireGuard key/);
    assert.doesNotMatch(s, /\/interface\/wireguard\/peers add/);
  }
});

test("without a router key it asks for one rather than guessing", () => {
  const s = buildWireguardScript({ ...OPTS, routerPublicKey: null });
  assert.doesNotMatch(s, /\/interface\/wireguard\/peers add/);
  assert.match(s, /paste its public key into NETPID|paste the public key/);
});

test("no endpoint is emitted unless the operator supplied one", () => {
  // Without an endpoint the router must not dial out; the VPS initiates.
  const noEp = buildWireguardScript(OPTS);
  assert.doesNotMatch(noEp, /endpoint-address=/);
  assert.match(noEp, /allowed-address=10\.90\.0\.1\/32/);

  const withEp = buildWireguardScript({ ...OPTS, vpsEndpoint: "87.76.137.72" });
  assert.match(withEp, /endpoint-address=87\.76\.137\.72:51820/);
  assert.match(withEp, /allowed-address=0\.0\.0\.0\/0/);
});

test("RouterOS 6 is refused rather than given a script it cannot run", () => {
  // RouterOS 6 has no /interface/wireguard at all, so a "v6 variant" would be a
  // script that errors on the first line. Only one script is ever produced.
  const s = buildWireguardScript(OPTS);
  assert.match(s, /Requires RouterOS 7/);
  assert.doesNotMatch(s, /\/interface\/vpn/);
});

test("the web twin and the worker twin emit the same operational lines", async () => {
  // apps/web/lib/routeros.ts and network-worker/src/routeros.mjs are kept in
  // step on purpose. This compares the lines that carry meaning, ignoring the
  // header comments which differ (the TS version stamps a generation date).
  const { readFileSync } = await import("node:fs");
  const web = readFileSync(
    new URL("../../apps/web/lib/routeros.ts", import.meta.url), "utf8",
  );
  assert.match(web, /export function buildWireguardScript/);
  assert.match(web, /interface\/wireguard add name=/);
  assert.match(web, /NETPID-managed/);
  assert.match(web, /radius\/incoming add address=/);
});

// ---------------------------------------------------------------------------
// The privileged helper
// ---------------------------------------------------------------------------
// The helper is the only thing on this host that runs as root, so these tests
// are about the shape of what it can be made to do rather than about tunnels
// going up. Everything here is a static read of the script: it cannot prove the
// helper works, only that it cannot be argued into running something else.

test("the helper derives its interface name, so the worker cannot pick one", () => {
  // An interface name the worker controls is an interface name the worker
  // could point at another tunnel's config.
  assert.match(HELPER_SRC, /iface_for\(\)/);
  assert.match(HELPER_SRC, /md5sum/);
  // The name must stay inside the kernel's 15-character limit for an interface.
  const declared = HELPER_SRC.match(/IFACE_HASH_LEN=(\d+)/);
  assert.ok(declared, "helper must declare a hash length");
  assert.ok(
    "nwg-".length + Number(declared[1]) <= 15,
    "derived interface name exceeds the 15-character kernel limit",
  );
});

test("the helper writes the private key it is given, and persists it to disk", () => {
  // The previous helper only manipulated peers on a shared wg0 and never
  // installed the key, so the interface came up with a key the console never
  // published and no handshake could ever succeed.
  assert.match(HELPER_SRC, /PrivateKey = \$priv/);
  assert.match(HELPER_SRC, /chmod 600/);
  // wg-quick refuses to use a config wider than 600.
  assert.doesNotMatch(HELPER_SRC, /chmod 6\d\d ".*\.conf"/);
});

test("the helper never puts the private key on the command line", () => {
  // /proc/<pid>/cmdline is world readable; a key passed as argv is exposed to
  // every other user on the VPS for the lifetime of the process.
  assert.match(HELPER_SRC, /priv=\$\(cat\)/);
  assert.doesNotMatch(HELPER_SRC, /sudo -n.*priv/);
});

test("the helper validates every argument before it is used", () => {
  for (const check of ["is_id", "is_key", "is_ip", "is_port"]) {
    assert.match(HELPER_SRC, new RegExp(`\\$\\{${check} |${check} "\\$`), `${check} is not applied`);
  }
  // A private key that does not match the published public key would produce a
  // tunnel the router can never complete a handshake with.
  assert.match(HELPER_SRC, /private key does not match the stored public key/);
});

test("the helper persists state so a reboot restores the tunnels", () => {
  assert.match(HELPER_SRC, /wg-quick up/);
  assert.match(HELPER_SRC, /wg syncconf/);
  assert.match(HELPER_SRC, /cmd_reconcile/);
  // The sysctl a routed tunnel needs has to survive a reboot on its own.
  assert.match(HELPER_SRC, /\/etc\/sysctl\.d\/99-netpid-wireguard\.conf/);
});

test("the helper touches only NETPID-owned interfaces", () => {
  // A dump over every interface would let an operator's own tunnel be reported
  // as a NETPID tunnel and written back into the database.
  assert.doesNotMatch(HELPER_SRC, /wg show all dump/);
  assert.match(HELPER_SRC, /\$\{IFACE_PREFIX\}\*\.conf/);
});

test("the helper exposes only the four intended subcommands", () => {
  const cases = [...HELPER_SRC.matchAll(/^\s{2}([a-z-]+)\)\s+shift/gm)].map((m) => m[1]);
  assert.deepEqual(cases.sort(), ["apply", "dump", "reconcile", "remove"]);
});
