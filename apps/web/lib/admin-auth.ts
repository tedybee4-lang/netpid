import crypto from "crypto";
import { cookies } from "next/headers";

// NETPID super-admin access — a separate credential path from Supabase Auth.
//
// WHY THIS EXISTS SEPARATELY
//   An ISP operator must be able to reach the platform console even when
//   Supabase is unreachable, and the operator has asked for one fixed
//   credential rather than an invited admin account. So this is a local
//   credential, not an auth.users row, and it deliberately does not share a
//   session with the ISP dashboard.
//
// WHY THE PASSWORD IS A HASH HERE
//   The credential is fixed, so a scrypt hash is stored rather than the
//   plaintext. The password still works (the operator types the same string);
//   what changes is that the repository does not contain a readable secret for
//   anyone who clones it. Comparison is constant-time so a wrong password
//   cannot be recovered a byte at a time.
const ADMIN_USER = "BRIAN123";
const ADMIN_SALT = "netpid-admin-v1";
const ADMIN_PASSWORD_HASH =
  "b1b83a766f049e80dbf6a26be1607b2984743706adc55f453d9b017f366fe419";

const COOKIE = "netpid_admin_session";
const MAX_AGE_SEC = 60 * 60 * 8; // an 8-hour admin shift

function hashPassword(password: string): Buffer {
  return crypto.scryptSync(password, ADMIN_SALT, 32);
}

/** Constant-time credential check. Both sides are hashed to a fixed length. */
export function verifyAdminCredentials(user: string, password: string): boolean {
  const userOk = timingSafeEqual(
    crypto.createHash("sha256").update(user).digest(),
    crypto.createHash("sha256").update(ADMIN_USER).digest(),
  );
  const passOk = timingSafeEqual(hashPassword(password), Buffer.from(ADMIN_PASSWORD_HASH, "hex"));
  return userOk && passOk;
}

function timingSafeEqual(a: Buffer, b: Buffer): boolean {
  // Equal lengths are guaranteed by both callers hashing first; the guard is
  // here so a future caller cannot make this throw instead of returning false.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** The session secret falls back to a fixed dev value so a local run works. */
function sessionSecret(): string {
  return process.env.ADMIN_SESSION_SECRET ?? "netpid-admin-session-dev-secret";
}

/** Signed, expiring session token: <expiryMs>.<hmac>. */
export function createAdminToken(): string {
  const exp = Date.now() + MAX_AGE_SEC * 1000;
  const sig = crypto.createHmac("sha256", sessionSecret()).update(String(exp)).digest("hex");
  return `${exp}.${sig}`;
}

export function verifyAdminToken(token: string | undefined | null): boolean {
  if (!token) return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig) return false;
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  const expected = crypto.createHmac("sha256", sessionSecret()).update(exp).digest("hex");
  return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

export async function setAdminSession() {
  const store = await cookies();
  store.set(COOKIE, createAdminToken(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE_SEC,
  });
}

export async function clearAdminSession() {
  const store = await cookies();
  store.set(COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
}

export async function isAdmin(): Promise<boolean> {
  const store = await cookies();
  return verifyAdminToken(store.get(COOKIE)?.value);
}
