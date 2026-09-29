// Verify the authenticated half of the web app: /dashboard/* and the guarded
// API routes. Public pages are easy to curl; these are not, because the guard is
// an @supabase/ssr session cookie plus RLS. This mints that cookie exactly the
// way the app writes it, then reports what each route actually returned.
//
// Cookie format (verified against @supabase/ssr 0.5.2, dist/main/cookies.js):
//   name  = sb-<project-ref>-auth-token     (supabase-js default storage key)
//   value = "base64-" + base64url(JSON.stringify(session))
//   encoded value over 3180 chars is chunked into <name>.0, <name>.1, ...
//
// The cookie must hold a real session, so this signs in through GoTrue with a
// real (confirmed) user instead of forging a token.
//
// Usage:
//   node scripts/smoke-auth.mjs --provision     create the test user + membership
//   node scripts/smoke-auth.mjs                check /dashboard/* + guarded APIs
//   node scripts/smoke-auth.mjs --cleanup      delete the test user again
//
// Options:
//   --base <url>        app origin             (default http://localhost:3000)
//   --isp <slug>        ISP to join            (default lipanet)
//   --email <address>   test login             (default netpid-smoke@example.com)
//   --password <secret> test login password    (default generated on provision)
//   --timeout <ms>      per-request budget     (default 900000 = dev-mode compile)
//
// Exit code 0 = every route behaved, 1 = a route failed, 2 = usage/env problem.
// `--cleanup` deletes only the test user; its isp_users row cascades away.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = path.join(ROOT, "apps", "web", ".env.local");

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith("--")) continue;
  const key = a.slice(2);
  const next = process.argv[i + 1];
  if (next && !next.startsWith("--")) { args[key] = next; i++; } else { args[key] = true; }
}

function loadEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith("#")) continue;
    const eq = text.indexOf("=");
    if (eq < 1) continue;
    out[text.slice(0, eq).trim()] = text.slice(eq + 1).trim();
  }
  return out;
}

const env = { ...loadEnv(ENV_PATH), ...process.env };
const URL_BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const APP = args.base ?? "http://localhost:3000";
const ISP_SLUG = args.isp ?? "lipanet";
const EMAIL = args.email ?? "netpid-smoke@example.com";
const PASSWORD = args.password ?? "netpid-smoke-4f19c2";
const TIMEOUT_MS = Number(args.timeout ?? 900000);

if (!URL_BASE || !ANON || !SERVICE) {
  console.error(`missing NEXT_PUBLIC_SUPABASE_URL / ANON_KEY / SERVICE_ROLE_KEY`);
  console.error(`looked in ${ENV_PATH} (and the process environment)`);
  process.exitCode = 2;
}

const PROJECT_REF = URL_BASE ? new URL(URL_BASE).hostname.split(".")[0] : "unknown";
const COOKIE_NAME = `sb-${PROJECT_REF}-auth-token`;

// Mirrors @supabase/ssr's stringToBase64URL (no padding, "-_" alphabet), which
// is what Node's "base64url" encoding produces.
function base64url(str) {
  return Buffer.from(str, "utf8").toString("base64url");
}

// Mirrors @supabase/ssr's createChunks: chunking happens on the percent-encoded
// value and never splits an escape sequence or a unicode boundary.
const MAX_CHUNK_SIZE = 3180;
function createChunks(key, value) {
  let encodedValue = encodeURIComponent(value);
  if (encodedValue.length <= MAX_CHUNK_SIZE) return [{ name: key, value }];
  const chunks = [];
  while (encodedValue.length > 0) {
    let head = encodedValue.slice(0, MAX_CHUNK_SIZE);
    const lastEscapePos = head.lastIndexOf("%");
    if (lastEscapePos > MAX_CHUNK_SIZE - 3) head = head.slice(0, lastEscapePos);
    let valueHead = "";
    while (head.length > 0) {
      try { valueHead = decodeURIComponent(head); break; }
      catch (error) {
        if (error instanceof URIError && head.at(-3) === "%" && head.length > 3) {
          head = head.slice(0, head.length - 3);
        } else { throw error; }
      }
    }
    chunks.push(valueHead);
    encodedValue = encodedValue.slice(head.length);
  }
  return chunks.map((value, i) => ({ name: `${key}.${i}`, value }));
}

