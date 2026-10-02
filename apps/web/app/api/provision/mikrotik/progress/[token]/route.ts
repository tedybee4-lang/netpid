import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import {
  appendStepEvent, hashToken, isExpired, stepLabel, tokenMatchesHash,
} from "@/lib/mikrotik-provision";

export const dynamic = "force-dynamic";

/**
 * GET /api/provision/mikrotik/progress/:token?step=<id>&pct=<n>
 *
 * Called by the configure script at every step boundary, so the operator can
 * watch the router work instead of a bar frozen on "70% - script generated" for
 * however long a serial paste takes.
 *
 * WHAT A STEP DOES AND DOES NOT PROVE
 * It proves the router REACHED that boundary. It is not evidence that any object
 * was created: the script's own report reads the router back and prints what it
 * actually finds, and ONLINE still requires a RouterOS API health check over the
 * management path. That is why this route updates current_step/progress_pct but
 * never moves the session past CONFIGURED on its own.
 *
 * GET rather than POST because it is the one verb a factory-fresh router of
 * either major version can issue with nothing installed. Every callback in the
 * script is wrapped in on-error, so this endpoint being unreachable costs a tick
 * and nothing else - the router must never depend on the dashboard to finish.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const q = Object.fromEntries(new URL(req.url).searchParams.entries());
  const step = String(q.step ?? "").trim().slice(0, 40);

  // The script does not read the body and treats any 2xx as success, so these
  // stay plain text and deliberately tiny.
  const ack = (body: string, status = 200) => new NextResponse(`${body}\n`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });

  if (!step) return ack("# NETPID progress: no step", 400);

  try {
    const svc = createServiceClient();
    const { data: session } = await svc.from("router_provisioning_sessions")
      .select("id,token_hash,expires_at,step_log,progress_pct,status")
      .limit(1).eq("token_hash", hashToken(token)).maybeSingle();

    if (!session || !tokenMatchesHash(token, session.token_hash)) {
      return ack("# NETPID progress: unknown session", 404);
    }
    if (isExpired(session)) return ack("# NETPID progress: session expired", 410);

    // A router still running a script issued before a cancellation must not
    // resurrect the session by writing to it.
    if (session.status === "CANCELLED" || session.status === "EXPIRED") {
      return ack(`# NETPID progress: session is ${session.status}`, 409);
    }

    const now = new Date().toISOString();
    const log = appendStepEvent(session.step_log, step, Number(q.pct), now);
    const label = stepLabel(step);
    const pct = Math.min(100, Math.max(0, Math.round(Number(q.pct) || 0)));

    const patch: Record<string, unknown> = { step_log: log, last_seen_at: now };
    // Never regress. The wizard polls this every two seconds, and a bar that
    // walks backwards reads as a broken app rather than a late packet.
    if (pct >= (session.progress_pct ?? 0)) {
      patch.progress_pct = pct;
      patch.current_step = label;
    }

    const { error } = await svc.from("router_provisioning_sessions")
      .update(patch).eq("id", session.id);
    if (error) return ack("# NETPID progress: store failed", 400);

    return ack(`# NETPID progress: ${label} (${pct}%)`);
  } catch {
    // Never retry hard: the script moves on regardless and the dashboard falls
    // back to whatever the last stored step was.
    return ack("# NETPID progress: store failed");
  }
}