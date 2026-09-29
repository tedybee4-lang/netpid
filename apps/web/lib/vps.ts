import crypto from "crypto";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { encryptSecret, decryptSecret } from "@/lib/secrets";
import { isAdmin } from "@/lib/admin-auth";
import { audit, type AuditAction } from "@/lib/platform-audit";

// Platform server inventory. Every entry point calls requireAdmin() first —
// RLS alone is not enough because these routes use the service-role client,
// which bypasses RLS by design.

export const ipSchema = z.string().regex(
  /^\d{1,3}(\.\d{1,3}){3}$|^[0-9a-fA-F:]{3,45}$/,
  "Enter a valid IPv4 or IPv6 address",
);

export const serverSchema = z.object({
  name: z.string().min(2).max(80),
  provider: z.string().min(1).max(40).default("other"),
  region: z.string().max(60).optional().or(z.literal("")),
  hostname: z.string().max(255).optional().or(z.literal("")),
  ip_address: ipSchema,
  ipv6_address: z.union([ipSchema, z.literal("")]).optional(),
  ssh_port: z.coerce.number().int().min(1).max(65535).default(22),
  ssh_username: z.string().min(1).max(64),
  auth_method: z.enum(["password", "key"]).default("password"),
  isp_id: z.string().uuid().optional().or(z.literal("")),
  notes: z.string().max(2000).optional().or(z.literal("")),
  enabled: z.boolean().default(true),
});

export const credentialSchema = z.object({
  auth_method: z.enum(["password", "key"]),
  // A password, or a PEM private key. Either way it is encrypted before it is
  // stored and is never returned by any read path.
  secret: z.string().min(1).max(8000),
  expires_at: z.string().datetime().optional().or(z.literal("")),
});

export type ServerRow = {
  id: string; isp_id: string | null; name: string; provider: string;
  region: string | null; hostname: string | null; ip_address: string;
  ipv6_address: string | null; ssh_port: number; ssh_username: string;
  auth_method: string; credential_status: string;
  credential_expires_at: string | null; credential_updated_at: string | null;
  enabled: boolean; status: string; worker_status: string;
  radius_status: string; wireguard_status: string; firewall_status: string;
  os_name: string | null; os_version: string | null; kernel: string | null;
  cpu_percent: number | null; mem_percent: number | null; mem_total_mb: number | null;
  disk_percent: number | null; disk_total_gb: number | null;
  uptime_seconds: number | null; load_avg_1: string | null;
  last_heartbeat_at: string | null; last_health_check_at: string | null;
  last_health_error: string | null; notes: string | null;
  created_at: string; updated_at: string;
};

/** 401 for a signed-out caller, 403 for a signed-in non-admin. */
export async function requireAdmin(): Promise<{ ok: true } | { error: Response }> {
  if (!(await isAdmin())) {
    return {
      error: new Response(
        JSON.stringify({ error: "Super Admin access required" }),
        { status: 403, headers: { "content-type": "application/json" } },
      ),
    };
  }
  return { ok: true };
}

/** Strip anything sensitive before a server row goes anywhere near a response. */
export function publicServer(row: ServerRow) {
  const { credential_updated_by: _omit, ...rest } = row as ServerRow & { credential_updated_by?: string };
  void _omit;
  return { ...rest, has_credential: row.credential_status !== "missing" };
}

/**
 * Credential status is derived, not stored-and-forgotten. An expiry date in the
 * past has to read as EXPIRED even if nobody has run a job to flip it.
 */
export function deriveCredentialStatus(
  current: string,
  expiresAt: string | null,
): "missing" | "active" | "expiring" | "expired" {
  if (current === "missing") return "missing";
  if (!expiresAt) return "active";
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return "expired";
  if (ms <= 14 * 864e5) return "expiring"; // inside two weeks
  return "active";
}

/**
 * ONLINE / DELAYED / OFFLINE from heartbeat age.
 *
 * A heartbeat older than DELAYED_AFTER is DELAYED, not OFFLINE: the worker may
 * be mid-restart. Only past OFFLINE_AFTER do we call it down, because a single
 * missed 45-second beat is not an outage.
 */
export const DELAYED_AFTER_MS = 120_000;   // 2 minutes
export const OFFLINE_AFTER_MS = 300_000;  // 5 minutes

export function deriveStatus(
  enabled: boolean,
  lastHeartbeatAt: string | null,
  now = Date.now(),
): "online" | "delayed" | "offline" | "disabled" | "unknown" {
  if (!enabled) return "disabled";
  if (!lastHeartbeatAt) return "unknown";
  const age = now - new Date(lastHeartbeatAt).getTime();
  if (age <= DELAYED_AFTER_MS) return "online";
  if (age <= OFFLINE_AFTER_MS) return "delayed";
  return "offline";
}

export async function getServer(id: string): Promise<ServerRow | null> {
  const svc = createServiceClient();
  const { data } = await svc.from("vps_servers").select("*").eq("id", id).maybeSingle();
  return (data as ServerRow | null) ?? null;
}

/** Decrypts the stored credential. Only ever called by the connection tester. */
export async function readCredential(row: ServerRow): Promise<string | null> {
  const { data } = await createServiceClient()
    .from("vps_servers").select("credential_encrypted").eq("id", row.id).maybeSingle();
  const envelope = (data as { credential_encrypted: string | null } | null)?.credential_encrypted;
  if (!envelope) return null;
  // A key rotation orphans every existing envelope. That is reported as an
  // explicit "needs re-entry" state rather than surfaced as a crypto error, so
  // the operator knows to re-enter the credential.
  try {
    return decryptSecret(envelope);
  } catch {
    return null;
  }
}
