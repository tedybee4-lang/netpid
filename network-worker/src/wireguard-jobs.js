// WireGuard tunnel management, executed on the VPS by the network worker.
//
// PRIVILEGE MODEL
// ---------------
// `wg` and `wg-quick` need root, but the worker deliberately runs as the
// unprivileged `netpid` user. Rather than granting the worker CAP_NET_ADMIN,
// every privileged action goes through ONE fixed helper installed by
// deploy/wireguard-helper.sh and allowed via a scoped NOPASSWD sudo rule:
// netpid may run that single script and nothing else. The script takes a tunnel
// id and a subcommand — never a shell string from the database — so a
// compromised database row cannot become arbitrary root command execution.
//
// The private key is decrypted here, written to a 0600 file, used, and the file
// is removed. It is never written to a log, a job result, or the database in
// clear.
import { execFile } from "child_process";
import { decryptSecret } from "./secrets.js";

const HELPER = "/usr/local/sbin/netpid-wg";
const HELPER_TIMEOUT_MS = 30_000;

function helper(args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "sudo",
      ["-n", HELPER, ...args],
      { timeout: HELPER_TIMEOUT_MS, maxBuffer: 1 << 20 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(String(stderr || err.message).trim()));
        resolve(String(stdout || ""));
      },
    );
    // The key is written to the helper's stdin, never to its command line,
    // because /proc/<pid>/cmdline is readable by every user on the host.
    // EPIPE is expected and ignored: a helper that rejects its arguments
    // before reading stdin closes the pipe, and that is not an error here.
    child.stdin?.on("error", () => {});
    child.stdin?.end(input ?? "");
  });
}

async function tunnel(sb, job) {
  const tunnelId = job.payload?.tunnel_id;
  if (!tunnelId) throw new Error("wireguard-tunnel-sync without tunnel_id");
  const { data, error } = await sb
    .from("router_tunnels").select("*").eq("id", tunnelId).maybeSingle();
  if (error) throw new Error(`tunnel lookup failed: ${error.message}`);
  if (!data) throw new Error(`tunnel ${tunnelId} not found`);
  return data;
}

/**
 * Install, update or remove one tunnel. The helper owns the interface, the
 * wg-quick invocation and the key file; this function only decides WHICH
 * operation runs and decrypts the key into the helper's stdin.
 */
export async function wireguardTunnelSync(sb, job) {
  const t = await tunnel(sb, job);
  const action = job.payload?.action ?? "peer";

  if (action === "revoke") {
    const out = await helper(["remove", String(t.id)]);
    await sb.from("router_tunnels").update({ last_checked_at: new Date().toISOString() }).eq("id", t.id);
    return { ok: true, action, detail: out.trim() || "tunnel removed" };
  }

  // create/rotate/peer all end in "make this tunnel live on the VPS". The
  // helper gives each tunnel its own interface, named from the tunnel id, so
  // two routers can never share a key or an address.
  const rotate = action === "rotate";
  if (!t.server_public_key || !t.server_private_key_encrypted) {
    throw new Error(`tunnel ${t.id} has no server key pair to install`);
  }
  let priv;
  try {
    priv = decryptSecret(t.server_private_key_encrypted);
  } catch (e) {
    // A key that will not decrypt is an operator problem, not something to
    // retry: the encrypted column is the only copy of this key.
    throw new Error(`tunnel ${t.id}: server private key could not be decrypted (${e.message})`);
  }

  const out = await helper(
    [
      "apply",
      String(t.id),
      "-",                                   // private key arrives on stdin
      t.server_public_key,
      t.router_public_key || "-",
      t.router_tunnel_ip || "0.0.0.0",
      t.vps_tunnel_ip,
      t.listen_port ? String(t.listen_port) : "51820",
      rotate ? "rotate" : "keep",
    ],
    `${priv}\n`,
  );
  // Drop the plaintext as soon as the helper has it. V8 strings are immutable,
  // so this cannot scrub the buffer, but it releases the reference before the
  // job result (which is logged) is built.
  priv = null;

  await sb.from("router_tunnels").update({
    last_checked_at: new Date().toISOString(),
    // Only a tunnel with BOTH keys can be "provisioned"; with a public key on
    // each side the state is accurate rather than optimistic.
    status: t.router_public_key ? "provisioned" : "pending",
  }).eq("id", t.id);

  return { ok: true, action, detail: out.trim() || "applied" };
}

