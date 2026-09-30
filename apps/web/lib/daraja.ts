// Direct Safaricom Daraja (STK Push + callback). Server-only: reads the
// per-ISP credential envelope encrypted with APP_ENCRYPTION_KEY.
import { createServiceClient } from "@/lib/supabase/server";
import { decryptSecret } from "@/lib/secrets";

export type DarajaCreds = {
  consumer_key: string;
  consumer_secret: string;
  passkey: string;
  shortcode: string;
  environment: "sandbox" | "production";
};

/** Normalize a KE phone to 254XXXXXXXXX. Null when not a KE number. */
export function normalizeKe(phone: string): string | null {
  const d = String(phone ?? "").replace(/\D/g, "");
  if (/^254\d{9}$/.test(d)) return d;
  if (/^0\d{9}$/.test(d)) return `254${d.slice(1)}`;
  if (/^\d{9}$/.test(d)) return `254${d}`;
  return null;
}

/** Load + decrypt the Daraja envelope for an ISP. Null when not configured. */
export async function getDarajaCreds(ispId: string): Promise<DarajaCreds | null> {
  const svc = createServiceClient();
  const { data: provider } = await svc.from("payment_providers").select("id")
    .eq("isp_id", ispId).eq("provider", "daraja").eq("status", "active").maybeSingle();
  if (!provider) return null;
  const { data: cred } = await svc.from("payment_provider_credentials")
    .select("encrypted_secret").eq("provider_id", (provider as { id: string }).id).maybeSingle();
  const env = (cred as { encrypted_secret: string } | null)?.encrypted_secret;
  if (!env) return null;
  try {
    const parsed = JSON.parse(decryptSecret(env)) as Partial<DarajaCreds>;
    if (!parsed.consumer_key || !parsed.consumer_secret || !parsed.passkey || !parsed.shortcode) return null;
    return {
      consumer_key: parsed.consumer_key,
      consumer_secret: parsed.consumer_secret,
      passkey: parsed.passkey,
      shortcode: parsed.shortcode,
      environment: parsed.environment === "production" ? "production" : "sandbox",
    };
  } catch {
    return null;
  }
}
