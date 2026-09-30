import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveIsp } from "@/lib/isp";
import { createServiceClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/admin-auth";
import { checkRateLimit } from "@/lib/secrets";
import { buildWireguardScript, isWireguardKey } from "@/lib/routeros";
import {
  allocateTunnelSubnet, encryptTunnelKey, generateKeyPair,
  publicView, type TunnelRow,
} from "@/lib/wireguard";

export const dynamic = "force-dynamic";

/**
 * GET/POST/DELETE /api/routers/[id]/wireguard
 *
 * The private key is generated HERE, encrypted at rest, and never leaves the
 * server. The response carries only public material: NETPID's public key, the
 * router's public key once registered, the tunnel addresses and a ready-to-paste
 * RouterOS script.
 *
 * Tenancy: a caller must either be a Super Admin or an admin of the ISP that
 * owns the router. The ownership check happens against the SERVICE client, so
 * RLS is not the only thing standing between one ISP and another's tunnel.
 */

const idSchema = z.string().uuid();

const createSchema = z.object({
  action: z.enum(["create", "rotate", "register-router-key", "update-notes"]),
  /** Only for register-router-key. Validated as a real key before it is stored. */
  router_public_key: z.string().max(80).optional(),
  notes: z.string().max(2000).optional().or(z.literal("")),
  /** Operator-facing endpoint the router should dial. */
  vps_endpoint: z.string().max(80).optional().or(z.literal("")),
});

/**
 * Load the router and prove the caller may act on it.
 *
 * Returns a discriminated `{ ok: true | false }` rather than relying on an
 * `in` check: `resolveIsp` returns a union of its own, and spreading it into a
 * wider return type defeats narrowing at every call site.
 */
async function authorize(id: string, needAdmin: boolean) {
  const fail = (error: string, status: number) =>
    ({ ok: false as const, error: NextResponse.json({ error }, { status }) });

  const r = await resolveIsp(
    new Request(`http://x/api/routers/${id}/wireguard`, { headers: {} }),
  );
  if ("error" in r) return { ok: false as const, error: r.error };

  const svc = createServiceClient();
  const { data: router } = await svc
    .from("routers").select("id,isp_id,name,host,ros_version,status").eq("id", id).maybeSingle();
  if (!router) return fail("Router not found", 404);

  const platform = await isAdmin();
  const mine = router.isp_id === r.ispId;
  // A Super Admin governs the infrastructure; anyone else must own the router.
  if (!platform && !mine) return fail("Forbidden", 403);

  if (needAdmin && !platform) {
    // Members may read their own tunnel; changing keys is an admin action.
    const { data: mem } = await r.supabase
      .from("isp_user_roles").select("role")
      .eq("isp_user_id", r.user.id).eq("isp_id", router.isp_id);
    const roles = (mem ?? []).map((m) => (m as { role: string }).role);
    if (!roles.includes("admin") && !roles.includes("owner")) {
      return fail("ISP admin required", 403);
    }
  }
  return {
    ok: true as const,
    svc,
    router: router as { id: string; isp_id: string; name: string },
    ispId: router.isp_id as string,
  };
}

async function scriptFor(t: TunnelRow | null, routerName: string, endpoint?: string | null) {
  if (!t) return null;
  return buildWireguardScript({
    serverPublicKey: t.server_public_key,
    routerTunnelIp: t.router_tunnel_ip,
    vpsTunnelIp: t.vps_tunnel_ip,
    listenPort: t.listen_port,
    routerPublicKey: t.router_public_key,
    routerName,
    includeRadius: true,
    vpsEndpoint: endpoint ?? null,
  });
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!idSchema.safeParse(id).success) {
    return NextResponse.json({ error: "Invalid router id" }, { status: 400 });
  }
  const auth = await authorize(id, false);
  if (!auth.ok) return auth.error;
  const { svc, router } = auth;

  const { data } = await svc.from("router_tunnels").select("*").eq("router_id", id).maybeSingle();
  const t = (data as TunnelRow | null) ?? null;
  const script = await scriptFor(t, router.name);
  return NextResponse.json({ tunnel: t ? publicView(t) : null, script });
}

/**
 * Idempotent enqueue: a retried click cannot install the same peer twice.
 *
 * `p_router_id` must be the ROUTER id. The job is keyed on the router, so
 * passing the tunnel id here would group two different routers' jobs under one
 * key and let a stale job for router A suppress a fresh one for router A's
 * re-created tunnel.
 */
