import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/secrets";
import { resolveIsp } from "@/lib/isp";
import { getPlatformDaraja } from "@/lib/daraja";
import { z } from "zod";

// ISP admin: declare the Till/PayBill their customers pay into.
//
// THAT IS THE ONLY THING AN ISP DECLARES. They hold no Daraja credentials.
// NETPID runs one app (migration 0044) and authenticates the push; the number
// below is the RECEIVER, so customer money lands in the ISP's own Till and
// never passes through NETPID.
//
// Requiring per-ISP credentials was a multi-week Safaricom onboarding wall for
// every operator, and it let an ISP set a shortcode that silently overrode their
// declared Till — which is exactly how a customer ended up paying a Daraja
// sandbox account.
const schema = z.object({
  till_number: z.string().max(20).optional().or(z.literal("")),
  paybill: z.string().max(20).optional().or(z.literal("")),
  // Which of the two is LIVE. Optional so an older client that never sends it
  // still works; the server then infers from whichever number is present.
  payment_method: z.enum(["till", "paybill"]).optional(),
});

/**
 * Collapse the (till_number, paybill, payment_method) triple into one coherent
 * answer: exactly one number, matching the declared method, and the other
 * column cleared. Storing both and calling it a day is how a portal ends up
 * telling a customer to pay a number the operator retired last month.
 */
function resolvePayTarget(d: {
  payment_method?: "till" | "paybill";
  till_number?: string; paybill?: string;
}): { method: "till" | "paybill" | null; till: string | null; paybill: string | null; error?: string } {
  const tillRaw = (d.till_number ?? "").trim();
  const pbRaw = (d.paybill ?? "").trim();
  // An explicit choice wins. Otherwise infer, preferring Till when both are set
  // so we never silently discard a number the operator typed.
  const method = d.payment_method ?? (tillRaw ? "till" : pbRaw ? "paybill" : null);
  if (!method) return { method: null, till: null, paybill: null };
  const till = method === "till" ? tillRaw : "";
  const paybill = method === "paybill" ? pbRaw : "";
  if (!till && !paybill) {
    return {
      method, till: null, paybill: null,
      error: `Choose Till or PayBill, then enter the ${method === "till" ? "Till" : "PayBill"} number customers will pay to.`,
    };
  }
  return { method, till: till || null, paybill: paybill || null };
}

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
  const { data } = await svc.from("payment_providers")
    .select("payment_method,till_number,paybill,status").eq("isp_id", a.ok.ispId)
    .eq("provider", "daraja").maybeSingle();
  const row = (data ?? {}) as {
    payment_method?: "till" | "paybill" | null;
    till_number?: string | null; paybill?: string | null; status?: string | null;
  };
  const platform = await getPlatformDaraja();
  return NextResponse.json({
    daraja_configured: row.status === "active",
    payment_method: row.payment_method ?? null,
    till_number: row.till_number ?? null,
    paybill: row.paybill ?? null,
    // The ISP never sets this. They need to know whether their Till will
    // actually collect, and the only honest answer comes from the platform.
    platform_app_configured: platform !== null,
    environment: platform?.environment ?? null,
  });
}

export async function POST(req: Request) {
  const a = await requireAdmin(req);
  if ("error" in a) return a.error;
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
  const d = parsed.data;
  const svc = createServiceClient();

  // One live pay-in target, not two. Resolve before anything is written so a
  // half-valid pair never reaches the table.
  const target = resolvePayTarget(d);
  if (target.error) return NextResponse.json({ error: target.error }, { status: 400 });

  const allowed = await checkRateLimit(svc, svc, `daraja-save:${a.ok.ispId}`, 10, 3600);
  if (!allowed) return NextResponse.json({ error: "Rate limited." }, { status: 429 });

  // active means "STK Push should collect here". That needs both halves: an ISP
  // target AND a platform app. Declaring a Till while the platform has no app
  // leaves the ISP active-but-silent, which reads as "connected and working".
  const platform = await getPlatformDaraja();
  const live = target.method !== null && platform !== null;

  const { data: provider, error } = await svc.from("payment_providers").upsert({
    isp_id: a.ok.ispId, provider: "daraja",
    payment_method: target.method, till_number: target.till, paybill: target.paybill,
    status: live ? "active" : "disabled",
  }, { onConflict: "isp_id,provider" }).select("id").single();
  if (error || !provider) {
    return NextResponse.json({ error: error?.message ?? "Could not save" }, { status: 400 });
  }

  // Mirror the live pay target onto isp_settings. The captive portal is
  // anonymous and reads that table, so this is how the customer ever sees which
  // number to pay. Written here rather than in a trigger because this is the only
  // place an ISP declares the target, and both tables are written in one request
  // so they cannot disagree at the moment the operator saves.
  //
  // Cleared to null when the ISP sets the method back to "Not set yet" — a stale
  // number on a public page is worse than no number.
  const { data: existing } = await svc.from("isp_settings")
    .select("isp_id").eq("isp_id", a.ok.ispId).maybeSingle();
  if (existing) {
    await svc.from("isp_settings").update({
      pay_method: target.method,
      pay_number: target.method === "till" ? target.till : target.paybill,
    }).eq("isp_id", a.ok.ispId);
  }

  // ISP-scoped audit trail (audit_logs, not the Super Admin platform log).
  // Nothing secret is ever recorded here — the ISP supplies no secret.
  await svc.from("audit_logs").insert({
    actor_id: a.ok.user.id, actor_type: "user", isp_id: a.ok.ispId,
    action: "payment_provider_updated", resource: "payment_providers",
    resource_id: (provider as { id: string }).id,
    metadata: {
      provider: "daraja", payment_method: target.method,
      collects_into: target.method === "till" ? target.till : target.paybill,
    },
  });

  return NextResponse.json({
    ok: true,
    payment_method: target.method,
    collects_into: target.method === "till" ? target.till : target.paybill,
    stk_push: live ? "on" : "off",
    platform_app_configured: platform !== null,
    environment: platform?.environment ?? null,
    warning: target.method && !platform
      ? "Saved. NETPID has not finished setting up M-Pesa yet, so payments will not "
        + "go through until the platform app is live. Your number is saved."
      : null,
  });
}
