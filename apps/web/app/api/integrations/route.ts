// Third-party provider connections (UISP, Social Spot, WhatsApp Business).
//
// GET never returns api_key_encrypted — only whether a key is stored. The
// "test" action performs a real HTTP call server-side and reports the result,
// which is the only way an operator can tell a working key from a dead one.
import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { resolveIsp } from "@/lib/isp";
import { encryptSecret, decryptSecret } from "@/lib/secrets";
import { z } from "zod";

const PROVIDERS = ["uisp", "social_spot", "whatsapp_business", "sms_alt"] as const;

const putSchema = z.object({
  provider: z.enum(PROVIDERS),
  enabled: z.boolean().default(false),
  base_url: z.string().url().max(300).optional().or(z.literal("")),
  // Omit on update to keep the stored key; pass "" to clear it.
  api_key: z.string().max(400).optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
});

export async function GET(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  // api_key_encrypted IS selected (otherwise has_key can never be true) but is
  // stripped below and never leaves the server.
  const { data } = await r.supabase
    .from("integrations")
    .select("id,provider,enabled,base_url,api_key_encrypted,last_status,last_checked_at,extra,created_at")
    .eq("isp_id", r.ispId);
  const integrations = (data ?? []).map(({ api_key_encrypted, ...rest }) => ({
    ...rest,
    has_key: Boolean(api_key_encrypted),
  }));
  return NextResponse.json({ integrations, providers: PROVIDERS });
}

export async function PUT(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const parsed = putSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }
  const { provider, enabled, base_url, api_key, extra } = parsed.data;
  const svc = createServiceClient();

  const { data: existing } = await svc.from("integrations")
    .select("api_key_encrypted").eq("isp_id", r.ispId).eq("provider", provider).maybeSingle();

  let keyColumn: string | null = existing?.api_key_encrypted ?? null;
  if (api_key === "") keyColumn = null;             // explicit clear
  else if (api_key) keyColumn = encryptSecret(api_key);

  const { data, error } = await svc.from("integrations").upsert({
    isp_id: r.ispId, provider, enabled,
    base_url: base_url || null, api_key_encrypted: keyColumn,
    extra: extra ?? {}, last_status: null,
  }, { onConflict: "isp_id,provider" })
    .select("id,provider,enabled,base_url,last_status").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ integration: data });
}

// POST {provider, action:"test"} — live reachability + credential check.
export async function POST(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const body = await req.json().catch(() => ({}));
  const provider = String(body.provider ?? "");
  if (!PROVIDERS.includes(provider as typeof PROVIDERS[number])) {
    return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
  }
  const svc = createServiceClient();
  const { data: row } = await svc.from("integrations")
    .select("base_url,api_key_encrypted").eq("isp_id", r.ispId).eq("provider", provider).maybeSingle();
  if (!row?.base_url) return NextResponse.json({ error: "No base URL configured" }, { status: 400 });

  let status = "unreachable";
  let detail = "";
  try {
    const key = row.api_key_encrypted ? decryptSecret(row.api_key_encrypted) : "";
    const res = await fetch(row.base_url, {
      // UISP/Social Spot expose an auth-probe endpoint; 401 still proves the
      // host is reachable, so it is not treated as a failure.
      headers: { accept: "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    status = res.status === 401 || res.status === 403 ? "reachable, credentials rejected" : `HTTP ${res.status}`;
    detail = res.ok ? "Connected." : "Host answered; check the API key and permissions.";
  } catch (e) {
    detail = e instanceof Error ? e.message : "Request failed";
  }
  await svc.from("integrations")
    .update({ last_status: status, last_checked_at: new Date().toISOString() })
    .eq("isp_id", r.ispId).eq("provider", provider);
  return NextResponse.json({ provider, status, detail });
}
