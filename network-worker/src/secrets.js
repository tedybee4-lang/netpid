import crypto from "crypto";
const KEY = process.env.APP_ENCRYPTION_KEY ?? "";
export function decryptSecret(envelope) {
  if (!KEY) throw new Error("APP_ENCRYPTION_KEY not configured");
  const key = Buffer.from(KEY, "base64");
  const [v, ivB, ctB, tagB] = envelope.split(":");
  if (v !== "v1") throw new Error("unknown key version");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB, "base64"));
  decipher.setAuthTag(Buffer.from(tagB, "base64"));
  return decipher.update(Buffer.from(ctB, "base64"), undefined, "utf8") + decipher.final("utf8");
}
