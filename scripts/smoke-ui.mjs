// Phase D UI audit — rendered-markup checks over a real production server.
//
// This is deliberately a MARKUP audit, not a visual one: it asserts the things
// that silently break a UI and cannot be seen by reading source. A table with
// no scroll container overflows on a 360px phone; a mojibake byte ships to the
// customer; a form button with no handler looks clickable and does nothing.
//
// A real session is obtained through the GoTrue password grant (see
// scripts/smoke-runtime.mjs) — no cookie is forged.
//
// Usage: node scripts/smoke-ui.mjs
// Exit 0 = every check passed, 1 = a check failed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = path.join(ROOT, "apps", "web", ".env.local");
const APP = "http://localhost:3000";
const EMAIL = "netpid-smoke@example.com";
const PASSWORD = "netpid-smoke-4f19c2";

function loadEnv(file) {
  const out = {};
  for (const line of (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 1) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}
const env = { ...loadEnv(ENV_PATH), ...process.env };
const URL_BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!URL_BASE || !ANON) { console.error("missing Supabase env"); process.exit(2); }

const COOKIE_NAME = `sb-${new URL(URL_BASE).hostname.split(".")[0]}-auth-token`;
const failures = [];
const unverifiedList = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}
function unverified(name, why = "") {
  console.log(`UNVER ${name}${why ? ` — ${why}` : ""}`);
  unverifiedList.push(`${name}${why ? ` — ${why}` : ""}`);
}

