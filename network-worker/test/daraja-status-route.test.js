// Behavioural tests for POST /api/payments/[id]/status — the STK reconciliation
// route. daraja-status.test.js pins the Daraja wire contract; these pin what the
// ROUTE does with that answer, which is where money becomes service.
//
// The route normally runs under Next with "@/..." aliases and a real Supabase
// client. Node 24's module.registerHooks lets this harness resolve those
// specifiers to in-memory stubs, so the file under test is the real, unmodified
// route. Nothing is reimplemented here, so these tests cannot drift from
// production behaviour. The only thing swapped out is the Daraja HTTP boundary
// (globalThis.fetch), which is the boundary under test.
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, "..", "..", "apps", "web");
const REAL_DARAJA_PUSH = pathToFileURL(path.join(WEB, "lib", "daraja-push.ts")).href;

// ---------------------------------------------------------------------------
// In-memory stand-in for the Supabase query builder, limited to the chain
// shapes the route actually uses. The compare-and-set on `status` is modelled
// for real: an update only touches rows that still match every .eq() filter,
// so a second activation genuinely loses the race here just as it would in
// Postgres. That is what makes the double-activation test meaningful.
// ---------------------------------------------------------------------------
class Builder {
  constructor(db, table) {
    this.db = db; this.table = table;
    this.filters = []; this.patch = null; this.doSelect = false;
  }
  get rows() { return this.db.tables[this.table] ?? []; }
  select() { this.doSelect = true; return this; }
  eq(k, v) { this.filters.push([k, v]); return this; }
  update(patch) { this.patch = patch; return this; }
  insert(row) { this.db.tables.audit_logs.push({ ...row }); return Promise.resolve({ data: row }); }
  matching() { return this.rows.filter((r) => this.filters.every(([k, v]) => r[k] === v)); }
  maybeSingle() {
    const source = this.db.staleSelect ? this.db.snapshot : this.rows;
    const m = source.filter((r) => this.filters.every(([k, v]) => r[k] === v));
    return Promise.resolve({ data: m.length ? { ...m[0] } : null });
  }
  async exec() {
    const m = this.matching();
    for (const r of m) if (this.patch) Object.assign(r, this.patch);
    return { data: this.doSelect ? m.map((r) => ({ ...r })) : null };
  }
  then(onF, onR) { return this.exec().then(onF, onR); }
}

function createDb(payments) {
  const db = {
    tables: { payments, audit_logs: [] },
    from: (t) => new Builder(db, t),
  };
  // `staleSelect` models the genuine race: the row as it looked when the
  // request started reading it. With it on, a select returns the snapshot while
  // updates still hit live rows, so a second request can read "pending" and
  // still lose the compare-and-set — which is exactly what a lost race is.
  db.snapshot = payments.map((r) => ({ ...r }));
  db.staleSelect = false;
  return db;
}

