// Direct Safaricom Daraja (STK Push + callback). Server-only: reads the
// PLATFORM credential envelope encrypted with APP_ENCRYPTION_KEY.
//
// NETPID runs ONE Daraja app (migration 0044). An ISP never holds credentials —
// they declare only the Till/PayBill they own, and that number is what the push
// collects into. Auth is the platform's; the target is the ISP's. Those are two
// different numbers and conflating them is what previously sent customer money
// into a Daraja sandbox account.
import { createServiceClient } from "@/lib/supabase/server";
import { decryptSecret } from "@/lib/secrets";

export type DarajaCreds = {
  consumer_key: string;
  consumer_secret: string;
  passkey: string;
  shortcode: string;
  environment: "sandbox" | "production";
};

/** The platform app. It authenticates; it never names a collection target. */
export type PlatformDaraja = Omit<DarajaCreds, "shortcode">;

/** What an ISP declared they want to be paid into. */
export type IspPayTarget = {
  shortcode: string;
  method: "till" | "paybill";
  number: string;
};

/** Normalize a KE phone to 254XXXXXXXXX. Null when not a KE number. */
export function normalizeKe(phone: string): string | null {
  const d = String(phone ?? "").replace(/\D/g, "");
  if (/^254\d{9}$/.test(d)) return d;
  if (/^0\d{9}$/.test(d)) return `254${d.slice(1)}`;
  if (/^\d{9}$/.test(d)) return `254${d}`;
  return null;
}

/**
 * The single platform Daraja app. Null until a Super Admin has configured it.
 * An ISP can never satisfy this — they have no envelope, and that is the point.
 */
export async function getPlatformDaraja(): Promise<PlatformDaraja | null> {
  const svc = createServiceClient();
  const { data: provider } = await svc.from("payment_providers")
    .select("id, status").is("isp_id", null).eq("provider", "daraja")
    .eq("status", "active").maybeSingle();
  if (!provider) return null;
  const { data: cred } = await svc.from("payment_provider_credentials")
    .select("encrypted_secret").eq("provider_id", (provider as { id: string }).id).maybeSingle();
  const env = (cred as { encrypted_secret: string } | null)?.encrypted_secret;
  if (!env) return null;
  try {
    const parsed = JSON.parse(decryptSecret(env)) as Partial<PlatformDaraja>;
    if (!parsed.consumer_key || !parsed.consumer_secret || !parsed.passkey) return null;
    return {
      consumer_key: parsed.consumer_key,
      consumer_secret: parsed.consumer_secret,
      passkey: parsed.passkey,
      environment: parsed.environment === "production" ? "production" : "sandbox",
    };
  } catch {
    return null;
  }
}

/**
 * The Till/PayBill an ISP declared, and therefore the number a STK push to them
 * collects into. Requires the ISP row to be active: an operator who disabled
 * payments must stop receiving pushes even if their Till is still on file.
 */
export async function getIspPayTarget(ispId: string): Promise<IspPayTarget | null> {
  const svc = createServiceClient();
  const { data } = await svc.from("payment_providers")
    .select("payment_method, till_number, paybill, status")
    .eq("isp_id", ispId).eq("provider", "daraja").eq("status", "active").maybeSingle();
  const row = data as {
    payment_method: "till" | "paybill" | null;
    till_number: string | null; paybill: string | null; status: string;
  } | null;
  if (!row) return null;
  const method = row.payment_method ?? (row.till_number ? "till" : row.paybill ? "paybill" : null);
  if (!method) return null;
  const number = (method === "till" ? row.till_number : row.paybill)?.trim() ?? "";
  if (!number) return null;
  return { shortcode: number, method, number };
}

/**
 * Everything a push needs: the platform authenticates, the ISP's Till is the
 * target. Every existing call site (staff STK, status query, portal) uses this
 * and is unchanged by the move to a single app.
 */
export async function getDarajaCreds(ispId: string): Promise<DarajaCreds | null> {
  const [platform, target] = await Promise.all([getPlatformDaraja(), getIspPayTarget(ispId)]);
  if (!platform || !target) return null;
  return { ...platform, shortcode: target.shortcode };
}
