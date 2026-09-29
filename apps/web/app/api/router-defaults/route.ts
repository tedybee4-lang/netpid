// Per-ISP router provisioning defaults. These are the values the name-only
// provisioning flow fills in for the operator: subnet for the management IP,
// RADIUS coordinates, API credentials and script defaults.
import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { resolveIsp } from "@/lib/isp";
import { z } from "zod";

const putSchema = z.object({
  mgmt_subnet: z.string().regex(/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/, "e.g. 10.10.10.0/24"),
  mgmt_gateway: z.string().regex(/^\d{1,3}(\.\d{1,3}){3}$/, "e.g. 10.10.10.1"),
  api_username: z.string().min(1).max(64),
  api_port: z.coerce.number().int().min(1).max(65535),
  api_ssl_port: z.coerce.number().int().min(1).max(65535),
  use_ssl: z.boolean(),
  ros_version: z.enum(["6", "7"]),
  radius_server: z.union([z.string().regex(/^\d{1,3}(\.\d{1,3}){3}$/), z.literal("")]),
  radius_auth_port: z.coerce.number().int().min(1).max(65535),
  radius_acct_port: z.coerce.number().int().min(1).max(65535),
  radius_coa_port: z.coerce.number().int().min(1).max(65535),
  nas_prefix: z.string().min(1).max(32),
  dns_servers: z.string().min(1).max(120),
  ntp_servers: z.string().min(1).max(120),
  wifi_ssid: z.string().max(64).optional().or(z.literal("")),
  country_code: z.string().min(2).max(3),
});

async function requireAdmin(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return { error: r.error };
  const { data } = await r.supabase.rpc("has_isp_role", { p_isp_id: r.ispId, p_role: "admin" });
  if (data !== true) {
    return { error: NextResponse.json({ error: "Admin access required" }, { status: 403 }) };
  }
  return { ok: r };
}

export async function GET(req: Request) {
  const a = await requireAdmin(req);
  if ("error" in a) return a.error;
  const svc = createServiceClient();
  const { data, error } = await svc.from("isp_router_defaults")
    .select("*").eq("isp_id", a.ok.ispId).maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ defaults: data ?? null });
}

export async function PUT(req: Request) {
  const a = await requireAdmin(req);
  if ("error" in a) return a.error;
  const parsed = putSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 },
    );
  }
  const d = parsed.data;
  // The gateway must sit inside the management subnet, otherwise the router will
  // be handed an address it can never reach a gateway on.
  const [subnetBase] = d.mgmt_subnet.split("/");
  const prefix = Number(d.mgmt_subnet.split("/")[1]);
  if (prefix > 0) {
    const toInt = (ip: string) => ip.split(".").reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    if (((toInt(d.mgmt_gateway) ^ toInt(subnetBase)) & mask) !== 0) {
      return NextResponse.json(
        { error: "The gateway is outside that subnet" }, { status: 400 },
      );
    }
  }
  if (d.radius_auth_port === d.radius_acct_port) {
    return NextResponse.json(
      { error: "Auth and accounting ports must differ" }, { status: 400 },
    );
  }
  const svc = createServiceClient();
  const { error } = await svc.from("isp_router_defaults").upsert({
    isp_id: a.ok.ispId,
    mgmt_subnet: d.mgmt_subnet, mgmt_gateway: d.mgmt_gateway,
    api_username: d.api_username, api_port: d.api_port, api_ssl_port: d.api_ssl_port,
    use_ssl: d.use_ssl, ros_version: d.ros_version,
    radius_server: d.radius_server || null,
    radius_auth_port: d.radius_auth_port, radius_acct_port: d.radius_acct_port,
    radius_coa_port: d.radius_coa_port, nas_prefix: d.nas_prefix,
    dns_servers: d.dns_servers, ntp_servers: d.ntp_servers,
    wifi_ssid: d.wifi_ssid || null, country_code: d.country_code,
  }, { onConflict: "isp_id" });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
