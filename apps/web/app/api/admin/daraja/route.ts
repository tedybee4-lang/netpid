import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/admin-auth";
import { checkRateLimit, decryptSecret, encryptSecret } from "@/lib/secrets";
import { verifyDarajaCreds } from "@/lib/daraja-push";
import { z } from "zod";

// Super Admin: NETPID's single Daraja app. Super Admin only.
//
// This is the ONE set of Daraja credentials on the platform. Every ISP's STK
// push authenticates with it and names that ISP's own Till as the receiver, so
// no ISP ever has to obtain credentials from Safaricom.
//
// The envelope is encrypted with APP_ENCRYPTION_KEY and is never returned by
// any read path — GET reports only whether an app exists and which environment
// it is on, never any part of the secret.
const schema = z.object({
  consumer_key: z.string().min(4).max(256),
  consumer_secret: z.string().min(4).max(512),
  passkey: z.string().min(4).max(512),
  environment: z.enum(["sandbox", "production"]),
});

async function guard() {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }
  return null;
}

/** The environment lives inside the envelope, so reading it means decrypting. */
function readEnvironment(cred: { encrypted_secret: string } | null): string | null {
  if (!cred) return null;
  try {
    const parsed = JSON.parse(decryptSecret(cred.encrypted_secret)) as { environment?: string };
    return parsed.environment === "production" ? "production" : "sandbox";
  } catch {
    return null;
  }
}

export async function GET() {
  const denied = await guard();
  if (denied) return denied;
  const svc = createServiceClient();
  const { data: provider } = await svc.from("payment_providers")
    .select("id, status, updated_at").is("isp_id", null).eq("provider", "daraja").maybeSingle();
  if (!provider) {
    return NextResponse.json({ configured: false, environment: null, status: null, isps_collecting: 0 });
  }
  const { data: cred } = await svc.from("payment_provider_credentials")
    .select("encrypted_secret").eq("provider_id", (provider as { id: string }).id).maybeSingle();
  const { data: isps } = await svc.from("payment_providers")
    .select("isp_id, status").not("isp_id", "is", null).eq("provider", "daraja");
  return NextResponse.json({
    configured: Boolean(cred),
    status: (provider as { status: string }).status,
    updated_at: (provider as { updated_at: string }).updated_at,
    // Not a secret, and the operator needs it: a sandbox app collects real
    // customer prompts into a Safaricom test account.
    environment: readEnvironment((cred as { encrypted_secret: string } | null) ?? null),
    isps_collecting: (isps ?? []).filter((i) => (i as { status: string }).status === "active").length,
  });
}

export async function POST(req: Request) {
  const denied = await guard();
  if (denied) return denied;
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Enter all four fields." }, { status: 400 });
  }
  const d = parsed.data;
  const svc = createServiceClient();

  const allowed = await checkRateLimit(svc, svc, "platform-daraja-save", 10, 3600);
  if (!allowed) return NextResponse.json({ error: "Rate limited." }, { status: 429 });

  // Prove the credentials against Daraja BEFORE storing them. A saved-but-
  // unverified secret would make every ISP's portal offer a push that fails,
  // for all of them at once.
  const candidate = {
    consumer_key: d.consumer_key.trim(),
    consumer_secret: d.consumer_secret.trim(),
    passkey: d.passkey.trim(),
    // verifyDarajaCreds only performs the OAuth handshake. A shortcode is never
    // sent, so the placeholder here never reaches Safaricom and cannot be
    // mistaken for a collection target.
    shortcode: "0",
    environment: d.environment,
  };
  try {
    await verifyDarajaCreds(candidate);
  } catch (e) {
    return NextResponse.json({
      error: `Daraja rejected these credentials: ${e instanceof Error ? e.message : "unknown error"}`,
    }, { status: 400 });
  }

  let encrypted: string;
  try {
    const { consumer_key, consumer_secret, passkey, environment } = candidate;
    encrypted = encryptSecret(JSON.stringify({ consumer_key, consumer_secret, passkey, environment }));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Encryption failed" }, { status: 500 });
  }

  // One app, one row. The partial unique index added in 0044 makes a second
  // platform daraja row impossible, so this upsert can never fork. A partial
  // index cannot be an arbiter, so the existing row is fetched and updated.
  const { data: existing } = await svc.from("payment_providers")
    .select("id").is("isp_id", null).eq("provider", "daraja").maybeSingle();
  let providerId: string;
  if (existing) {
    providerId = (existing as { id: string }).id;
    await svc.from("payment_providers")
      .update({ status: "active", till_number: null, paybill: null, payment_method: null })
      .eq("id", providerId);
  } else {
    const { data: created, error } = await svc.from("payment_providers").insert({
      isp_id: null, provider: "daraja",
      till_number: null, paybill: null, payment_method: null,
      status: "active",
    }).select("id").single();
    if (error || !created) {
      return NextResponse.json({ error: error?.message ?? "Could not save" }, { status: 400 });
    }
    providerId = (created as { id: string }).id;
  }

  await svc.from("payment_provider_credentials").upsert({
    provider_id: providerId,
    encrypted_secret: encrypted, key_version: 1,
  }, { onConflict: "provider_id" });

  // ISPs whose Till is already declared were parked at 'disabled' because there
  // was no app to collect with. There is one now, so they start collecting.
  // This flips every ISP's portal live at once, so it is recorded in the
  // platform audit log.
  const { data: waiting } = await svc.from("payment_providers")
    .select("isp_id").not("isp_id", "is", null).eq("provider", "daraja").eq("status", "disabled");
  const activatable = (waiting ?? []).filter((w) => w.isp_id);
  if (activatable.length) {
    await svc.from("payment_providers")
      .update({ status: "active" })
      .not("isp_id", "is", null).eq("provider", "daraja").eq("status", "disabled")
      .not("till_number", "is", null);
  }

  return NextResponse.json({
    ok: true, environment: d.environment, activated: activatable.length,
  });
}
