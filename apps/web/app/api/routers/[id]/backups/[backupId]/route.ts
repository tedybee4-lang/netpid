import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { resolveIsp } from "@/lib/isp";

// GET /api/routers/[id]/backups/[backupId] — manifest row + how to retrieve it.
//
// DELETE — forgets the manifest row. It deliberately does NOT claim to delete
// the file: that byte-for-byte copy sits on the router's own disk and this API
// has no RouterOS file-delete wired up. Saying "deleted" while the .backup
// survives would be a lie an operator could act on.
//
// The download behaviour is documented on the `/download` route below.

type Ctx = { params: Promise<{ id: string; backupId: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const { id, backupId } = await ctx.params;
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;

  const { data } = await r.supabase.from("router_backups")
    .select("id, router_id, created_at, size_bytes, storage_path")
    .eq("id", backupId).eq("router_id", id).eq("isp_id", r.ispId).maybeSingle();
  if (!data) return NextResponse.json({ error: "Backup not found" }, { status: 404 });

  const file = data.storage_path.split("/").pop() ?? data.storage_path;
  return NextResponse.json({
    id: data.id,
    created_at: data.created_at,
    size_bytes: data.size_bytes,
    router_file: file,
    storage_path: data.storage_path,
    retrievable: false,
    retrieval: "on-router",
  });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const { id, backupId } = await ctx.params;
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;

  const svc = createServiceClient();
  const { data } = await svc.from("router_backups")
    .select("id, router_id, storage_path")
    .eq("id", backupId).eq("router_id", id).eq("isp_id", r.ispId).maybeSingle();
  if (!data) return NextResponse.json({ error: "Backup not found" }, { status: 404 });

  const { error } = await svc.from("router_backups").delete().eq("id", backupId);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  await svc.from("audit_logs").insert({
    actor_id: r.user.id, actor_type: "user", isp_id: r.ispId,
    action: "router_backup_forgotten", resource: "router_backups", resource_id: backupId,
    metadata: { router_id: id, file: data.storage_path.split("/").pop() },
  });

  return NextResponse.json({
    ok: true,
    message: "Manifest entry removed. The .backup file itself is still on the router — delete it from RouterOS if you need it gone.",
    router_file: data.storage_path.split("/").pop(),
  });
}
