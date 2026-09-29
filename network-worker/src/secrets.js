import crypto from "crypto";
const KEY = process.env.APP_ENCRYPTION_KEY ?? "";

function key() {
  if (!KEY) throw new Error("APP_ENCRYPTION_KEY not configured");
  const k = Buffer.from(KEY, "base64");
  if (k.length !== 32) throw new Error("APP_ENCRYPTION_KEY must be 32 bytes base64");
  return k;
}

// AES-256-GCM envelope: v1:<iv>:<ciphertext>:<tag> (all base64).
// Must stay byte-compatible with apps/web/lib/secrets.ts — the app writes the
// router credentials that this worker later has to decrypt.
export function encryptSecret(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64")}:${ct.toString("base64")}:${cipher.getAuthTag().toString("base64")}`;
}

export function decryptSecret(envelope) {
  const k = key();
  const [v, ivB, ctB, tagB] = String(envelope).split(":");
  if (v !== "v1") throw new Error("unknown key version");
  const decipher = crypto.createDecipheriv("aes-256-gcm", k, Buffer.from(ivB, "base64"));
  decipher.setAuthTag(Buffer.from(tagB, "base64"));
  return decipher.update(Buffer.from(ctB, "base64"), undefined, "utf8") + decipher.final("utf8");
}

export function randomSecret(bytes = 24) {
  return crypto.randomBytes(bytes).toString("base64url");
}

