// Runtime smoke tests — run against a REAL `next start` on :3000 with a REAL
// session obtained through the real GoTrue password grant (the exact exchange
// the login page's signInWithPassword performs). No cookie is forged, no auth
// is bypassed, no rows are inserted to make a test pass.
//
// Usage:
//   node scripts/smoke-runtime.mjs             run every check
//   node scripts/smoke-runtime.mjs --provision create the smoke login first
//   node scripts/smoke-runtime.mjs --cleanup   delete the smoke login
//
// Exit 0 = all checks passed, 1 = a check failed, 2 = env/usage problem.
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

if (!URL_BASE || !ANON || !SERVICE) {
  console.error(`missing NEXT_PUBLIC_SUPABASE_URL / ANON_KEY / SERVICE_ROLE_KEY in ${ENV_PATH}`);
  process.exit(2);
}

const PROJECT_REF = new URL(URL_BASE).hostname.split(".")[0];
const COOKIE_NAME = `sb-${PROJECT_REF}-auth-token`;

function base64url(str) {
  return Buffer.from(str, "utf8").toString("base64url");
}

async function api(pathname, init = {}) {
  const res = await fetch(`${URL_BASE}${pathname}`, {
    ...init,
    headers: { apikey: ANON, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { res, json, text };
}

/** PostgREST call with the service role (server-side access only). */
async function rest(pathname, init = {}) {
  const res = await fetch(`${URL_BASE}/rest/v1/${pathname}`, {
    ...init,
    headers: {
      apikey: SERVICE,
      authorization: `Bearer ${SERVICE}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* empty or non-json */ }
  return { res, json, text };
}

/** Exact row count for a table (HEAD + Content-Range), no data transferred. */
async function countRows(pathname) {
  const qs = pathname.includes("?") ? `${pathname}&` : `${pathname}?`;
  const res = await fetch(`${URL_BASE}/rest/v1/${qs}select=id`, {
    method: "HEAD",
    headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}`, Prefer: "count=exact" },
  });
  const range = res.headers.get("content-range") ?? "";
  const total = range.split("/")[1];
  return total === "*" || total === undefined ? null : Number(total);
}

/**
 * Real sign-in: the same grant_type=password exchange the login page performs.
 * The cookie is then encoded exactly the way @supabase/ssr 0.5.2 writes it
 * (verified against its dist/main/cookies.js) — see scripts/smoke-auth.mjs.
 * A token is only ever obtained by presenting a real password to GoTrue.
 */
async function signIn() {
  const { res, json, text } = await api(`/auth/v1/token?grant_type=password`, {
    method: "POST",
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    headers: { apikey: ANON },
  });
  if (!res.ok) throw new Error(`sign-in failed ${res.status}: ${text.slice(0, 300)}`);
  return json;
}

function cookieHeader(session) {
  const raw = `base64-${base64url(JSON.stringify(session))}`;
  const chunks = [];
  for (let i = 0; i < raw.length; i += 3600) chunks.push(raw.slice(i, i + 3600));
  if (chunks.length === 1) return { header: `${COOKIE_NAME}=${chunks[0]}`, chunks: 1 };
  const parts = chunks.map((c, i) => `${COOKIE_NAME}.${i}=${c}`);
  parts.push(`${COOKIE_NAME}=${chunks[0]}`);
  return { header: parts.join("; "), chunks: chunks.length };
}

async function provision() {
  const created = await api(`/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: ANON, authorization: `Bearer ${SERVICE}` },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, email_confirm: true }),
  });
  if (!created.res.ok && !String(created.text).includes("already")) {
    throw new Error(`create user failed ${created.res.status}: ${created.text.slice(0, 300)}`);
  }
  const user = created.json?.id
    ? created.json
    : (await api(`/auth/v1/admin/users?page=1&per_page=200`, { headers: { authorization: `Bearer ${SERVICE}` } }))
        .json?.users?.find((u) => u.email?.toLowerCase() === EMAIL.toLowerCase());
  if (!user) throw new Error("smoke user could not be located after create");

  const { json: isp } = await rest(`isps?slug=eq.${ISP_SLUG}&select=id,slug,name`);
  if (!isp?.[0]) throw new Error(`ISP "${ISP_SLUG}" not found — pass --isp <slug>`);
  const { json: roles } = await rest(`isp_roles?slug=eq.owner&select=id`);
  if (!roles?.[0]) throw new Error('role "owner" is not seeded — run supabase/seed.sql');

  // isp_users is unique (isp_id, user_id); is_active defaults to true.
  const memInsert = await rest(`isp_users?on_conflict=isp_id,user_id`, {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates" },
    body: JSON.stringify([{ isp_id: isp[0].id, user_id: user.id }]),
  });
  if (!memInsert.res.ok) {
    throw new Error(`isp_users insert failed ${memInsert.res.status}: ${memInsert.text.slice(0, 300)}`);
  }
  const { json: memRows } = await rest(
    `isp_users?isp_id=eq.${isp[0].id}&user_id=eq.${user.id}&select=id,is_active`,
  );
  const mem = memRows?.[0];
  if (!mem) throw new Error("membership row missing after insert");
  if (!mem.is_active) {
    await rest(`isp_users?id=eq.${mem.id}`, { method: "PATCH", body: JSON.stringify({ is_active: true }) });
  }

  // isp_user_roles(isp_user_id, role_id) — isp_user_id is the MEMBERSHIP row id.
  const grant = await rest(`isp_user_roles?on_conflict=isp_user_id,role_id`, {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates" },
    body: JSON.stringify([{ isp_user_id: mem.id, role_id: roles[0].id }]),
  });
  if (!grant.res.ok) {
    throw new Error(`role grant failed ${grant.res.status}: ${grant.text.slice(0, 300)}`);
  }
  console.log(
    `provisioned ${EMAIL} in ${isp[0].slug}`
    + ` (membership ${mem.id}, active=${mem.is_active}, role=owner)`,
  );
}

async function cleanup() {
  const { json } = await api(`/auth/v1/admin/users?page=1&per_page=200`, {
    headers: { authorization: `Bearer ${SERVICE}` },
  });
  const user = json?.users?.find((u) => u.email?.toLowerCase() === EMAIL.toLowerCase());
  if (!user) { console.log("no smoke user to delete"); return; }
  await api(`/auth/v1/admin/users/${user.id}`, {
    method: "DELETE",
    headers: { apikey: ANON, authorization: `Bearer ${SERVICE}` },
  });
  const left = await countRows(`isp_users?user_id=eq.${user.id}`);
  console.log(`deleted smoke user; isp_users rows left = ${left}`);
}


const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

// For behaviour that cannot be observed honestly right now. Reported separately
// so it is never quietly counted as a pass.
const unverifiedList = [];
function unverified(name, why = "") {
  console.log(`UNVER ${name}${why ? ` — ${why}` : ""}`);
  unverifiedList.push(`${name}${why ? ` — ${why}` : ""}`);
}

// A fresh number per run. The portal rate limit is 6 attempts per hour per
// ISP+phone, so a fixed number makes this check impossible to re-run within an
// hour (it correctly starts answering 429). Rotating keeps the 422 assertion
// repeatable; the walk-up customer it creates is deleted further down.
const TEST_DIGITS = String(10000000 + (Math.floor(Date.now() / 1000) % 89999999)).slice(0, 8);
const TEST_PHONE = `07${TEST_DIGITS}`; // 10 digits, 07… — a valid Safaricom shape
const TEST_MATCH = TEST_DIGITS; // unique substring of the stored (normalised) phone

async function run() {
  // ---- discovery (read-only) -------------------------------------------
  const { json: ispRows } = await rest(`isps?slug=eq.${ISP_SLUG}&select=id,slug,name`);
  const isp = ispRows?.[0];
  if (!isp) throw new Error(`ISP "${ISP_SLUG}" not found`);

  const { json: pkgRows } = await rest(
    `packages?isp_id=eq.${isp.id}&enabled=eq.true&service_type=in.(hotspot,voucher)`
    + `&select=id,name,price,service_type&order=created_at.asc&limit=1`,
  );
  const pkg = pkgRows?.[0];

  console.log(`\napp      ${APP}`);
  console.log(`isp      ${isp.slug} (${isp.id})`);
  console.log(`package  ${pkg ? `${pkg.id} "${pkg.name}" ${pkg.price} ${pkg.service_type}` : "NONE purchasable"}\n`);

  // ---- 2. live database state ------------------------------------------
  const providerRows = await countRows(`payment_providers`);
  const darajaRows = await countRows(`payment_providers?provider=eq.daraja`);
  const payheroRows = await countRows(`payment_providers?provider=eq.payhero`);

  // STK Push is live only when BOTH halves exist (migration 0044): this ISP has
  // an active daraja row with a Till/PayBill to collect into, AND NETPID's
  // single platform app is present to authenticate with. Counting daraja rows
  // was the old per-ISP model and reported "live" whenever any ISP had ever
  // saved a number — so the suite then expected a 201/502 the portal correctly
  // refused with 422.
  const ispProvider = await rest(
    `payment_providers?isp_id=eq.${isp.id}&provider=eq.daraja&status=eq.active&select=till_number,paybill`,
  );
  const target = (ispProvider?.[0]?.till_number ?? ispProvider?.[0]?.paybill ?? "").trim();
  const platformRows = await countRows(`payment_providers?provider=eq.daraja&isp_id=is.null`);
  const darajaLive = Boolean(target) && (platformRows ?? 0) > 0;

  // What must hold in BOTH states is that no secret is ever stored in the clear
  // and no legacy provider returns.
  console.log(`info payment provider state: total=${providerRows} daraja=${darajaRows} payhero=${payheroRows}`
    + ` platform_app=${platformRows ?? 0} isp_target=${target || "none"}`
    + ` -> Daraja ${darajaLive ? "CONFIGURED" : "unconfigured"}`);
  check(`no payhero provider rows (got ${payheroRows})`, payheroRows === 0);

  const { json: credRows } = await rest(`payment_provider_credentials?select=encrypted_secret`);
  const envelopes = credRows ?? [];
  check(`every stored credential is an encrypted envelope (${envelopes.length} row(s))`,
    envelopes.every((c) => typeof c.encrypted_secret === "string" && c.encrypted_secret.startsWith("v1:")),
    envelopes.length ? "" : "no credential stored");
  check(`no raw Daraja secret sits in the credential table`,
    !envelopes.some((c) => /"consumer_secret"\s*:\s*"/.test(c.encrypted_secret)));

  // ---- 1. customer portal buy flow -------------------------------------
  if (!pkg) {
    check("portal buy: purchasable package exists", false, "no enabled hotspot/voucher package");
  } else {
    const paymentsBefore = await countRows(`payments?isp_id=eq.${isp.id}`);
    const custBefore = await rest(
      `customers?isp_id=eq.${isp.id}&phone=like.*${TEST_MATCH}*&select=id,status`,
    );

    const res = await fetch(`${APP}/api/portal/${isp.slug}/pay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ package_id: pkg.id, phone: TEST_PHONE }),
    });
    const body = await res.json().catch(() => null);

    if (darajaLive) {
      // Configured: the portal must attempt a real STK push and must NEVER
      // activate from the request itself. 201 means Safaricom accepted the push
      // and the row is still PENDING — only the callback settles it. 502 means
      // Safaricom refused, which the sandbox does to rapid repeat pushes.
      check(`portal buy with Daraja configured does not activate inline`,
        res.status === 201 || res.status === 502, `status=${res.status}`);
      check(`an accepted push returns a payment id, and never a completion`,
        res.status !== 201 || (Boolean(body?.payment_id) && body?.settled === undefined),
        `status=${res.status}`);
    } else {
      check(`portal buy returns 422 (got ${res.status})`, res.status === 422);
      check(
        `body carries an "error" the portal renders (BuyForm reads j.error)`,
        typeof body?.error === "string" && body.error.length > 0,
        JSON.stringify(body?.error ?? null),
      );
      // The portal is STK-only. It must NOT advertise a manual fallback: that
      // flow was removed deliberately, and re-advertising it would walk a
      // customer to a till page that can no longer accept a receipt.
      check(`no manual fallback is advertised (got manual_available=${body?.manual_available})`,
        body?.manual_available === false);
      check(
        `no "pay at the Till" instruction is offered`,
        !(typeof body?.message === "string" && /Till\/PayBill/i.test(body.message)),
        JSON.stringify(body?.message ?? null),
      );
      // This is where the price-tampering property now lives. The 422 is a
      // rejection, so there is no amount to echo back; what must hold is that
      // the client never named a price AND a request that cannot be served
      // leaves no payment row behind to be settled later.
      const paymentsAfter = await countRows(`payments?isp_id=eq.${isp.id}`);
      check(`a rejected buy creates no payment row (${paymentsBefore} -> ${paymentsAfter})`,
        paymentsAfter === paymentsBefore);
    }

    const paymentsAfter = await countRows(`payments?isp_id=eq.${isp.id}`);
    if (darajaLive) {
      // A real push legitimately writes a PENDING row. What must never happen
      // is it arriving already settled from the request itself.
      const row = await rest(`payments?isp_id=eq.${isp.id}&select=status&order=created_at&limit=1`);
      const newest = (row.json ?? [])[0];
      check(`a configured push writes a PENDING row, never a settled one`,
        newest?.status === "pending" || newest?.status === "failed",
        `newest status=${newest?.status ?? "(none)"} (before=${paymentsBefore} after=${paymentsAfter})`);
    } else {
      check(
        `no payment row created (before=${paymentsBefore} after=${paymentsAfter})`,
        paymentsBefore === paymentsAfter,
      );
    }

    // The route opens the walk-up account BEFORE the Daraja guard by design,
    // so a 'pending' customer is an expected side effect — record it, then
    // remove it below so the run leaves no residue.
    const custAfter = await rest(
      `customers?isp_id=eq.${isp.id}&phone=like.*${TEST_MATCH}*&select=id,status`,
    );
    const beforeIds = new Set((custBefore.json ?? []).map((c) => c.id));
    const created = (custAfter.json ?? []).filter((c) => !beforeIds.has(c.id));
    console.log(
      `info walk-up customer created by design: ${created.length} row(s)`
      + `${created.length ? ` status=${created[0].status} id=${created[0].id}` : ""}`,
    );
    for (const c of created) {
      // payments.customer_id is ON DELETE RESTRICT. Once a real STK attempt has
      // written a payment for this walk-up customer, deleting the customer alone
      // silently fails and the test leaves residue behind. Both rows are artifacts
      // of this run, so both are removed — child rows first.
      await rest(`payments?customer_id=eq.${c.id}`, { method: "DELETE" });
      const del = await rest(`customers?id=eq.${c.id}`, { method: "DELETE" });
      if (del.res && !del.res.ok) {
        console.log(`info cleanup warning for ${c.id}: ${String(del.text ?? "").slice(0, 120)}`);
      }

      // Verify the payment rows are actually gone.
      //
      // Why this check exists: a payment orphaned by an earlier run went
      // unnoticed for exactly this long. The end-of-run residue check only counts
      // CUSTOMERS (see section 6), so a surviving payment was invisible — until
      // it made /api/payments report total=1 with 0 rows and failed a pagination
      // assertion on an unrelated code path. The DELETE above is fire-and-forget;
      // if it is ever filtered, rejected or raced, nothing noticed. Asserting our
      // own cleanup is the difference between a test that fails loudly and one
      // that quietly poisons the next run.
      const left = await rest(`payments?customer_id=eq.${c.id}&select=id`);
      const n = (left.json ?? []).length;
      check(
        `smoke cleanup removed the payment rows it created for ${c.id}`,
        n === 0,
        `${n} row(s) survived and will orphan`,
      );
    }
    if (created.length) console.log(`info cleaned up ${created.length} test customer row(s) and their payments`);
  }

  // ---- 3. /api/payments HTTP pagination --------------------------------
  const session = await signIn();
  const { header } = cookieHeader(session);
  console.log(`\nsession ${session.user?.email} expires_at=${session.expires_at}`);
  console.log(`cookie  ${COOKIE_NAME} (${header.length} bytes)\n`);

  async function payments(pathAndQuery) {
    const r = await fetch(`${APP}/api/payments${pathAndQuery}`, {
      headers: { cookie: header },
      signal: AbortSignal.timeout(180_000),
    });
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch { /* non-json */ }
    return { status: r.status, j, len: text.length };
  }
  // Echo the paging envelope only — dumping rows would put subscriber phone
  // numbers into the log.
  const envelope = (j) =>
    j && typeof j === "object"
      ? { page: j.page, per_page: j.per_page, total: j.total,
          total_pages: j.total_pages, has_more: j.has_more,
          rows: Array.isArray(j.payments) ? j.payments.length : null,
          error: j.error }
      : j;

  const p1 = await payments(`?page=1&per_page=2`);
  const p2 = await payments(`?page=2&per_page=2`);
  const pAll = await payments(``);
  const bad0 = await payments(`?page=1&per_page=0`);
  const badX = await payments(`?page=abc`);
  const badBig = await payments(`?page=1&per_page=101`);

  const total = pAll.j?.total ?? null;
  console.log(`info GET /api/payments?page=1&per_page=2 -> ${p1.status} ${JSON.stringify(envelope(p1.j))}`);
  console.log(`info GET /api/payments?page=2&per_page=2 -> ${p2.status} ${JSON.stringify(envelope(p2.j))}`);
  console.log(`info GET /api/payments               -> ${pAll.status} ${JSON.stringify(envelope(pAll.j))}`);

  check(`/api/payments responds 200 to a session (got ${p1.status})`, p1.status === 200);

  const wanted = ["page", "per_page", "total", "total_pages", "has_more"];
  const missing = wanted.filter((k) => !(p1.j && k in p1.j));
  check(`pagination metadata present (${wanted.join(", ")})`, missing.length === 0,
    missing.length ? `missing: ${missing.join(",")}` : "");
  check(`payments stays an array (got ${Array.isArray(p1.j?.payments)})`,
    Array.isArray(p1.j?.payments));
  check(`per_page=2 echoed back (got ${p1.j?.per_page})`, p1.j?.per_page === 2);
  // An out-of-range page must be an EMPTY page, never a PostgREST 416/400.
  check(`page 2 responds 200 with an array (got ${p2.status})`,
    p2.status === 200 && Array.isArray(p2.j?.payments),
    JSON.stringify(envelope(p2.j)));
  check(`page numbers echoed (p1=${p1.j?.page} p2=${p2.j?.page})`,
    p1.j?.page === 1 && p2.j?.page === 2);
  check(`total/total_pages/has_more are consistent`,
    typeof p1.j?.total === "number"
    && p1.j?.total_pages === Math.max(1, Math.ceil(p1.j.total / p1.j.per_page))
    && typeof p1.j?.has_more === "boolean",
    `total=${p1.j?.total} total_pages=${p1.j?.total_pages} has_more=${p1.j?.has_more}`);

  check(`per_page=0 rejected with 400 (got ${bad0.status})`, bad0.status === 400,
    JSON.stringify(bad0.j));
  check(`page=abc rejected with 400 (got ${badX.status})`, badX.status === 400,
    JSON.stringify(badX.j));
  check(`per_page=101 rejected with 400 (got ${badBig.status})`, badBig.status === 400,
    JSON.stringify(badBig.j));

  if (!total) {
    unverified(
      "/api/payments windowing across distinct rows",
      "the payments table holds 0 rows for every ISP, so there is nothing to page over; "
      + "inserting payments purely to demonstrate paging would be fake data",
    );
  } else {
    const n1 = p1.j?.payments?.length ?? 0;
    const n2 = p2.j?.payments?.length ?? 0;
    check(`page windows hold at most per_page rows (p1=${n1} p2=${n2})`, n1 <= 2 && n2 <= 2);
    check(`page 2 returns a different window than page 1`,
      JSON.stringify(p1.j) !== JSON.stringify(p2.j));
    // has_more must describe THIS data rather than a hard-coded expectation.
    // With one payment row and per_page=2 the correct answer is false, and
    // asserting true reported a healthy deployment as broken. Computing the
    // expectation from total also keeps the check meaningful once the table
    // grows past one page.
    const perPage = p1.j?.per_page ?? 0;
    const expectedHasMore = total > perPage;
    check(`has_more matches the rows present (total=${total}, per_page=${perPage}, has_more=${p1.j?.has_more}, expected=${expectedHasMore})`,
      p1.j?.has_more === expectedHasMore);
    check(`total_pages implies has_more (total_pages=${p1.j?.total_pages})`,
      p1.j?.has_more === (p1.j?.total_pages ?? 0) > 1);
  }


  // ---- 4. pages over real HTTP -----------------------------------------
  const { json: pkgForPage } = await rest(
    `packages?isp_id=eq.${isp.id}&select=id&order=created_at.asc&limit=1`,
  );
  const { json: payForPage } = await rest(
    `payments?isp_id=eq.${isp.id}&select=id&order=created_at.desc&limit=1`,
  );
  const { json: custForPage } = await rest(
    `customers?isp_id=eq.${isp.id}&select=id&order=created_at.desc&limit=1`,
  );

  const pages = [
    ["/dashboard", 200],
    ["/dashboard/customers", 200],
    ["/dashboard/packages", 200],
    ["/dashboard/payments", 200],
    ["/dashboard/customers?page=2", 200],
    ["/dashboard/packages/new", 200],
    ...(pkgForPage?.[0] ? [[`/dashboard/packages/${pkgForPage[0].id}`, 200]] : []),
    ...(payForPage?.[0] ? [[`/dashboard/payments/${payForPage[0].id}`, 200]] : []),
    ...(custForPage?.[0] ? [[`/dashboard/customers/${custForPage[0].id}`, 200]] : []),
    ["/dashboard/packages/00000000-0000-0000-0000-000000000000", 404],
    ["/dashboard/payments/00000000-0000-0000-0000-000000000000", 404],
  ];
  console.log("");
  for (const [pathAndQuery, expect] of pages) {
    const started = Date.now();
    let r;
    let body = "";
    try {
      r = await fetch(`${APP}${pathAndQuery}`, {
        headers: { cookie: header },
        redirect: "manual",
        signal: AbortSignal.timeout(600_000),
      });
      body = await r.text();
    } catch (e) {
      check(`page ${pathAndQuery}`, false, e instanceof Error ? e.message : String(e));
      continue;
    }
    const crashed = /Application error|Unhandled Runtime Error|Internal Server Error/.test(body);
    check(
      `page ${pathAndQuery} -> ${r.status} (want ${expect})`,
      r.status === expect && !crashed,
      `${body.length} bytes, ${Date.now() - started}ms${crashed ? " CRASHED" : ""}`,
    );
  }

  // ---- 5. the guard must still bite ------------------------------------
  const anon = await fetch(`${APP}/dashboard`, { redirect: "manual", signal: AbortSignal.timeout(180_000) });
  const loc = anon.headers.get("location") ?? "";
  check(
    `unauthenticated /dashboard redirects to /login (got ${anon.status} -> ${loc})`,
    (anon.status === 307 || anon.status === 302) && loc.includes("/login"),
  );

  const anonApi = await fetch(`${APP}/api/payments`, { signal: AbortSignal.timeout(180_000) });
  const anonBody = await anonApi.text();
  check(
    `unauthenticated /api/payments refused (got ${anonApi.status})`,
    anonApi.status === 401 || anonApi.status === 403,
    `body=${anonBody.slice(0, 120)}`,
  );

  // ---- 5b. Phase C: router backups, SMS templates, IP pools, announcements ----
  async function call(pathAndQuery, init = {}) {
    const r = await fetch(`${APP}${pathAndQuery}`, {
      ...init,
      headers: { cookie: header, "content-type": "application/json", ...(init.headers ?? {}) },
      redirect: "manual",
      signal: AbortSignal.timeout(180_000),
    });
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch { /* non-json */ }
    return { status: r.status, j, text, loc: r.headers.get("location") };
  }
  console.log("\n--- Phase C ---");

  // -- Router backups ------------------------------------------------------
  const { json: routerRow } = await rest(`routers?isp_id=eq.${isp.id}&select=id&limit=1`);
  if (routerRow?.[0]) {
    const bk = await call(`/api/routers/${routerRow[0].id}/backups`);
    check(`GET router backups -> 200 (got ${bk.status})`, bk.status === 200, JSON.stringify(bk.j));
    check(`backups payload shape`,
      Array.isArray(bk.j?.backups) && Array.isArray(bk.j?.jobs) && typeof bk.j?.in_flight === "boolean",
      `backups=${bk.j?.backups?.length} jobs=${bk.j?.jobs?.length} storage=${bk.j?.storage}`);
    check(`storage location reported honestly as "${bk.j?.storage}"`, bk.j?.storage === "on-router");
    check(`no backup claims to be downloadable (nothing is mirrored off-box)`,
      (bk.j?.backups ?? []).every((b) => b.retrievable === false));
    check(`unknown router backups -> 404 (got ${(await call("/api/routers/00000000-0000-0000-0000-000000000000/backups")).status})`,
      (await call("/api/routers/00000000-0000-0000-0000-000000000000/backups")).status === 404);
    check(`unknown backup id -> 404 (got ${(await call(`/api/routers/${routerRow[0].id}/backups/00000000-0000-0000-0000-000000000000`)).status})`,
      (await call(`/api/routers/${routerRow[0].id}/backups/00000000-0000-0000-0000-000000000000`)).status === 404);
  } else {
    unverified("router backups API", "this ISP has no routers, so /api/routers/:id/backups was not exercised");
  }

  // -- SMS templates -------------------------------------------------------
  const tplGet = await call("/api/sms/templates");
  check(`GET /api/sms/templates -> 200 (got ${tplGet.status})`, tplGet.status === 200);
  check(`templates list is an array (${tplGet.j?.templates?.length} seeded rows)`,
    Array.isArray(tplGet.j?.templates));

  const badTpl = await call("/api/sms/templates", {
    method: "POST", body: JSON.stringify({ event: "Bad Event!", body: "x" }),
  });
  check(`invalid template event rejected 400 (got ${badTpl.status})`, badTpl.status === 400,
    JSON.stringify(badTpl.j?.error));

  const newTpl = await call("/api/sms/templates", {
    method: "POST",
    body: JSON.stringify({ event: "smoke_test_event", locale: "en", body: "Smoke test for {{name}}." }),
  });
  check(`create template -> 201 (got ${newTpl.status})`, newTpl.status === 201, JSON.stringify(newTpl.j?.error));
  const tplId = newTpl.j?.template?.id;
  if (tplId) {
    const dup = await call("/api/sms/templates", {
      method: "POST", body: JSON.stringify({ event: "smoke_test_event", locale: "en", body: "again" }),
    });
    check(`duplicate event+locale rejected 409 (got ${dup.status})`, dup.status === 409, JSON.stringify(dup.j?.error));
    const patched = await call(`/api/sms/templates/${tplId}`, { method: "PATCH", body: JSON.stringify({ enabled: false }) });
    check(`patch template -> 200, enabled=false (got ${patched.status})`,
      patched.status === 200 && patched.j?.template?.enabled === false, JSON.stringify(patched.j?.template));
    const del = await call(`/api/sms/templates/${tplId}`, { method: "DELETE" });
    check(`delete template -> 200 (got ${del.status})`, del.status === 200, JSON.stringify(del.j?.error));
    const afterTpl = await call("/api/sms/templates");
    check(`template really removed`,
      !(afterTpl.j?.templates ?? []).some((t) => t.event === "smoke_test_event"));
    const ghost = await call(`/api/sms/templates/00000000-0000-0000-0000-000000000000`, {
      method: "PATCH", body: JSON.stringify({ enabled: true }),
    });
    check(`patch unknown template -> 404 (got ${ghost.status})`, ghost.status === 404);
  }

  // -- IP pools ------------------------------------------------------------
  const poolsGet = await call("/api/ip-pools");
  check(`GET /api/ip-pools -> 200 (got ${poolsGet.status})`, poolsGet.status === 200, JSON.stringify(poolsGet.j?.error));
  check(`pools list is an array (${poolsGet.j?.pools?.length} rows)`, Array.isArray(poolsGet.j?.pools));

  const reversed = await call("/api/ip-pools", {
    method: "POST", body: JSON.stringify({ name: "smoke-rev", ranges: "10.0.0.10-10.0.0.5" }),
  });
  check(`reversed range rejected 400 (got ${reversed.status})`, reversed.status === 400, JSON.stringify(reversed.j?.error));

  const badIp = await call("/api/ip-pools", {
    method: "POST", body: JSON.stringify({ name: "smoke-bad", ranges: "999.1.1.1-999.1.1.5" }),
  });
  check(`out-of-range octet rejected 400 (got ${badIp.status})`, badIp.status === 400, JSON.stringify(badIp.j?.error));

  const newPool = await call("/api/ip-pools", {
    method: "POST", body: JSON.stringify({ name: "smoke-pool", ranges: "10.254.0.10-10.254.0.20, 10.254.1.0/30" }),
  });
  check(`create pool -> 201 (got ${newPool.status})`, newPool.status === 201, JSON.stringify(newPool.j?.error));
  const poolId = newPool.j?.pool?.id;
  if (poolId) {
    const overlap = await call("/api/ip-pools", {
      method: "POST", body: JSON.stringify({ name: "smoke-pool-2", ranges: "10.254.0.15-10.254.0.25" }),
    });
    check(`overlapping pool rejected 409 (got ${overlap.status})`, overlap.status === 409, JSON.stringify(overlap.j?.error));

    const listed = await call("/api/ip-pools");
    const mine = (listed.j?.pools ?? []).find((p) => p.id === poolId);
    check(`capacity computed from ranges (${mine?.addresses} addresses, expect 15)`,
      mine?.addresses === 15, JSON.stringify({ addresses: mine?.addresses, entries: mine?.entries }));
    check(`usage counters present (packages=${mine?.packages} accounts=${mine?.accounts})`,
      typeof mine?.packages === "number" && typeof mine?.accounts === "number");

    const ren = await call(`/api/ip-pools/${poolId}`, {
      method: "PATCH", body: JSON.stringify({ ranges: "10.254.9.1-10.254.9.4" }),
    });
    check(`patch pool ranges -> 200 (got ${ren.status})`, ren.status === 200, JSON.stringify(ren.j?.error));

    const delPool = await call(`/api/ip-pools/${poolId}`, { method: "DELETE" });
    check(`delete pool -> 200 (got ${delPool.status})`, delPool.status === 200, JSON.stringify(delPool.j?.error));
    const afterPool = await call("/api/ip-pools");
    check(`pool really removed`, !(afterPool.j?.pools ?? []).some((p) => p.id === poolId));
  }

  // -- Announcements -------------------------------------------------------
  const annNoAdmin = await call("/api/admin/announcements");
  check(`admin announcements API refuses an ISP session (got ${annNoAdmin.status})`,
    annNoAdmin.status === 403, JSON.stringify(annNoAdmin.j));

  const annPage = await call("/dashboard/announcements");
  check(`/dashboard/announcements -> 200 (got ${annPage.status})`, annPage.status === 200);
  check(`announcements page does not leak draft wording`,
    !/Publish now|unpublished and is now hidden/i.test(annPage.text), "operator controls must not render here");

  const adminPage = await call("/admin/announcements");
  check(`/admin/announcements redirects a non-admin to admin-login (got ${adminPage.status})`,
    (adminPage.status === 307 || adminPage.status === 302) && (adminPage.loc ?? "").includes("admin-login"),
    `location=${adminPage.loc}`);

  // -- Phase E: pricing calculator ----------------------------------------
  // 3 routers x KSh 500 = 1,500 (under the 2,999 cap) + 40 PPPoE x 20 = 800
  // + 200 SMS x 0.75 = 150  =>  KSh 2,450.
  const pricing = await call("/pricing");
  check(`/pricing -> 200 (got ${pricing.status})`, pricing.status === 200);
  check(`calculator section is present`, /Work out your monthly cost/i.test(pricing.text));
  check(`calculator total is the real arithmetic (KSh 2,450)`,
    /KSh 2,450/.test(pricing.text),
    "3x500 + 40x20 + 200x0.75 = 2450");
  check(`calculator labels itself an estimate, not a quote`,
    /not a quote/i.test(pricing.text));
  check(`calculator offers no fabricated "average customer" figure`,
    !/average customer|typical ISP pays/i.test(pricing.text));
  check(`SMS rate in the breakdown matches lib/pricing (KSh 0.75)`,
    /KSh 0\.75/.test(pricing.text));
  check(`router cap explained (KSh 2,999 ceiling surfaced)`,
    /2,999/.test(pricing.text));

  // ---- 6. no test residue ------------------------------------------------
  const { json: allUsers } = await api(`/auth/v1/admin/users?page=1&per_page=200`, {
    headers: { authorization: `Bearer ${SERVICE}` },
  });
  const smokeUsers = (allUsers?.users ?? []).filter((u) =>
    (u.email ?? "").toLowerCase().startsWith("netpid-smoke"));
  console.log(
    `info smoke login accounts present: ${smokeUsers.length}`
    + `${smokeUsers.length ? ` (${smokeUsers.map((u) => u.email).join(", ")})` : ""}`,
  );
  const residue = await countRows(`customers?phone=like.*${TEST_MATCH}*`);
  check(`no test customer residue left (got ${residue})`, residue === 0);

  console.log("");
  if (unverifiedList.length) {
    console.log(`${unverifiedList.length} UNVERIFIED:`);
    for (const u of unverifiedList) console.log(`  ${u}`);
  }
  if (failures.length) {
    console.log(`${failures.length} failure(s):`);
    for (const f of failures) console.log(`  ${f}`);
    process.exitCode = 1;
  } else if (unverifiedList.length) {
    console.log(`OK - every check that could be verified passed (${unverifiedList.length} unverified above)`);
  } else {
    console.log("OK - every runtime smoke check passed");
  }
}

if (args.provision) await provision();
else if (args.cleanup) await cleanup();
else await run();