function cookieHeader(session) {
  const encoded = `base64-${base64url(JSON.stringify(session))}`;
  const chunks = createChunks(COOKIE_NAME, encoded);
  return { header: chunks.map((c) => `${c.name}=${c.value}`).join("; "), chunks: chunks.length };
}

// GoTrue (auth) and PostgREST (data) share this host; only the key differs.
async function api(pathname, { method = "GET", key = SERVICE, body, headers = {} } = {}) {
  const res = await fetch(`${URL_BASE}${pathname}`, {
    method,
    headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
  return { res, json, text };
}

async function signIn() {
  const { res, json } = await api("/auth/v1/token?grant_type=password", {
    method: "POST", key: ANON, body: { email: EMAIL, password: PASSWORD },
  });
  if (!res.ok) throw new Error(`sign-in failed: ${res.status} ${json?.error_code ?? json?.msg ?? ""}`);
  if (!json?.access_token || !json?.refresh_token) throw new Error("sign-in returned no session");
  return json;
}

async function findUser() {
  const { json } = await api("/auth/v1/admin/users?page=1&per_page=200");
  const users = json?.users ?? [];
  return users.find((u) => (u.email ?? "").toLowerCase() === EMAIL.toLowerCase()) ?? null;
}

async function isp() {
  const { json } = await api(`/rest/v1/isps?slug=eq.${ISP_SLUG}&select=id,name,slug,status,subscription_status`);
  const row = json?.[0];
  if (!row) throw new Error(`no ISP with slug "${ISP_SLUG}"`);
  return row;
}

async function provision() {
  const target = await isp();
  console.log(`ISP: ${target.name} (${target.slug}) status=${target.status} subscription=${target.subscription_status}`);

  let user = await findUser();
  if (user) {
    // Reset the password so the default credentials are always the valid ones.
    const updated = await api(`/auth/v1/admin/users/${user.id}`, {
      method: "PUT", body: { password: PASSWORD, email_confirm: true },
    });
    if (!updated.res.ok) throw new Error(`password reset failed: ${updated.res.status} ${updated.text.slice(0, 300)}`);
    console.log(`user exists: ${user.email} (${user.id}) - password reset`);
  } else {
    const created = await api("/auth/v1/admin/users", {
      method: "POST",
      body: {
        email: EMAIL, password: PASSWORD, email_confirm: true,
        user_metadata: { full_name: "NETPID Smoke Test" },
      },
    });
    if (!created.res.ok) throw new Error(`create user failed: ${created.res.status} ${created.text.slice(0, 300)}`);
    user = created.json;
    console.log(`created user: ${user.email} (${user.id})`);
  }

  const membership = await api("/rest/v1/isp_users?on_conflict=isp_id,user_id", {
    method: "POST",
    headers: { prefer: "resolution=merge-duplicates,return=representation" },
    body: { isp_id: target.id, user_id: user.id, full_name: "NETPID Smoke Test", is_active: true },
  });
  const row = membership.json?.[0];
  if (!membership.res.ok || !row) {
    throw new Error(`membership failed: ${membership.res.status} ${membership.text.slice(0, 300)}`);
  }
  console.log(`membership: isp_users ${row.id} isp_id=${row.isp_id} is_active=${row.is_active}`);

  const role = await api("/rest/v1/isp_roles?slug=eq.owner&select=id,slug");
  const roleId = role.json?.[0]?.id;
  if (!roleId) throw new Error('role "owner" is not seeded - run supabase/seed.sql');
  const grant = await api("/rest/v1/isp_user_roles?on_conflict=isp_user_id,role_id", {
    method: "POST",
    headers: { prefer: "resolution=ignore-duplicates,return=minimal" },
    body: { isp_user_id: row.id, role_id: roleId },
  });
  if (!grant.res.ok) throw new Error(`role grant failed: ${grant.res.status} ${grant.text.slice(0, 300)}`);
  console.log("role: owner granted");
  console.log(`login: ${EMAIL} / ${PASSWORD}`);
}

async function cleanup() {
  const user = await findUser();
  if (!user) { console.log(`no test user "${EMAIL}" - nothing to delete`); return; }
  const deleted = await api(`/auth/v1/admin/users/${user.id}`, { method: "DELETE" });
  if (!deleted.res.ok) throw new Error(`delete failed: ${deleted.res.status} ${deleted.text.slice(0, 300)}`);
  const left = await api(`/rest/v1/isp_users?user_id=eq.${user.id}&select=id`);
  console.log(`deleted user ${user.email} (${user.id})`);
  console.log(`membership rows left: ${(left.json ?? []).length} (FK cascade)`);
}

// Guarded pages that should render for a member, plus one guarded API.
const GUARDED = [
  { path: "/dashboard", expect: 200 },
  { path: "/dashboard/customers", expect: 200 },
  { path: "/dashboard/payments", expect: 200 },
  { path: "/dashboard/radius", expect: 200 },
  { path: "/api/customers", expect: 200 },
];

async function check() {
  const target = await isp();
  const session = await signIn();
  const { header, chunks } = cookieHeader(session);
  console.log(`cookie: ${COOKIE_NAME} (${chunks} chunk(s), ${header.length} bytes)`);
  console.log(`session: ${session.user?.email} expires_at=${session.expires_at}`);

  const failures = [];
  for (const route of GUARDED) {
    const started = Date.now();
    let res;
    let body = "";
    try {
      res = await fetch(`${APP}${route.path}`, {
        headers: { cookie: header },
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      body = await res.text();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${route.path} -> ${message}`);
      console.log(`FAIL ??    ${route.path} ${message}`);
      continue;
    }
    // Dev mode answers 200 and embeds an error overlay, so inspect the body too.
    const crashed = /Application error|Unhandled Runtime Error|Internal Server Error/.test(body);
    // Pages word their empty state differently ("No data yet.", "No customers yet").
    const emptyText = body.match(/No data yet\.|No [a-z]+ yet/)?.[0] ?? "none";
    const ok = res.status === route.expect && !crashed;
    if (!ok) failures.push(`${route.path} -> ${res.status}${crashed ? " (error page in body)" : ""}`);
    console.log(
      `${ok ? "ok  " : "FAIL"} ${res.status} ${route.path} ${Date.now() - started}ms bytes=${body.length}` +
      ` emptyState="${emptyText}" ispName=${body.includes(target.name)}` +
      `${crashed ? " CRASHED" : ""}`,
    );
  }

  // The guard must still bite: no cookie at all has to redirect to /login.
  const anon = await fetch(`${APP}/dashboard`, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
  const location = anon.headers.get("location") ?? "";
  const guardOk = (anon.status === 307 || anon.status === 302) && location.includes("/login");
  if (!guardOk) failures.push(`unauthenticated /dashboard -> ${anon.status} ${location}`);
  console.log(`${guardOk ? "ok  " : "FAIL"} ${anon.status} /dashboard (no cookie) -> ${location}`);

  if (failures.length) {
    console.log(`\n${failures.length} failure(s):`);
    for (const f of failures) console.log(`  ${f}`);
    process.exitCode = 1;
  } else {
    console.log("\nOK - every guarded route rendered for an authenticated member");
  }
}

if (!URL_BASE || !ANON || !SERVICE) {
  process.exitCode = 2; // guidance was already printed above
} else {
  try {
    if (args.provision) await provision();
    else if (args.cleanup) await cleanup();
    else await check();
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