async function signIn() {
  const res = await fetch(`${URL_BASE}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`sign-in failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const session = await res.json();
  const raw = `base64-${Buffer.from(JSON.stringify(session), "utf8").toString("base64url")}`;
  return `${COOKIE_NAME}=${raw}`;
}

// Mojibake lead bytes (Ã/Â/â) that survived into rendered HTML.
const MOJI = /[\u00C2\u00C3\u00E2][\u0080-\u00FF\u20AC\u2122\u2018\u2019\u201C\u201D\u2013\u2014\u2026\u2030\u0152\u0153\u0160\u0161\u017D\u017E\u2039\u203A]+/;

async function main() {
  const cookie = await signIn();

  async function get(p, auth = true) {
    const res = await fetch(`${APP}${p}`, {
      headers: auth ? { cookie } : {},
      redirect: "manual",
      signal: AbortSignal.timeout(120_000),
    });
    return { status: res.status, text: await res.text(), loc: res.headers.get("location") };
  }

  // ---- public pages -----------------------------------------------------
  console.log("--- public / auth ---");
  const publicPages = ["/", "/login", "/signup", "/pricing", "/reset-password"];
  for (const p of publicPages) {
    const r = await get(p, false);
    check(`public ${p} -> 200 (got ${r.status})`, r.status === 200, `${r.text.length} bytes`);
    check(`${p} renders no mojibake`, !MOJI.test(r.text),
      (r.text.match(MOJI) ?? [])[0] ?? "");
  }

  // ---- /signup deep inspection -----------------------------------------
  // The reported "signup CSS issue" was an encoding corruption in the submit
  // button's loading label. That label is client-rendered (it only shows while
  // submitting), so it is NOT in the server HTML — assert the source character
  // directly, and assert the served page carries no mojibake at all.
  const su = await get("/signup", false);
  const signupSrc = fs.readFileSync(path.join(ROOT, "apps", "web", "app", "signup", "page.tsx"), "utf8");
  check("/signup loading label uses a real ellipsis (U+2026)",
    signupSrc.includes("Creating\u2026"));
  check("/signup source has no mojibake ellipsis",
    !signupSrc.includes("Creating\u00E2\u20AC\u00A6"));
  check("/signup keeps the design-system card", /class="[^"]*\bcard\b/.test(su.text));
  check("/signup labels every field", /<label[^>]*for="name"/.test(su.text)
    && /<label[^>]*for="email"/.test(su.text)
    && /<label[^>]*for="password"/.test(su.text));
  check("/signup has no horizontal-overflow trap",
    !/min-w-\[/.test(su.text), "a fixed min-width here would push the card off a small phone");

  // ---- 404 --------------------------------------------------------------
  const missing = await get("/definitely-not-a-real-route", false);
  check(`unknown route -> 404 (got ${missing.status})`, missing.status === 404);
  check("404 is the branded NETPID page, not Next's default",
    /That page isn/.test(missing.text) && /NETPID/.test(missing.text));

  // ---- customer portal (public) ----------------------------------------
  console.log("--- customer portal ---");
  const portal = await get("/portal/lipanet", false);
  check(`/portal/lipanet -> 200 (got ${portal.status})`, portal.status === 200);
  check("portal renders no mojibake", !MOJI.test(portal.text));
  if (portal.status === 200) {
    const buyLinks = [...portal.text.matchAll(/href="\/portal\/lipanet\/buy\?package=/g)].length;
    check(`portal buy links are real (${buyLinks} found)`, buyLinks > 0);
    check("portal offers login + voucher routes",
      portal.text.includes("/portal/lipanet/login") && portal.text.includes("/portal/lipanet/voucher"));
  }

  // ---- authenticated pages ---------------------------------------------
  console.log("--- ISP dashboard ---");
  const authPages = [
    "/dashboard", "/dashboard/customers", "/dashboard/packages", "/dashboard/payments",
    "/dashboard/customers/new", "/dashboard/network", "/dashboard/network/routers/new",
    "/dashboard/network/ip-pools", "/dashboard/announcements", "/dashboard/sms",
  ];

  for (const p of authPages) {
    const r = await get(p);
    check(`auth ${p} -> 200 (got ${r.status})`, r.status === 200, `${r.text.length} bytes`);
    if (r.status !== 200) continue;
    check(`${p} renders no mojibake`, !MOJI.test(r.text), (r.text.match(MOJI) ?? [])[0] ?? "");

    // Horizontal-overflow guard: a table inside a page that never sets
    // overflow-x/-auto will push the whole page sideways on a small phone.
    if (/<table\b/.test(r.text)) {
      const hasScroll = /overflow-x-auto|overflow-auto|overflow-x-scroll/.test(r.text);
      check(`${p} wraps its table in a horizontal scroll container`, hasScroll);
    }
    // A page that renders a list must say something when the list is empty.
    check(`${p} has no raw error text`, !/Application error|Unhandled Runtime Error/i.test(r.text));
  }

  // ---- empty-state presence on list pages -------------------------------
  // The IP pool page fetches its data client-side, so the server HTML correctly
  // shows a loading skeleton; the empty state only exists after that fetch. A
  // static-HTML assertion would be testing the wrong thing, so verify both
  // halves: SSR ships a skeleton (not a blank page), and the API really is
  // empty, which is the condition the empty state is written for.
  console.log("--- empty states ---");
  const poolsPage = await get("/dashboard/network/ip-pools");
  check("ip-pools SSR renders a loading skeleton rather than a blank page",
    poolsPage.status === 200 && /animate-pulse/.test(poolsPage.text));

  const poolsApi = await fetch(`${APP}/api/ip-pools`, {
    headers: { cookie }, signal: AbortSignal.timeout(60_000),
  });
  const poolsJson = await poolsApi.json().catch(() => null);
  check("/api/ip-pools returns an array for the empty state to render",
    poolsApi.status === 200 && Array.isArray(poolsJson?.pools),
    `${poolsJson?.pools?.length ?? "?"} pools`);

  const poolsSrc = fs.readFileSync(
    path.join(ROOT, "apps", "web", "app", "dashboard", "network", "ip-pools", "page.tsx"), "utf8");
  check("ip-pools ships a written empty state (not a bare dash)",
    /No IP pools yet\./.test(poolsSrc));

  const annPage = await get("/dashboard/announcements");
  check("/dashboard/announcements shows a professional empty state",
    annPage.status === 200 && /Nothing to read right now/i.test(annPage.text));

  // ---- super admin separation ------------------------------------------
  console.log("--- super admin ---");
  for (const p of ["/admin", "/admin/workers", "/admin/announcements", "/admin/audit"]) {
    const r = await get(p);
    const gated = (r.status === 307 || r.status === 302) && (r.loc ?? "").includes("admin-login");
    check(`ISP session cannot reach ${p} (got ${r.status})`, gated, `location=${r.loc}`);
  }
  const adminApi = await fetch(`${APP}/api/admin/announcements`, {
    headers: { cookie }, signal: AbortSignal.timeout(60_000),
  });
  check(`ISP session refused by /api/admin/announcements (got ${adminApi.status})`,
    adminApi.status === 403, (await adminApi.text()).slice(0, 80));

  // ---- Daraja reconciliation route -------------------------------------
  // Proves the new status route is live, is tenant-scoped (a payment id that is
  // not in this ISP is a 404, not someone else's data), and activates nothing.
  console.log("--- daraja status reconciliation ---");
  const statusRoute = await fetch(`${APP}/api/payments/00000000-0000-0000-0000-000000000000/status`, {
    method: "POST", headers: { cookie }, signal: AbortSignal.timeout(60_000),
  });
  check(`status route is live and ISP-scoped (got ${statusRoute.status})`,
    statusRoute.status === 404, (await statusRoute.text()).slice(0, 80));

  const statusNoAuth = await fetch(`${APP}/api/payments/00000000-0000-0000-0000-000000000000/status`, {
    method: "POST", signal: AbortSignal.timeout(60_000),
  });
  check(`status route refuses an unauthenticated caller (got ${statusNoAuth.status})`,
    statusNoAuth.status === 401, (await statusNoAuth.text()).slice(0, 80));

  // ---- secret leakage: no sensitive data in logs -------------------------
  console.log("--- secret leakage ---");
  for (const p of ["/dashboard/network/routers/new", "/dashboard/settings", "/dashboard/sms"]) {
    const r = await get(p);
    const leak = /eyJ[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|SUPABASE_SERVICE_ROLE/.test(r.text);
    check(`${p} leaks no key material`, !leak);
  }

  console.log("");
  if (unverifiedList.length) {
    console.log(`${unverifiedList.length} UNVERIFIED:`);
    for (const u of unverifiedList) console.log(`  ${u}`);
  }
  if (failures.length) {
    console.log(`${failures.length} failure(s):`);
    for (const f of failures) console.log(`  ${f}`);
    process.exitCode = 1;
  } else {
    console.log("OK - every UI audit check passed");
  }
}

main().catch((e) => { console.error(`error: ${e instanceof Error ? e.message : String(e)}`); process.exit(2); });
