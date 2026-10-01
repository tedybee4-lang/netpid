import { NextResponse } from "next/server";
import { resolveIsp } from "@/lib/isp";
import { createServiceClient } from "@/lib/supabase/server";
import { hashToken, tokenMatchesHash } from "@/lib/mikrotik-provision";

export const dynamic = "force-dynamic";

/**
 * GET /api/provision/mikrotik/status/:token — what the wizard polls.
 *
 * Long-polling is used rather than SSE: the router may sit on a LAN that cannot
 * reach the public internet, so an EventSource connection would simply die and
 * the operator would see a dead wizard with no explanation. A plain fetch every
 * two seconds survives a flaky link and needs no reconnect logic.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const svc = createServiceClient();
  void req;
  const { token } = await params;

  const { data: session } = await svc.from("router_provisioning_sessions")
    .select("*").limit(1).eq("token_hash", hashToken(token)).maybeSingle();
  if (!session || !tokenMatchesHash(token, session.token_hash)) {
    return NextResponse.json({ error: "Unknown provisioning session." }, { status: 404 });
  }
  if (session.isp_id !== r.ispId) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  return NextResponse.json({
    status: session.status,
    progress_pct: session.progress_pct,
    current_step: session.current_step,
    error_message: session.error_message,
    routeros_version: session.routeros_version,
    board_name: session.board_name,
    router_model: session.router_model,
    architecture: session.architecture,
    cpu: session.cpu,
    ram_mb: session.ram_mb,
    capabilities: session.capabilities,
    interfaces: session.detected_interfaces,
    bridges: session.detected_bridges,
    selected_mode: session.selected_mode,
    wan_interface: session.wan_interface,
    expires_at: session.expires_at,
  });
}