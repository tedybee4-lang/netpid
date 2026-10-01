import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { buildBootstrapScript } from "@/lib/mikrotik-provision-script";
import { hashToken, isExpired, tokenMatchesHash } from "@/lib/mikrotik-provision";

export const dynamic = "force-dynamic";

/**
 * GET /api/provision/mikrotik/bootstrap/:token
 *
 * Public, because a router has no NETPID session. The token is the whole
 * authorisation: single-use, 30 minutes, stored only as a SHA-256 hash.
 *
 * Returns text/plain RouterOS script, NOT JSON, because it is consumed by
 * /import on the router. A JSON error here would be imported as a script and
 * fail in a way that tells the operator nothing.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const svc = createServiceClient();

  // Same response for "no such token" and "expired", so this endpoint cannot be
  // used to probe which tokens exist.
  const fail = (why: string) => new NextResponse(
    `# NETPID: ${why}\n# Ask the dashboard for a new bootstrap command.\n`,
    { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } },
  );
  if (!token || token.length < 16) return fail("This provisioning link is not valid.");

  const { data: session } = await svc.from("router_provisioning_sessions")
    .select("*").limit(1).eq("token_hash", hashToken(token)).maybeSingle();

  if (!session || !tokenMatchesHash(token, session.token_hash)) {
    return fail("This provisioning link is not valid.");
  }
  if (isExpired(session)) return fail("This provisioning link has expired.");
  if (session.status === "CANCELLED") return fail("This provisioning session was cancelled.");

  const script = buildBootstrapScript({
    baseUrl: new URL(req.url).origin,
    token,
    sessionId: session.id,
  });

  await svc.from("router_provisioning_sessions")
    .update({ status: "BOOTSTRAPPED", last_seen_at: new Date().toISOString() })
    .eq("id", session.id);

  return new NextResponse(script, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      // A bootstrap script must never be cached: the token is single-use and a
      // cached copy would replay a spent session.
      "cache-control": "no-store, max-age=0",
    },
  });
}