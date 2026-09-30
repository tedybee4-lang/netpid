import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { checkRateLimit, encryptSecret } from "@/lib/secrets";
import { verifyDarajaCreds } from "@/lib/daraja-push";
import { resolveIsp } from "@/lib/isp";
import { z } from "zod";

// ISP admin: Daraja credential storage. The envelope is encrypted server-side
// with APP_ENCRYPTION_KEY and never returned by any read path.
const schema = z.object({
  consumer_key: z.string().min(4).max(256),
  consumer_secret: z.string().min(4).max(512),
  passkey: z.string().min(4).max(512),
  shortcode: z.string().min(4).max(20),
  environment: z.enum(["sandbox", "production"]).default("sandbox"),
  till_number: z.string().max(20).optional().or(z.literal("")),
  paybill: z.string().max(20).optional().or(z.literal("")),
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
  const { data: providers } = await svc.from("payment_providers")
    .select("id, provider, account_name, paybill, till_number, callback_url, status")
    .eq("isp_id", a.ok.ispId);
  // Configured flags only — never secrets.
  const rows = (providers ?? []).map((p) => {
    const row = p as { provider: string; status: string; paybill: string | null; till_number: string | null; callback_url: string | null };
    return { provider: row.provider, status: row.status, paybill: row.paybill, till_number: row.till_number, callback_url: row.callback_url };
  });
  return NextResponse.json({
    providers: rows,
    daraja_configured: rows.some((x) => x.provider === "daraja" && x.status === "active"),
  });
}

export async function POST(req: Request) {
  const a = await requireAdmin(req);
  if ("error" in a) return a.error;
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }
  const d = parsed.data;
  const svc = createServiceClient();
  const allowed = await checkRateLimit(svc, svc, `daraja-save:${a.ok.ispId}`, 10, 3600);
  if (!allowed) return NextResponse.json({ error: "Rate limited." }, { status: 429 });

  // Prove the credentials against Daraja BEFORE marking the provider active.
  // A saved-but-unverified secret is how an ISP ends up with a "connected"
  // badge and a 502 on every STK push, so 'active' is reserved for credentials
  // Safaricom has actually accepted.
  const candidate = {
    consumer_key: d.consumer_key.trim(),
    consumer_secret: d.consumer_secret.trim(),
    passkey: d.passkey.trim(),
    shortcode: d.shortcode.trim(),
    environment: d.environment,
  };
  let verified = true;
  let warning: string | null = null;
  try {
    await verifyDarajaCreds(candidate);
  } catch (e) {
    verified = false;
    warning = e instanceof Error ? e.message : "Daraja rejected the credentials";
  }

  let encrypted: string;
  try {
    encrypted = encryptSecret(JSON.stringify(candidate));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Encryption failed" }, { status: 500 });
  }

  const { data: provider, error } = await svc.from("payment_providers").upsert({
    isp_id: a.ok.ispId, provider: "daraja",
    till_number: d.till_number || null, paybill: d.paybill || null,
    status: verified ? "active" : "disabled",
  }, { onConflict: "isp_id,provider" }).select("id").single();
  if (error || !provider) {
    return NextResponse.json({ error: error?.message ?? "Could not save" }, { status: 400 });
  }
  await svc.from("payment_provider_credentials").upsert({
    provider_id: (provider as { id: string }).id,
    encrypted_secret: encrypted, key_version: 1,
  }, { onConflict: "provider_id" });

  // ISP-scoped audit trail (audit_logs, not the Super Admin platform log).
  // Metadata records the outcome only — never any part of the secret.
  await svc.from("audit_logs").insert({
    actor_id: a.ok.user.id, actor_type: "user", isp_id: a.ok.ispId,
    action: "payment_provider_updated", resource: "payment_providers",
    resource_id: (provider as { id: string }).id,
    metadata: { provider: "daraja", environment: d.environment, verified },
  });

  return NextResponse.json({
    ok: true, verified, environment: d.environment,
    warning: verified
      ? null
      : `Saved, but Daraja refused the credentials so STK Push stays off: ${warning}`,
  });
}
