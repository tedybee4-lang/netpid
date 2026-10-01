import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { checkRateLimit, encryptSecret } from "@/lib/secrets";
import { verifyDarajaCreds } from "@/lib/daraja-push";
import { resolveIsp } from "@/lib/isp";
import { z } from "zod";

// ISP admin: payment settings. The envelope is encrypted server-side with
// APP_ENCRYPTION_KEY and never returned by any read path.
//
// AN ISP ONLY NEEDS A TILL OR A PAYBILL NUMBER. That is what most Kenyan ISPs
// actually run: customers walk to a till, pay, and type the receipt back in.
// The Daraja credentials below are what enable STK Push, which is a different,
// optional product. Requiring them made the one thing every operator needs
// impossible to save, so they are all optional and are only read when supplied.
const schema = z.object({
  consumer_key: z.string().max(256).optional().or(z.literal("")),
  consumer_secret: z.string().max(512).optional().or(z.literal("")),
  passkey: z.string().max(512).optional().or(z.literal("")),
  shortcode: z.string().max(20).optional().or(z.literal("")),
  environment: z.enum(["sandbox", "production"]).default("sandbox"),
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
  const { data: providers } = await svc.from("payment_providers")
    .select("id, provider, account_name, paybill, till_number, callback_url, status, payment_method")
    .eq("isp_id", a.ok.ispId);
  // Configured flags only — never secrets.
  const rows = (providers ?? []).map((p) => {
    const row = p as { provider: string; status: string; paybill: string | null; till_number: string | null; callback_url: string | null; payment_method: string | null };
    return {
      provider: row.provider, status: row.status,
      paybill: row.paybill, till_number: row.till_number, callback_url: row.callback_url,
      payment_method: row.payment_method ?? (row.till_number ? "till" : row.paybill ? "paybill" : null),
    };
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

  // One live pay-in target, not two. Resolve before anything is written so a
  // half-valid pair never reaches the table.
  const target = resolvePayTarget(d);
  if (target.error) return NextResponse.json({ error: target.error }, { status: 400 });

  const allowed = await checkRateLimit(svc, svc, `daraja-save:${a.ok.ispId}`, 10, 3600);
  if (!allowed) return NextResponse.json({ error: "Rate limited." }, { status: 429 });

  // The Daraja credentials are OPTIONAL. They enable STK Push; they are not
  // needed to take payments at a till. A partial set is treated as none, so a
  // half-filled form cannot produce a provider that looks connected but 502s on
  // every push.
  const supplied = {
    consumer_key: (d.consumer_key ?? "").trim(),
    consumer_secret: (d.consumer_secret ?? "").trim(),
    passkey: (d.passkey ?? "").trim(),
    shortcode: (d.shortcode ?? "").trim(),
  };
  const given = Object.values(supplied).filter(Boolean).length;
  const hasCreds = given === 4;
  if (given > 0 && given < 4) {
    return NextResponse.json({
      error: "Fill in all four Daraja fields or none of them. Leaving one blank "
        + "would save a half-configured app that fails on every STK push.",
    }, { status: 400 });
  }
  if (!hasCreds && !target.method) {
    return NextResponse.json({
      error: "Enter the Till or PayBill number your customers pay to.",
    }, { status: 400 });
  }

  // Daraja collects STK Push money into the Till/PayBill its app was ISSUED
  // for: sendStkPush uses the stored shortcode as both BusinessShortCode and
  // PartyB, and the declared till_number is never sent to Safaricom at all.
  //
  // So a shortcode that differs from the ISP's live pay target is not a
  // cosmetic mismatch - it silently routes every customer payment into a
  // different account, which is how an ISP ends up with a working portal and
  // an empty till. Reject it here rather than letting it reach Safaricom.
  const declaredNumber = target.method === "till" ? target.till : target.paybill;
  if (hasCreds && declaredNumber && supplied.shortcode !== declaredNumber) {
    return NextResponse.json({
      error: `Your Daraja app was issued for shortcode ${supplied.shortcode}, but your `
        + `${target.method === "till" ? "Till" : "PayBill"} is ${declaredNumber}. Daraja pays `
        + `STK Push money into the number its app was issued for, so customers would pay `
        + `${supplied.shortcode} and never ${declaredNumber}. Make them the same number, or `
        + `leave the Daraja fields blank and take payments at your till.`,
    }, { status: 400 });
  }

  // Prove the credentials against Daraja BEFORE marking the provider active.
  // A saved-but-unverified secret is how an ISP ends up with a "connected"
  // badge and a 502 on every STK push, so 'active' is reserved for credentials
  // Safaricom has actually accepted.
  const candidate = { ...supplied, environment: d.environment };
  let verified = false;
  let warning: string | null = null;
  if (hasCreds) {
    verified = true;
    try {
      await verifyDarajaCreds(candidate);
    } catch (e) {
      verified = false;
      warning = e instanceof Error ? e.message : "Daraja rejected the credentials";
    }
  }

  // No credentials means STK Push stays off. Manual payments against the till
  // or paybill are unaffected, which is the point: the operator keeps working.
  // STK Push state is carried over, never derived from this save. Saving a Till
  // number on its own must not turn STK on, and must not turn it off either:
  // an ISP editing their till number is not making a decision about Daraja.
  // The previous "envelope exists -> force active" rule was actively harmful:
  // it re-enabled STK Push against a stale sandbox app, routing customer money
  // to Safaricom's test account every time the ISP saved their own till.
  const { data: priorProvider } = await svc.from("payment_providers")
    .select("id, status").eq("isp_id", a.ok.ispId).eq("provider", "daraja").maybeSingle();

  const { data: provider, error } = await svc.from("payment_providers").upsert({
    isp_id: a.ok.ispId, provider: "daraja",
    payment_method: target.method, till_number: target.till, paybill: target.paybill,
    status: hasCreds ? (verified ? "active" : "disabled") : (priorProvider?.status ?? "disabled"),
  }, { onConflict: "isp_id,provider" }).select("id").single();
  if (error || !provider) {
    return NextResponse.json({ error: error?.message ?? "Could not save" }, { status: 400 });
  }

  // The envelope is only written when credentials were actually supplied. An
  // ISP running on a till must not have a row implying a Daraja app exists.
  if (hasCreds) {
    let encrypted: string;
    try {
      encrypted = encryptSecret(JSON.stringify(candidate));
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Encryption failed" }, { status: 500 });
    }
    await svc.from("payment_provider_credentials").upsert({
      provider_id: (provider as { id: string }).id,
      encrypted_secret: encrypted, key_version: 1,
    }, { onConflict: "provider_id" });
  }

  // Mirror the live pay target onto isp_settings. The captive portal is
  // anonymous and reads that table, so this is how the customer ever sees which
  // number to pay. Written here rather than in a trigger because this is the only
  // place an ISP declares the target, and both tables are written in one request
  // so they cannot disagree at the moment the operator saves.
  //
  // Cleared to null when the ISP sets the method back to "Not set yet" — a stale
  // number on a public page is worse than no number.
  if (a.ok.ispId) {
    const { data: existing } = await svc.from("isp_settings")
      .select("isp_id").eq("isp_id", a.ok.ispId).maybeSingle();
    if (existing) {
      await svc.from("isp_settings").update({
        pay_method: target.method,
        pay_number: target.method === "till" ? target.till : target.paybill,
      }).eq("isp_id", a.ok.ispId);
    }
  }

  // ISP-scoped audit trail (audit_logs, not the Super Admin platform log).
  // Metadata records the outcome only — never any part of the secret.
  await svc.from("audit_logs").insert({
    actor_id: a.ok.user.id, actor_type: "user", isp_id: a.ok.ispId,
    action: "payment_provider_updated", resource: "payment_providers",
    resource_id: (provider as { id: string }).id,
    metadata: { provider: "daraja", environment: d.environment, verified },
  });

  return NextResponse.json({
    ok: true,
    // null, not false, when no credentials were supplied. "false" would claim
    // Safaricom rejected something that was never sent, and the client shows
    // a rejection error on it.
    verified: hasCreds ? verified : null,
    credentials_stored: hasCreds,
    environment: d.environment,
    stk_push: hasCreds ? (verified ? "on" : "off") : "off",
    // The number customer money actually lands in. For STK Push this is the
    // shortcode, NOT the declared till - showing the till here would be a lie.
    collects_into: hasCreds ? supplied.shortcode : declaredNumber,
    manual_pay_number: declaredNumber,
    // Sandbox routes every push to a Safaricom test account. No real money
    // moves, so the operator has to be told rather than left to discover it
    // from a customer's M-Pesa prompt.
    test_mode: d.environment === "sandbox",
    warning: hasCreds
      ? (verified
        ? (d.environment === "sandbox"
          ? `STK Push is connected in SANDBOX. Customers approving this prompt pay `
            + `${supplied.shortcode} in Safaricom's test account - no real money reaches `
            + `you. Switch to production to take real payments.`
          : null)
        : `Saved, but Daraja refused the credentials so STK Push stays off: ${warning}`)
      : null,
  });
}
