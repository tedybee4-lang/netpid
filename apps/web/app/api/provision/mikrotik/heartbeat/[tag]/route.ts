import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/provision/mikrotik/heartbeat/:tag
 *
 * Called by the scheduler entry the configure script installs, every five
 * minutes. This is how a router NETPID cannot reach over its tunnel still proves
 * it exists - a management path that only works one way is not management.
 *
 * The tag is the NETPID router id prefix. It carries no secret: the worst it
 * reveals is that a router with that prefix exists, and the same id prefix is
 * already visible in every RADIUS accounting row NETPID holds.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ tag: string }> },
) {
  const { tag } = await params;
  // RouterOS has no way to POST, so uptime is passed as a query parameter by
  // the scheduler event when it can, and simply omitted otherwise.
  const seen = new Date().toISOString();

  // RouterOS treats any 2xx as success; keep the body tiny so the fetch is fast.
  const ack = (body: string) => new NextResponse(`${body}\n`, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });

  if (!tag || !/^[A-Za-z0-9_-]{1,64}$/.test(tag)) {
    return ack("# NETPID heartbeat: bad tag");
  }

  try {
    const svc = createServiceClient();
    // Match on the id prefix the configure script used.
    const { data: rows } = await svc.from("routers")
      .select("id,status,last_seen_at")
      .like("id", `${tag}%`)
      .limit(1);
    const router = rows?.[0];

    if (router) {
      await svc.from("routers")
        .update({ last_seen_at: seen })
        .eq("id", router.id);
      await svc.from("router_provisioning_sessions")
        .update({ last_seen_at: seen })
        .like("id", `${tag}%`);
      // The heartbeat proves the router is alive, NOT that NETPID can manage it.
      // status stays as it is: a working API path over the tunnel is still
      // required before anything may claim ONLINE.
      return ack(`# NETPID heartbeat recorded for ${tag}`);
    }
    return ack(`# NETPID heartbeat received for ${tag} (router not registered)`);
  } catch {
    // The router must not retry hard on a database blip; the scheduler runs
    // again in five minutes regardless.
    return ack("# NETPID heartbeat stored failed");
  }
}