import crypto from "crypto";

const KEY = process.env.APP_ENCRYPTION_KEY ?? "";

// AES-256-GCM envelope: v1:<iv>:<ciphertext>:<tag> (all base64).
// Server/worker only — never ship to the browser.
export function encryptSecret(plaintext: string): string {
  if (!KEY) throw new Error("APP_ENCRYPTION_KEY not configured");
  const key = Buffer.from(KEY, "base64");
  if (key.length !== 32) throw new Error("APP_ENCRYPTION_KEY must be 32 bytes base64");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${ct.toString("base64")}:${tag.toString("base64")}`;
}

export function decryptSecret(envelope: string): string {
  if (!KEY) throw new Error("APP_ENCRYPTION_KEY not configured");
  const key = Buffer.from(KEY, "base64");
  const [v, ivB, ctB, tagB] = envelope.split(":");
  if (v !== "v1") throw new Error("unknown key version");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB, "base64"));
  decipher.setAuthTag(Buffer.from(tagB, "base64"));
  return decipher.update(Buffer.from(ctB, "base64"), undefined, "utf8") + decipher.final("utf8");
}

export function randomSecret(bytes = 24): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

// DB-backed sliding-window rate limit. Returns true if allowed.
export async function checkRateLimit(
  svc: { from: (t: string) => Record<string, (...a: never[]) => unknown> } | never,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  key: string, limit: number, windowSec: number
): Promise<boolean> {
  void svc;
  const now = new Date();
  const { data } = await client.from("rate_limits").select("*").eq("key", key).maybeSingle();
  if (!data || now.getTime() - new Date(data.window_start).getTime() > windowSec * 1000) {
    await client.from("rate_limits").upsert({ key, window_start: now.toISOString(), count: 1 }, { onConflict: "key" });
    return true;
  }
  if ((data.count as number) >= limit) return false;
  await client.from("rate_limits").update({ count: (data.count as number) + 1 }).eq("key", key);
  return true;
}
