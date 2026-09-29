import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin, getServer, publicServer, type ServerRow } from "@/lib/vps";
import { encryptSecret } from "@/lib/secrets";
import { audit } from "@/lib/platform-audit";
import { z } from "zod";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  provider: z.string().min(1).max(40).optional(),
  region: z.string().max(60).nullable().optional(),
  hostname: z.string().max(255).nullable().optional(),
  ip_address: z.string().max(45).optional(),
  ipv6_address: z.string().max(45).nullable().optional(),
  ssh_port: z.coerce.number().int().min(1).max(65535).optional(),
  ssh_username: z.string().min(1).max(64).optional(),
  isp_id: z.string().uuid().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  enabled: z.boolean().optional(),
}).refine((v) => Object.values(v).some((x) => x !== undefined), { message: "Nothing to update" });

// PUT /api/admin/vps/[id] — edit metadata, or enable/disable the server.
//
// The credential is NOT editable here; it goes through /credentials so that
// path can encrypt, audit and clear its own previous value atomically.
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await requireAdmin();
  if ("error" in denied) return denied.error;

  const { id } = await params;
  const existing = await getServer(id);
  if (!existing) return NextResponse.json({ error: "Server not found" }, { status: 404 });

  const parsed = patchSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 },
    );
  }
  const d = parsed.data;
  const svc = createServiceClient();

  // Enabling is gated on having a usable credential. Without this a server can
  // be flipped "enabled" and sit in the list claiming to be monitored with no
  // way to ever reach it.
  if (d.enabled === true) {
    const { data: cred } = await svc.from("vps_servers")
      .select("credential_encrypted").eq("id", id).maybeSingle();
    if (!cred?.credential_encrypted) {
      return NextResponse.json(
        { error: "Add a credential before enabling this server" }, { status: 400 },
      );
    }
  }

  const patch: Record<string, unknown> = {};
  for (const k of ["name", "provider", "region", "hostname", "ip_address",
    "ipv6_address", "ssh_port", "ssh_username", "isp_id", "notes"] as const) {
    if (d[k] !== undefined) patch[k] = d[k] === "" ? null : d[k];
  }
  if (d.enabled !== undefined) {
    patch.enabled = d.enabled;
    // A disabled server reports as disabled, not as whatever it last was.
    if (!d.enabled) patch.status = "disabled";
    else if (existing.status === "disabled") patch.status = "unknown";
  }

  const { data, error } = await svc.from("vps_servers")
    .update(patch).eq("id", id).select("*").single();
  if (error) {
    return NextResponse.json(
      { error: error.code === "23505" ? "A server with that name already exists" : error.message },
      { status: 400 },
    );
  }

  if (d.enabled === true) {
    await audit({ action: "vps_enabled", targetType: "vps_server", targetId: id, targetLabel: data.name });
  } else if (d.enabled === false) {
    await audit({ action: "vps_disabled", targetType: "vps_server", targetId: id, targetLabel: data.name });
  } else {
    await audit({
      action: "vps_updated", targetType: "vps_server", targetId: id, targetLabel: data.name,
      // Field NAMES only. Values are omitted so a note or hostname cannot
      // smuggle a secret into the audit trail.
      detail: { fields: Object.keys(patch) },
    });
  }

  return NextResponse.json({ server: publicServer(data as ServerRow) });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await requireAdmin();
  if ("error" in denied) return denied.error;

  const { id } = await params;
  const existing = await getServer(id);
  if (!existing) return NextResponse.json({ error: "Server not found" }, { status: 404 });

  // ON DELETE CASCADE removes the heartbeats and health events with it, so a
  // removed server leaves nothing behind that could be mined.
  const { error } = await createServiceClient().from("vps_servers").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  await audit({
    action: "vps_deleted", targetType: "vps_server", targetId: id, targetLabel: existing.name,
  });
  return NextResponse.json({ ok: true });
}
