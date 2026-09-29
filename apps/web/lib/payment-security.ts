import crypto from "crypto";
import { createClient } from "@/lib/supabase/server";

export function verifyPayheroSignature(
  raw: string,
  signature: string | null
): boolean {
  const secret = process.env.PAYHERO_WEBHOOK_SECRET ?? "";

  if (!secret || !signature) {
    return false;
  }

  const h = crypto
    .createHmac("sha256", secret)
    .update(raw)
    .digest("hex");

  if (h.length !== signature.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(h),
    Buffer.from(signature)
  );
}

export async function logSecurity(
  kind: string,
  detail: Record<string, unknown>
) {
  try {
    const supabase = await createClient();
    await supabase
      .from("security_events")
      .insert({ kind, detail });
  } catch {
    // Never fail webhook on logging.
  }
}