async function syncJob(
  svc: ReturnType<typeof createServiceClient>,
  routerId: string,
  tunnelId: string,
  ispId: string,
  action: string,
) {
  const { error } = await svc.rpc("enqueue_job_once", {
    p_kind: "wireguard-tunnel-sync",
    p_isp_id: ispId,
    p_router_id: routerId,
    p_key: `wg-sync:${routerId}:${tunnelId}:${action}`,
    p_payload: { tunnel_id: tunnelId, router_id: routerId, action },
  });
  if (error) {
    // A failed enqueue must not read as success: the caller would show a
    // "provisioned" state that no worker will ever act on.
    throw new Error(`enqueue_job_once failed: ${error.message}`);
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!idSchema.safeParse(id).success) {
    return NextResponse.json({ error: "Invalid router id" }, { status: 400 });
  }
  // Key generation is cheap, but a runaway loop would fill router_tunnels with
  // rows the operator never intends. The rate limit is checked after auth so
  // the counter is scoped to a caller, not to a router id they may not own.
  const auth = await authorize(id, true);
  if (!auth.ok) return auth.error;
  const { svc, router, ispId } = auth;

  const allowed = await checkRateLimit(svc, svc, `wg:${ispId}:${id}`, 20, 3600);
  if (!allowed) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  const parsed = createSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 },
    );
  }
  const { action } = parsed.data;

  const { data: existing } = await svc
    .from("router_tunnels").select("*").eq("router_id", id).maybeSingle();
  let t = (existing as TunnelRow | null) ?? null;

  if (action === "create" || action === "rotate") {
    if (action === "rotate" && !t) {
      return NextResponse.json({ error: "No tunnel to rotate" }, { status: 404 });
    }
    // Rotation replaces the key pair. The old private key is overwritten, never
    // kept, so a rotated key cannot be recovered out of the database.
    const keys = generateKeyPair();
    const alloc = t
      ? { subnet: t.tunnel_subnet, vpsIp: t.vps_tunnel_ip, routerIp: t.router_tunnel_ip }
      : await allocateTunnelSubnet();

    const row = {
      isp_id: ispId,
      router_id: id,
      tunnel_subnet: alloc.subnet,
      vps_tunnel_ip: alloc.vpsIp,
      router_tunnel_ip: alloc.routerIp,
      server_public_key: keys.publicKey,
      server_private_key_encrypted: encryptTunnelKey(keys.privateKey),
      status: "pending",
      last_handshake_at: null,
      last_endpoint: null,
    };

    const { data: saved, error } = t
      ? await svc.from("router_tunnels").update(row).eq("id", t.id).select("*").single()
      : await svc.from("router_tunnels").insert(row).select("*").single();
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    t = saved as TunnelRow;

    try {
      await syncJob(svc, id, t.id, ispId, action);
    } catch (e) {
      // The tunnel row is already written; report the enqueue failure rather
      // than letting a generic 500 hide which half of the operation worked.
      return NextResponse.json(
        { error: `Tunnel saved but the worker was not queued: ${(e as Error).message}` },
        { status: 502 },
      );
    }
    await svc.from("router_provision_log").insert({
      isp_id: ispId, router_id: id,
      action: action === "rotate" ? "wireguard_rotate" : "wireguard_create",
      source: "api",
      detail: { tunnel_id: t.id, subnet: t.tunnel_subnet },
    });
  }
  if (action === "register-router-key") {
    if (!t) return NextResponse.json({ error: "Create the tunnel first" }, { status: 409 });
    const key = parsed.data.router_public_key ?? "";
    // Validated as a real 32-byte base64 key before it is stored: a typo would
    // otherwise be accepted here and only surface as a silent tunnel failure.
    if (!isWireguardKey(key)) {
      return NextResponse.json(
        { error: "That is not a valid WireGuard public key (32 bytes, base64)" },
        { status: 400 },
      );
    }
    const { data: saved, error } = await svc.from("router_tunnels")
      .update({ router_public_key: key, status: "provisioned" })
      .eq("id", t.id).select("*").single();
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    t = saved as TunnelRow;
    try {
      await syncJob(svc, id, t.id, ispId, "peer");
    } catch (e) {
      return NextResponse.json(
        { error: `Router key stored but the worker was not queued: ${(e as Error).message}` },
        { status: 502 },
      );
    }
  }

  if (action === "update-notes" && t) {
    const { data: saved, error } = await svc.from("router_tunnels")
      .update({ notes: parsed.data.notes || null }).eq("id", t.id).select("*").single();
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    t = saved as TunnelRow;
  }

  const script = await scriptFor(t, router.name, parsed.data.vps_endpoint);
  return NextResponse.json({ tunnel: t ? publicView(t) : null, script });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!idSchema.safeParse(id).success) {
    return NextResponse.json({ error: "Invalid router id" }, { status: 400 });
  }
  const auth = await authorize(id, true);
  if (!auth.ok) return auth.error;
  const { svc, ispId } = auth;

  const { data: t } = await svc
    .from("router_tunnels").select("id").eq("router_id", id).maybeSingle();
  if (!t) return NextResponse.json({ error: "No tunnel to remove" }, { status: 404 });
  const tunnelId = (t as { id: string }).id;

  // Mark revoked rather than delete: the row is the audit trail, and a hard
  // delete would erase the fact that a tunnel ever existed for this router.
  await svc.from("router_tunnels")
    .update({ status: "revoked", notes: "revoked via dashboard" }).eq("id", tunnelId);
  try {
    await syncJob(svc, id, tunnelId, ispId, "revoke");
  } catch (e) {
    return NextResponse.json(
      { error: `Tunnel revoked but the worker was not queued: ${(e as Error).message}` },
      { status: 502 },
    );
  }
  await svc.from("router_provision_log").insert({
    isp_id: ispId, router_id: id, action: "wireguard_revoke", source: "api",
    detail: { tunnel_id: tunnelId },
  });
  return NextResponse.json({ ok: true, status: "revoked" });
}
