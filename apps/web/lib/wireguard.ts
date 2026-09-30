import crypto from "crypto";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { encryptSecret, decryptSecret } from "@/lib/secrets";

// NETPID-managed WireGuard tunnels: one per router, keys generated server-side.
//
// SECURITY MODEL
//   * A private key is GENERATED HERE and never travels to the browser. The API
//     returns the PUBLIC key and a ready-to-paste RouterOS script; the private
//     key goes to the VPS worker over the authenticated heartbeat channel and
//     nowhere else.
//   * The private key is encrypted at rest with APP_ENCRYPTION_KEY, byte-
//     compatible with every other NETPID credential, so rotation is a single
//     env change.
//   * No read path may return server_private_key_encrypted. `publicView()` is the
//     only shape that leaves the server, and it does not contain the column.

export const b64Key = z
  .string()
  .regex(/^[A-Za-z0-9+/]{43}=$/, "Expected a base64 WireGuard key");

export type TunnelRow = {
  id: string;
  isp_id: string;
  router_id: string;
  tunnel_subnet: string;
  vps_tunnel_ip: string;
  router_tunnel_ip: string;
  server_public_key: string;
  server_private_key_encrypted: string;
  router_public_key: string | null;
  listen_port: number;
  status: string;
  last_handshake_at: string | null;
  last_endpoint: string | null;
  last_rx_bytes: number | null;
  last_tx_bytes: number | null;
  last_checked_at: string | null;
  notes: string | null;
};

// PKCS#8 wrapper for a raw 32-byte X25519 private key. ASN.1 prefix for
// `SEQUENCE { INTEGER 0, SEQUENCE { OID 1.3.101.110 }, OCTET STRING }`.
const PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");

/**
 * Derive the X25519 public key from a raw private key.
 *
 * node:crypto has no "clamp a Curve25519 scalar" primitive, but it does have
 * X25519 as a key type, so the public half is obtained by wrapping the scalar
 * in PKCS#8 and letting createPublicKey do the scalar multiplication. Verified
 * against the RFC 7748 §6.1 test vector.
 */
function publicFromPrivate(rawPrivate: Buffer): string {
  const priv = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_X25519, rawPrivate]),
    format: "der",
    type: "pkcs8",
  });
  // An SPKI for X25519 is a 12-byte prefix plus the 32-byte public key.
  const spki = crypto.createPublicKey(priv).export({ format: "der", type: "spki" });
  return Buffer.from(spki).subarray(-32).toString("base64");
}

/**
 * A fresh X25519 key pair, byte-identical in format to `wg genkey`, so the same
 * key works on the VPS without conversion. The clamping bits are applied here
 * rather than left to wg: a key stored in the database must already be canonical
 * or a restore on another host would produce a different public key.
 */
export function generateKeyPair(): { publicKey: string; privateKey: string } {
  const raw = crypto.randomBytes(32);
  raw[0] &= 248;
  raw[31] &= 127;
  raw[31] |= 64;
  return { publicKey: publicFromPrivate(raw), privateKey: raw.toString("base64") };
}

export function isValidKey(v: unknown): boolean {
  return typeof v === "string" && /^[A-Za-z0-9+/]{43}=$/.test(v);
}

/**
 * The only shape of a tunnel that may cross the network. The encrypted private
 * key is deliberately absent — not renamed, absent — so a future edit that
 * spreads the row cannot leak it by accident.
 */
export function publicView(t: TunnelRow) {
  return {
    id: t.id,
    router_id: t.router_id,
    isp_id: t.isp_id,
    tunnel_subnet: t.tunnel_subnet,
    vps_tunnel_ip: t.vps_tunnel_ip,
    router_tunnel_ip: t.router_tunnel_ip,
    server_public_key: t.server_public_key,
    router_public_key: t.router_public_key,
    listen_port: t.listen_port,
    status: t.status,
    last_handshake_at: t.last_handshake_at,
    last_endpoint: t.last_endpoint,
    last_rx_bytes: t.last_rx_bytes,
    last_tx_bytes: t.last_tx_bytes,
    last_checked_at: t.last_checked_at,
    notes: t.notes,
    /** A tunnel is only useful once the router's public key is registered. */
    needs_router_key: !t.router_public_key,
  };
}

export function encryptTunnelKey(privateKey: string): string {
  return encryptSecret(privateKey);
}

/**
 * The next free /30 in 10.90.0.0/16. A /30 is the smallest useful point-to-point
 * subnet; anything larger widens the tunnel's reach for no benefit.
 */
export async function allocateTunnelSubnet(): Promise<{
  subnet: string;
  vpsIp: string;
  routerIp: string;
}> {
  const svc = createServiceClient();
  const { data, error } = await svc.from("router_tunnels").select("tunnel_subnet");
  if (error) throw new Error(error.message);

  const taken = new Set((data ?? []).map((r) => r.tunnel_subnet as string));
  for (let n = 0; n < 16384; n++) {
    // 10.90.<hi>.<lo 0/2/4/.../252>
    const third = Math.floor(n / 64);
    const fourth = (n % 64) * 4;
    const subnet = `10.90.${third}.${fourth}/30`;
    if (taken.has(subnet)) continue;
    return {
      subnet,
      vpsIp: `10.90.${third}.${fourth + 1}`,
      routerIp: `10.90.${third}.${fourth + 2}`,
    };
  }
  throw new Error("no free WireGuard subnet available");
}

/** Never call this outside the worker/API path that needs the raw key. */
export function readTunnelKey(row: TunnelRow): string {
  return decryptSecret(row.server_private_key_encrypted);
}
