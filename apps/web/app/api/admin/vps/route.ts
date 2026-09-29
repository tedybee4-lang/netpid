import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import {
  requireAdmin, serverSchema, publicServer, deriveCredentialStatus, type ServerRow,
} from "@/lib/vps";
import { audit } from "@/lib/platform-audit";

export const dynamic = "force-dynamic";

// Super Admin only. Rejects the call before touching the database.
async function guard() {
  const a = await requireAdmin();
  if ("error" in a) return a;
  return null;
}

export async function GET() {
  const denied = await guard();
  if (denied) return denied.error;

  const svc = createServiceClient();
  const { data, error } = await svc.from("vps_servers")
    .select("*").order("created_at", { ascending: false }).limit(200);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  // Recompute credential status on read so an expired credential is visible
  // without depending on a background job having run.
  const servers = (data as ServerRow[]).map((row) => ({
    ...publicServer(row),
    credential_status: deriveCredentialStatus(row.credential_status, row.credential_expires_at),
  }));
  return NextResponse.json({ servers });
}

export async function POST(req: Request) {
  const denied = await guard();
  if (denied) return denied.error;

  const parsed = serverSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 },
    );
  }
  const d = parsed.data;
  const svc = createServiceClient();

  // Referential check: a server cannot be attached to a tenant that does not
  // exist, and the id is not taken on trust.
  if (d.isp_id) {
    const { data: isp } = await svc.from("isps").select("id").eq("id", d.isp_id).maybeSingle();
    if (!isp) return NextResponse.json({ error: "That ISP does not exist" }, { status: 400 });
  }

  const { data, error } = await svc.from("vps_servers").insert({
    isp_id: d.isp_id || null,
    name: d.name, provider: d.provider, region: d.region || null,
    hostname: d.hostname || null, ip_address: d.ip_address,
    ipv6_address: d.ipv6_address || null,
    ssh_port: d.ssh_port, ssh_username: d.ssh_username,
    auth_method: d.auth_method,
    // A server is registered disabled until a credential is added and a
    // connection test passes. Registering it "online" on trust would be a lie
    // the dashboard would then keep repeating.
    enabled: false,
    notes: d.notes || null,
  }).select("*").single();
  if (error) {
    return NextResponse.json(
      { error: error.code === "23505" ? "A server with that name already exists" : error.message },
      { status: 400 },
    );
  }

  await audit({
    action: "vps_created",
    targetType: "vps_server", targetId: data.id, targetLabel: data.name,
    detail: { provider: data.provider, ip: data.ip_address, ssh_port: data.ssh_port },
  });

  return NextResponse.json({ server: publicServer(data as ServerRow) }, { status: 201 });
}