/**
 * A tunnel that has handshook but gone quiet for longer than this is reported
 * as unreachable. Two keepalive intervals plus slack: a tunnel that missed a
 * few probes is a blip, not a fault, and flipping the status on one missed
 * handshake would make the console flap.
 */
const STALE_HANDSHAKE_MS = 5 * 60 * 1000;

/**
 * Refresh handshake state for every tunnel this VPS owns. Run on a schedule.
 *
 * Reports rather than asserts: a missing handshake is a fact the console shows,
 * not an error that should fail a job and burn retries.
 */
export async function wireguardSweep(sb) {
  // A reboot drops every interface even though the configs are persisted, so
  // restore them before reading state — otherwise every tunnel would look dead
  // for as long as the VPS has been up.
  try {
    await helper(["reconcile"]);
  } catch (e) {
    // Reconciliation failing is worth reporting but not worth abandoning: the
    // dump below is still the truth about whatever interfaces do exist.
    console.warn(`wireguard reconcile failed: ${e.message ?? e}`);
  }

  let raw = "";
  try {
    raw = await helper(["dump"]);
  } catch (e) {
    return { ok: false, error: String(e.message ?? e), tunnels: 0 };
  }
  // `wg show dump`: an interface line (public-key \t private-key \t listen-port)
  // then one line per peer: public-key \t preshared \t endpoint \t allowed-ips
  // \t latest-handshake \t rx \t tx \t keepalive
  const lines = raw.trim().split("\n").filter(Boolean);
  if (!lines.length) return { ok: true, tunnels: 0, peers: 0 };

  const peers = new Map();
  // Interfaces merge into one stream, so the interface/peer distinction is by
  // field count: an interface line has 3 fields, a peer line has 8.
  for (const line of lines) {
    const f = line.split("\t");
    if (f.length < 8) continue;
    peers.set(f[0], {
      endpoint: f[2] === "(none)" ? null : f[2],
      lastHandshake: Number(f[4] || 0),
      rx: Number(f[5] || 0),
      tx: Number(f[6] || 0),
    });
  }

  const { data: rows } = await sb
    .from("router_tunnels")
    .select("id,router_public_key,status")
    .neq("status", "revoked");
  const now = Date.now();
  let updated = 0;
  let stale = 0;
  for (const t of rows ?? []) {
    const p = t.router_public_key ? peers.get(t.router_public_key) : undefined;
    // wg reports 0 when there has never been a handshake.
    const hs = p?.lastHandshake ? new Date(p.lastHandshake * 1000).toISOString() : null;
    const quiet = !hs || now - p.lastHandshake * 1000 > STALE_HANDSHAKE_MS;
    await sb.from("router_tunnels").update({
      last_handshake_at: hs,
      last_endpoint: p?.endpoint ?? null,
      last_rx_bytes: p?.rx ?? null,
      last_tx_bytes: p?.tx ?? null,
      last_checked_at: new Date().toISOString(),
      // "connected" -> "unreachable" only. A tunnel that has never handshook
      // stays pending, because it is not a fault yet.
      status: hs && !quiet ? "connected" : t.status === "connected" ? "unreachable" : t.status,
    }).eq("id", t.id);
    if (hs && quiet) stale++;
    if (p) updated++;
  }
  return { ok: true, tunnels: (rows ?? []).length, peers_matched: updated, stale_handshakes: stale };
}