const STUB = "netpid-test-stub:";
const STUB_SOURCES = {
  "next/server": `
    export const NextResponse = {
      json(body, init) { return { __json: body, status: init?.status ?? 200 }; },
    };`,
  "@/lib/supabase/server": `
    export function createServiceClient() { return globalThis.__npState.db; }`,
  "@/lib/isp": `
    export async function resolveIsp() {
      const s = globalThis.__npState;
      if (!s.authed) return { error: { __json: { error: "Unauthorized" }, status: 401 } };
      return { ispId: s.ispId, user: { id: "user-1" } };
    }`,
  "@/lib/daraja": `
    export async function getDarajaCreds(ispId) { return globalThis.__npState.ispId === ispId ? globalThis.__npState.creds : null; }`,
  "@/lib/secrets": `
    export async function checkRateLimit() { return true; }`,
  "@/lib/payments-activate": `
    export async function applyConfirmedPayment(svc, args) {
      globalThis.__npState.activations.push(args);
      return "2027-01-01T00:00:00.000Z";
    }`,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") return { url: STUB + "next/server", shortCircuit: true };
    if (specifier === "@/lib/daraja-push") return nextResolve(REAL_DARAJA_PUSH, context);
    if (specifier.startsWith("@/lib/")) return { url: STUB + specifier, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith(STUB)) {
      return { format: "module", source: STUB_SOURCES[url.slice(STUB.length)], shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

// The real, unmodified route, loaded with its "@/..." specifiers resolved to the
// stubs registered above.
const { POST } = await import(
  pathToFileURL(path.join(WEB, "app", "api", "payments", "[id]", "status", "route.ts")).href
);

// ---------------------------------------------------------------------------
// Fixtures and harness
// ---------------------------------------------------------------------------
const CREDS = {
  consumer_key: "test-consumer-key",
  consumer_secret: "test-consumer-secret",
  passkey: "test-passkey",
  shortcode: "174379",
  environment: "sandbox",
};

function payment(overrides = {}) {
  return {
    id: "pay_1", isp_id: "isp_a", customer_id: "cus_1", package_id: "pkg_1",
    amount: 10000, provider: "daraja", status: "pending",
    checkout_request_id: "ws_CO_TEST123",
    mpesa_receipt: null, paid_at: null, provider_tx_id: null,
    ...overrides,
  };
}

// Captured verbatim from the live sandbox for a real cancelled request, so the
// tests assert against the shape Safaricom actually returns rather than one I
// invented. ResultCode 1032 is what the callback for that same request carried.
const LIVE_CANCELLED = {
  ResponseCode: "0",
  ResponseDescription: "The service request has been accepted successfully",
  MerchantRequestID: "8f38-49f8-9be4-b87d691148b41510305",
  CheckoutRequestID: "ws_CO_011020260057264708374149",
  ResultCode: 1032,
  ResultDesc: "Request Cancelled by user.",
};

function darajaFetch(json, status = 200) {
  return async (url) => {
    if (String(url).includes("/oauth/v1/generate")) {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: "3599" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(json), {
      status, headers: { "content-type": "application/json" },
    });
  };
}

async function reconcile(opts = {}) {
  const db = opts.db ?? createDb([opts.row ?? payment()]);
  db.staleSelect = Boolean(opts.staleSelect);
  const state = {
    db,
    ispId: opts.ispId ?? "isp_a",
    authed: opts.authed ?? true,
    creds: CREDS,
    // Shareable so a two-request race can assert on ONE activation count.
    activations: opts.activations ?? [],
  };
  globalThis.__npState = state;

  const original = globalThis.fetch;
  globalThis.fetch = opts.fetchImpl ?? darajaFetch(LIVE_CANCELLED);
  const url = opts.url ?? "http://local/api/payments/pay_1/status";
  try {
    const res = await POST(new Request(url, { method: "POST" }), {
      params: Promise.resolve({ id: opts.id ?? db.tables.payments[0].id }),
    });
    return { ...res, row: db.tables.payments[0], state, audits: db.tables.audit_logs };
  } finally {
    globalThis.fetch = original;
  }
}

// ---------------------------------------------------------------------------
// C / D / E — the settlement rule
// ---------------------------------------------------------------------------

test("C. HTTP 200 + ResponseCode 0 + a live 1032 does NOT settle and issues no service", async () => {
  const r = await reconcile({ fetchImpl: darajaFetch(LIVE_CANCELLED) });
  assert.equal(r.status, 200);
  assert.equal(r.__json.settled, false, "a cancelled push is not a settlement");
  assert.equal(r.__json.result_code, 1032);
  assert.equal(r.state.activations.length, 0, "a cancelled push must never extend an expiry");
  assert.equal(r.row.status, "failed");
  assert.equal(r.row.paid_at, null, "a cancelled push must not be stamped as paid");
});

test("D. HTTP 200 + ResponseCode 0 with NO ResultCode settles nothing at all", async () => {
  const r = await reconcile({
    fetchImpl: darajaFetch({
      ResponseCode: "0",
      ResponseDescription: "The service request has been accepted successfully",
    }),
  });
  assert.equal(r.status, 200);
  assert.equal(r.__json.settled, false);
  assert.equal(r.__json.result_code, null);
  assert.equal(r.row.status, "pending", "the row must stay pending for a later retry");
  assert.equal(r.state.activations.length, 0, "no ResultCode must never issue service");
  assert.equal(
    r.audits.some((a) => a.action === "payment_status_query" && a.metadata.outcome === "no_result_reported"),
    true,
  );
});

test("E. ONLY a numeric ResultCode of 0 settles (SYNTHETIC fixture)", async () => {
  // !! SYNTHETIC FIXTURE — NOT a captured Safaricom response. !!
  // The sandbox has never produced a genuine successful transaction: the
  // simulator always ends at 1032, so there is no real ResultCode 0 to record
  // here. This fixture is written to the documented success shape purely to
  // exercise the activation branch, and is deliberately kept separate from
  // LIVE_CANCELLED above, which IS a real captured response. No production
  // logic is relaxed to make this pass — the assertions below are the same
  // ones the live 1032 case is held to.
  const r = await reconcile({
    fetchImpl: darajaFetch({
      ResponseCode: "0",
      ResponseDescription: "The service request has been accepted successfully",
      CheckoutRequestID: "ws_CO_TEST123",
      ResultCode: 0,
      ResultDesc: "The service request is processed successfully.",
    }),
  });
  assert.equal(r.__json.settled, true);
  assert.equal(r.__json.result_code, 0);
  assert.equal(r.row.status, "completed");
  assert.equal(r.state.activations.length, 1, "settlement must extend the subscription exactly once");
  assert.equal(r.state.activations[0].ispId, "isp_a");
  assert.equal(r.state.activations[0].paymentId, "pay_1");
});

test("E2. a string ResultCode of \"0\" is not the number 0 and does not settle", async () => {
  // Same strictness the callback parser already enforces, so the two paths
  // cannot disagree about the one value that issues service.
  const r = await reconcile({ fetchImpl: darajaFetch({ ResponseCode: "0", ResultCode: "0" }) });
  assert.equal(r.__json.settled, false);
  assert.equal(r.row.status, "pending");
  assert.equal(r.state.activations.length, 0);
});

// ---------------------------------------------------------------------------
// F — a failed QUERY is not a failed or successful PAYMENT
// ---------------------------------------------------------------------------

test("F. Daraja rejecting the query is a 502 and never touches the payment", async () => {
  const r = await reconcile({
    fetchImpl: darajaFetch({ ResponseCode: "1", ResponseDescription: "Invalid CheckoutRequestID" }, 400),
  });
  assert.equal(r.status, 502);
  assert.match(r.__json.error, /Invalid CheckoutRequestID/);
  assert.equal(r.row.status, "pending", "a rejected query is not a failed payment");
  assert.equal(r.state.activations.length, 0, "and never a successful one either");
  assert.equal(r.audits.some((a) => a.action === "payment_status_query_failed"), true);
  assert.equal(
    r.audits.some((a) => a.action === "payment_status_query"),
    false,
    "a rejected query must not be logged as a payment outcome",
  );
});

test("F2. a transport failure mid-query is a 502, not a verdict on the payment", async () => {
  const r = await reconcile({
    fetchImpl: async (url) => {
      if (String(url).includes("/oauth/v1/generate")) throw new Error("ECONNRESET");
      throw new Error("socket hang up");
    },
  });
  assert.equal(r.status, 502);
  assert.equal(r.row.status, "pending");
  assert.equal(r.state.activations.length, 0);
});

// ---------------------------------------------------------------------------
// G / H / I / J / K — the guards
// ---------------------------------------------------------------------------

function countingFetch() {
  const counter = { queries: 0 };
  counter.impl = async (url) => {
    if (!String(url).includes("/oauth/v1/generate")) counter.queries += 1;
    return new Response("{}", { status: 500, headers: { "content-type": "application/json" } });
  };
  return counter;
}

test("G. another tenant's payment id is 404 and Daraja is never contacted", async () => {
  const seen = countingFetch();
  const r = await reconcile({ row: payment({ isp_id: "isp_other" }), ispId: "isp_a", fetchImpl: seen.impl });
  assert.equal(r.status, 404);
  assert.equal(seen.queries, 0, "another tenant's payment must not reach Daraja at all");
  assert.equal(r.state.activations.length, 0);
  assert.equal(r.row.status, "pending", "and must not be mutated by the attempt");
});

test("H. an unauthenticated caller gets 401 and touches nothing", async () => {
  const seen = countingFetch();
  const r = await reconcile({ authed: false, fetchImpl: seen.impl });
  assert.equal(r.status, 401);
  assert.equal(seen.queries, 0);
  assert.equal(r.state.activations.length, 0);
  assert.equal(r.row.status, "pending");
});

test("I. a completed payment is never reconciled a second time", async () => {
  const seen = countingFetch();
  const r = await reconcile({
    row: payment({ status: "completed", paid_at: "2026-01-01T00:00:00.000Z" }),
    fetchImpl: seen.impl,
  });
  assert.equal(r.status, 200);
  assert.equal(r.__json.already, "completed");
  assert.equal(seen.queries, 0, "an already-settled payment must not re-query Daraja");
  assert.equal(r.state.activations.length, 0);
});

test("I2. a failed payment cannot be reconciled either", async () => {
  const r = await reconcile({ row: payment({ status: "failed" }) });
  assert.equal(r.status, 409);
  assert.equal(r.state.activations.length, 0);
});

test("J. a lost race cannot double-activate — the compare-and-set arbitrates", async () => {
  // SYNTHETIC ResultCode 0 fixture, as in test E.
  const success = darajaFetch({
    ResponseCode: "0", ResultCode: 0, ResultDesc: "The service request is processed successfully.",
  });
  const db = createDb([payment()]);
  const activations = [];

  const first = await reconcile({ db, fetchImpl: success, activations });
  assert.equal(first.__json.settled, true);
  assert.equal(activations.length, 1);

  // A second operator on the same payment. staleSelect makes this request read
  // the row as it looked BEFORE the first one settled it, so it clears the
  // pending guard, reaches Daraja, sees ResultCode 0, and attempts the flip
  // against a row that is no longer pending. The .eq("status","pending")
  // guard must refuse it, so the subscription is not extended twice.
  const second = await reconcile({ db, fetchImpl: success, activations, staleSelect: true });
  assert.equal(activations.length, 1, "the loser of the race must not activate a second time");
  assert.equal(second.__json.settled, true);
  assert.equal(second.__json.already, "processed");
  assert.equal(
    second.audits.some((a) => a.metadata?.outcome === "duplicate"),
    true,
    "the lost race must be auditable",
  );
});

test("K. an isp_id in the request is ignored — the row's own tenant wins", async () => {
  const r = await reconcile({
    url: "http://local/api/payments/pay_1/status?isp_id=isp_attacker",
    fetchImpl: darajaFetch({ ResponseCode: "0", ResultCode: 0 }),
  });
  assert.equal(r.state.activations[0].ispId, "isp_a", "activation targets the row's own ISP");
  assert.equal(r.state.activations[0].customerId, "cus_1", "and the row's own customer");
});

// ---------------------------------------------------------------------------
// Receipt handling — never invented, never overwritten
// ---------------------------------------------------------------------------

test("RECEIPT. a receipt stored by the callback survives reconciliation", async () => {
  const r = await reconcile({
    row: payment({ mpesa_receipt: "NLJ7RT61SV" }),
    fetchImpl: darajaFetch({ ResponseCode: "0", ResultCode: 0 }),
  });
  assert.equal(r.row.status, "completed");
  assert.equal(r.row.mpesa_receipt, "NLJ7RT61SV", "a real receipt must never be overwritten or dropped");
});

test("RECEIPT. reconciliation completes without fabricating a receipt number", async () => {
  // stkpushquery returns no MpesaReceiptNumber, so the column must be left null
  // rather than filled with the CheckoutRequestID or any other stand-in.
  const r = await reconcile({ fetchImpl: darajaFetch({ ResponseCode: "0", ResultCode: 0 }) });
  assert.equal(r.row.status, "completed");
  assert.equal(r.row.mpesa_receipt, null, "no receipt may be invented");
  assert.equal(r.row.provider_tx_id, "ws_CO_TEST123", "the genuine Daraja id is still recorded");
});



