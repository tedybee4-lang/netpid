import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import {
  buildDetectedInterfaces, decideCapabilities, decodeParam, hashToken,
  isExpired, parseBridges, parseRamMb, tokenMatchesHash,
} from "@/lib/mikrotik-provision";

export const dynamic = "force-dynamic";

/**
 * The router's hardware report lands here.
 *
 * BOTH GET and POST are implemented. RouterOS cannot POST - /tool fetch is a
 * GET with no body - so the router-side path is the GET, with the discovery
 * data in the query string. POST exists for any future client that can send a
 * body; the two paths converge on one parser so neither can drift.
 *
 * No authentication beyond the session token, because a stock router has no
 * NETPID credentials. The token is single-use and expires in 30 minutes.
 */
async function record(
  token: string,
  query: Record<string, string | undefined>,
  json: Record<string, unknown> | null,
) {
  const svc = createServiceClient();

  const { data: session } = await svc.from("router_provisioning_sessions")
    .select("*").limit(1).eq("token_hash", hashToken(token)).maybeSingle();
  if (!session || !tokenMatchesHash(token, session.token_hash)) {
    return NextResponse.json({ error: "Unknown provisioning session." }, { status: 404 });
  }
  if (isExpired(session)) {
    await svc.from("router_provisioning_sessions")
      .update({ status: "EXPIRED" }).eq("id", session.id);
    return NextResponse.json({ error: "This provisioning session has expired." }, { status: 410 });
  }

  const pick = (k: string, alt?: string): string => {
    if (json && json[k] != null) return String(json[k]).trim();
    const raw = query[k] ?? query[alt ?? k];
    return decodeParam(raw ?? "");
  };

  const version = pick("version");
  const board = pick("board", "model");
  const arch = pick("arch", "architecture");
  const cpu = pick("cpu");
  const ramMb = parseRamMb(pick("ram"));
  const ifacesRaw = pick("ifaces", "interfaces");
  const bridgesRaw = pick("bridges");

  const bridges = parseBridges(bridgesRaw);
  const ifaces = buildDetectedInterfaces(ifacesRaw, bridges);
  const caps = decideCapabilities({ version, architecture: arch, board });

  const patch: Record<string, unknown> = {
    status: "CAPABILITIES_DETECTED",
    routeros_version: version || null,
    board_name: board || null,
    router_model: board || null,
    architecture: arch || null,
    cpu: cpu || null,
    ram_mb: ramMb,
    detected_interfaces: ifaces,
    detected_bridges: bridges,
    capabilities: caps as unknown as Record<string, unknown>,
    current_step: "Configure ports",
    progress_pct: 40,
    last_seen_at: new Date().toISOString(),
    // An empty interface list means the report did not survive the URL, which
    // is a failure the operator must see rather than an empty wizard.
    error_message: ifaces.length ? null
      : "The router reported no interfaces. Check the router has DNS and can reach NETPID, then run the bootstrap command again.",
  };

  const { error } = await svc.from("router_provisioning_sessions")
    .update(patch).eq("id", session.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({
    ok: true,
    status: "CAPABILITIES_DETECTED",
    routeros_version: version,
    board_name: board,
    ram_mb: ramMb,
    interfaces: ifaces,
    bridges,
    capabilities: caps,
  });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const q = Object.fromEntries(new URL(req.url).searchParams.entries());
  return record(token, q, null);
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const json = await req.json().catch(() => null) as Record<string, unknown> | null;
  return record(token, {}, json);
}