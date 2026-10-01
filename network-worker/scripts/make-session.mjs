/**
 * Create a provisioning session directly, bypassing the dashboard, so the live
 * round trip can be verified without an ISP session.
 *
 * Writes ONLY a session row and a token hash. No router is modified.
 *
 * Run: node scripts/make-session.mjs <baseUrl> <routerId> <ispId>
 * Prints the plaintext token ONCE, to stdout, so it is never written to disk.
 */
import { createHash, randomBytes } from "node:crypto";

const [, , base, routerId, ispId] = process.argv;
if (!base || !routerId || !ispId) {
  console.error("usage: node scripts/make-session.mjs <baseUrl> <routerId> <ispId>");
  process.exit(2);
}

const token = randomBytes(32).toString("base64url");
const hash = createHash("sha256").update(token, "utf8").digest("hex");
const expires = new Date(Date.now() + 30 * 60_000).toISOString();

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to create a session");
  process.exit(2);
}

const res = await fetch(`${url}/rest/v1/router_provisioning_sessions`, {
  method: "POST",
  headers: {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "content-type": "application/json",
    prefer: "return=representation",
  },
  body: JSON.stringify({
    isp_id: ispId,
    router_id: routerId,
    token_hash: hash,
    status: "PENDING",
    expires_at: expires,
  }),
});

const body = await res.json();
if (!res.ok) {
  console.error("insert failed:", JSON.stringify(body));
  process.exit(1);
}

// The plaintext token exists only in this process's memory and stdout.
console.log(JSON.stringify({ id: body[0].id, token, expires_at: expires }));
