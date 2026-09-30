import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin, getServer } from "@/lib/vps";
import { audit, type AuditAction } from "@/lib/platform-audit";
import { z } from "zod";

export const dynamic = "force-dynamic";

// POST /api/admin/vps/[id]/migrate — VPS replacement lifecycle.
//
//   switch       promote a verified standby to the single active primary.
//                The old active box is kept as standby (NOT deleted).
//   standby      mark a box standby (stops being the active target).
//   decommission retire a box: disabled, inactive, kept for history.
//
// No customer/tenant rows are touched: routers, NAS and RADIUS data live in
// Supabase keyed by ISP, not by VPS, so switching the active box never
// requires changing every customer's account.
const schema = z.object({
  action: z.enum(["switch", "standby", "decommission"]),
  notes: z.string().max(2000).optional().or(z.literal("")),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await requireAdmin();
  if ("error" in denied) return denied.error;
  const { id } = await params;

  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }
  const svc = createServiceClient();
  const row = await getServer(id);
  if (!row) return NextResponse.json({ error: "Server not found" }, { status: 404 });

  if (parsed.data.action === "switch") {
    // Gated on a verified replacement: enabled, credentialed, and recently
    // heartbeated. Promoting an unverified box would be an outage by button.
    if (!row.enabled) {
      return NextResponse.json({ error: "Enable the replacement and verify its heartbeat first" }, { status: 400 });
    }
    const { data: cred } = await svc.from("vps_servers")
      .select("credential_encrypted").eq("id", id).maybeSingle();
    if (!(cred as { credential_encrypted: string | null } | null)?.credential_encrypted) {
      return NextResponse.json({ error: "Add a credential to the replacement first" }, { status: 400 });
    }
    const age = row.last_heartbeat_at
      ? Date.now() - new Date(row.last_heartbeat_at).getTime()
      : Infinity;
    if (!Number.isFinite(age) || age > 10 * 60_000) {
      return NextResponse.json({
        error: "The replacement has no recent heartbeat (10 min). Verify heartbeat, WireGuard, RADIUS, PPPoE and HotSpot before switching.",
      }, { status: 400 });
    }
    const { data: current } = await svc.from("vps_servers")
      .select("id,name").eq("active", true).neq("id", id).limit(10);
    for (const old of current ?? []) {
      await svc.from("vps_servers").update({
        active: false, role: "standby",
        migration_status: "superseded",
        migration_notes: `Superseded by ${row.name} at ${new Date().toISOString()}`,
      }).eq("id", (old as { id: string }).id);
    }
    await svc.from("vps_servers").update({
      active: true, role: "primary", migration_status: "active",
      migration_notes: parsed.data.notes || null,
    }).eq("id", id);
    await audit({
      action: "vps_switched" as AuditAction,
      targetType: "vps_server", targetId: id, targetLabel: row.name,
      detail: { superseded: (current ?? []).map((c) => (c as { name: string }).name) },
    });
    return NextResponse.json({
      ok: true,
      message: `${row.name} is now the active VPS. ${(current ?? []).length} old box(es) kept as standby — decommission them only after verifying traffic.`,
    });
  }

  if (parsed.data.action === "standby") {
    await svc.from("vps_servers").update({
      active: false, role: "standby", migration_status: "standby",
      migration_notes: parsed.data.notes || null,
    }).eq("id", id);
    await audit({
      action: "vps_migration_started" as AuditAction,
      targetType: "vps_server", targetId: id, targetLabel: row.name,
    });
    return NextResponse.json({ ok: true, message: `${row.name} marked standby.` });
  }

  await svc.from("vps_servers").update({
    enabled: false, active: false, role: "retired", status: "disabled",
    migration_status: "decommissioned",
    migration_notes: parsed.data.notes || `Decommissioned ${new Date().toISOString()}`,
    decommissioned_at: new Date().toISOString(),
  }).eq("id", id);
  await audit({
    action: "vps_decommissioned" as AuditAction,
    targetType: "vps_server", targetId: id, targetLabel: row.name,
  });
  return NextResponse.json({ ok: true, message: `${row.name} decommissioned (kept for history).` });
}
