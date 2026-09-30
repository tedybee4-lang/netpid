import { createServiceClient } from "@/lib/supabase/server";

// Platform audit log. Used by the Super Admin console only.
//
// SECURITY: `detail` is written by callers and returned to the console, so it
// must never contain a password, private key, encryption key or API token.
// Everything here takes structured, already-redacted values — there is no
// free-text "message" field that a caller could accidentally fill with a secret.
export type AuditAction =
  | "vps_created" | "vps_updated" | "vps_deleted" | "vps_credentials_changed"
  | "vps_connection_tested" | "vps_enabled" | "vps_disabled"
  | "vps_migration_started" | "vps_switched" | "vps_decommissioned"
  | "worker_action" | "wireguard_action" | "radius_action" | "firewall_action"
  | "admin_login" | "admin_logout";

export async function audit(entry: {
  action: AuditAction;
  actorUserId?: string | null;
  actorLabel?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  targetLabel?: string | null;
  outcome?: "ok" | "failed" | "denied";
  detail?: Record<string, unknown>;
  ipAddress?: string | null;
}): Promise<void> {
  // A failed audit write must not break the operation it was recording, so
  // errors are swallowed deliberately.
  try {
    const svc = createServiceClient();
    await svc.from("platform_audit_log").insert({
      action: entry.action,
      actor_user_id: entry.actorUserId ?? null,
      actor_label: entry.actorLabel ?? null,
      target_type: entry.targetType ?? null,
      target_id: entry.targetId ?? null,
      target_label: entry.targetLabel ?? null,
      outcome: entry.outcome ?? "ok",
      detail: entry.detail ?? {},
      ip_address: entry.ipAddress ?? null,
    });
  } catch {
    // Intentionally ignored — see above.
  }
}
