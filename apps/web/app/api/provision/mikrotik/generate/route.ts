import { NextResponse } from "next/server";
import { resolveIsp } from "@/lib/isp";
import { createServiceClient } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/secrets";
import {
  SESSION_TTL_MINUTES, hashToken, mintToken, publicBaseUrl,
} from "@/lib/mikrotik-provision";

export const dynamic = "force-dynamic";

/**
 * POST /api/provision/mikrotik/generate — start an interactive session.
 *
 * Returns a SINGLE terminal command. No permanent credential, API password,
 * RADIUS secret or WireGuard key is ever placed in the URL: the token is a
 * one-shot, 30-minute bearer that grants hardware discovery and nothing more,
 * and only its SHA-256 hash is stored.
 */
export async function POST(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const svc = createServiceClient();

  const allowed = await checkRateLimit(svc, svc, `mikrotik-provision:${r.ispId}`, 10, 3600);
  if (!allowed) {
    return NextResponse.json({ error: "Too many provisioning sessions. Try again later." }, { status: 429 });
  }

  const body = await req.json().catch(() => ({})) as { router_id?: string };
  let routerId: string | null = null;
  if (body.router_id) {
    // Bind to the router only if the caller owns it. resolveIsp is not the
    // only gate: the row is re-checked against isp_id directly.
    const { data: owned } = await svc.from("routers")
      .select("id").eq("id", body.router_id).eq("isp_id", r.ispId).maybeSingle();
    if (!owned) return NextResponse.json({ error: "Router not found." }, { status: 404 });
    routerId = owned.id;
  }

  const token = mintToken();
  const expires = new Date(Date.now() + SESSION_TTL_MINUTES * 60_000).toISOString();

  const { data: session, error } = await svc.from("router_provisioning_sessions").insert({
    isp_id: r.ispId,
    router_id: routerId,
    token_hash: hashToken(token),
    status: "PENDING",
    expires_at: expires,
  }).select("id").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  // The host the OPERATOR actually loaded, not whatever VERCEL_URL happens to
  // say. Those two disagree in practice: a production dashboard was observed
  // handing out a command pointing at a preview deployment, so the router
  // fetched a script from a host that is deleted when its branch closes. The
  // request origin is the host the browser just proved it can reach.
  const origin = new URL(req.url).origin;
  const base = origin || publicBaseUrl();
  const url = `${base}/api/provision/mikrotik/bootstrap/${token}`;
  // One line, so it survives a paste into the router terminal without wrapping.
  const command =
    `/tool fetch mode=https url=${url} dst-path=netpid_init.rsc; `
    + `:delay 2s; /import netpid_init.rsc`;

  return NextResponse.json({
    session_id: session.id,
    // Shown exactly once. The server keeps only the hash.
    token,
    command,
    bootstrap_url: url,
    expires_at: expires,
    ttl_minutes: SESSION_TTL_MINUTES,
  }, { status: 201 });
}