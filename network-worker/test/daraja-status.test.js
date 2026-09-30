// M-Pesa Express Transaction Status Query.
//
// This is the recovery path for a STK push that Safaricom accepted but whose
// callback never arrived. The tests pin two things: the request we put on the
// wire (endpoint, bearer, and the documented security fields) and, far more
// importantly, that a status query is NOT treated as money in the bank.
//
// That second point is the safety property: the only thing that may flip a
// payment to 'completed' is a settlement Daraja actually reports, never a
// successful HTTP call or a "query accepted" response.
//
// Same harness note as daraja-callback.test.js: `node --test` is the repo's only
// runner, and daraja-push.ts carries no runtime dependency on Supabase.
import test from "node:test";
import assert from "node:assert/strict";
import {
  queryStkTransactionStatus,
  statusSucceeded,
  statusFailed,
  statusPending,
} from "../../apps/web/lib/daraja-push.ts";

// Deliberately long dummy values. Two-character dummies collide with our own
// field names — "ck" appears inside "checkoutRequestId" — which would make the
// credential-leak assertion pass for the wrong reason.
const CREDS = {
  consumer_key: "test-consumer-key",
  consumer_secret: "test-consumer-secret",
  passkey: "test-passkey",
  shortcode: "174379",
  environment: "sandbox",
};

function stubFetch(t, pushBody) {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/oauth/v1/generate")) {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: "3599" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    pushBody.url = String(url);
    pushBody.init = init;
    return new Response(JSON.stringify(pushBody.json), {
      status: pushBody.status ?? 200, headers: { "content-type": "application/json" },
    });
  };
  return pushBody;
}

test("status query posts to the documented endpoint with the shortcode and passkey fields", async (t) => {
  const cap = stubFetch(t, {
    json: { ResponseCode: "0", ResponseDescription: "Accept the service request successfully", TransactionStatus: "Completed", CheckoutRequestID: "ws_CO_1" },
  });

  await queryStkTransactionStatus(CREDS, { transactionId: "ws_CO_1" });

  assert.match(cap.url, /\/mpesa\/transactionstatus\/v1\/query$/);
  const body = JSON.parse(cap.init.body);
  assert.equal(body.TransactionID, "ws_CO_1");
  assert.equal(body.ShortCode, "174379");
  assert.equal(body.InitiatorSecurityCredential, "test-passkey");
  assert.equal(body.SecurityCredential, "test-passkey");
  assert.match(cap.init.headers.authorization, /^Bearer tok$/);
  assert.equal(cap.init.method, "POST");
});

test("a Completed status is reported as settled", async (t) => {
  stubFetch(t, { json: { ResponseCode: "0", TransactionStatus: "Completed" } });
  const s = await queryStkTransactionStatus(CREDS, { transactionId: "ws_CO_2" });
  assert.equal(s.transactionStatus, "Completed");
  assert.equal(statusSucceeded(s), true);
  assert.equal(statusFailed(s), false);
  assert.equal(statusPending(s), false);
});

test("ResponseCode 0 alone is NOT settlement — a dropped or cancelled push stays unsettled", async (t) => {
  // The dangerous bug this guards: treating "the query was accepted" as "the
  // customer paid". If that ever shipped, any CheckoutRequestID could be turned
  // into free service.
  stubFetch(t, {
    json: { ResponseCode: "0", ResponseDescription: "Accept the service request successfully" },
  });
  const s = await queryStkTransactionStatus(CREDS, { transactionId: "ws_CO_3" });
  assert.equal(s.responseCode, "0");
  assert.equal(s.transactionStatus, null);
  assert.equal(statusSucceeded(s), false, "no TransactionStatus must never read as paid");
  assert.equal(statusFailed(s), false);
  assert.equal(statusPending(s), false);
});

test("In Progress is pending, not success and not failure", async (t) => {
  stubFetch(t, { json: { ResponseCode: "0", TransactionStatus: "In Progress" } });
  const s = await queryStkTransactionStatus(CREDS, { transactionId: "ws_CO_4" });
  assert.equal(statusPending(s), true);
  assert.equal(statusSucceeded(s), false);
  assert.equal(statusFailed(s), false);
});

test("Failed / Reversed are terminal and case-insensitive", async (t) => {
  for (const value of ["Failed", "Reversed", "REVERSED EARLIER"]) {
    stubFetch(t, { json: { ResponseCode: "0", TransactionStatus: value } });
    const s = await queryStkTransactionStatus(CREDS, { transactionId: "ws_CO_5" });
    assert.equal(statusFailed(s), true, `${value} must be terminal`);
    assert.equal(statusSucceeded(s), false, `${value} must not settle`);
  }
});

test("an HTTP failure surfaces Safaricom's own reason, not a generic one", async (t) => {
  stubFetch(t, {
    status: 400,
    json: { ResponseCode: "1002", ResponseDescription: "Transaction status query not supported" },
  });
  await assert.rejects(
    () => queryStkTransactionStatus(CREDS, { transactionId: "ws_CO_6" }),
    /Transaction status query not supported/,
  );
});

test("the status result never carries a credential back to the caller", async (t) => {
  stubFetch(t, { json: { ResponseCode: "0", TransactionStatus: "Completed" } });
  const s = await queryStkTransactionStatus(CREDS, { transactionId: "ws_CO_7" });
  const serialised = JSON.stringify(s);
  for (const secret of [CREDS.passkey, CREDS.consumer_secret, CREDS.consumer_key]) {
    assert.equal(serialised.includes(secret), false, `result leaked ${secret.slice(0, 2)}...`);
  }
});

// Source-shape guard for the new route. The route cannot be imported here (it
// pulls Supabase), so this asserts the security-relevant invariants are present
// in the file rather than assuming them.
test("the reconcile route keeps the provider, status and tenant guards", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const path = await import("node:path");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(
    path.join(here, "..", "..", "apps", "web", "app", "api", "payments", "[id]", "status", "route.ts"),
    "utf8",
  );

  assert.match(src, /resolveIsp\(req\)/, "must be ISP-authenticated");
  assert.match(src, /\.eq\("isp_id", r\.ispId\)/, "payment must be scoped to the caller's ISP");
  assert.match(src, /p\.provider !== "daraja"/, "must refuse non-Daraja payments");
  assert.match(src, /p\.status === "completed"/, "must not re-process a completed payment");
  assert.match(src, /p\.status !== "pending"/, "must only act on a pending payment");
  assert.match(src, /getDarajaCreds\(r\.ispId\)/, "must use the ISP's own credentials");
  // The activation flip must stay a compare-and-set so a late callback is a
  // duplicate rather than a second subscription extension.
  assert.match(src, /\.eq\("id", p\.id\)\.eq\("status", "pending"\)\.select\("id"\)/);
  assert.match(src, /applyConfirmedPayment/, "activation must reuse the shared helper");
});
