// Lipa na M-Pesa Online — STK transaction status.
//
// Recovery path for an STK push Safaricom accepted but whose callback never
// arrived. The tests pin the wire contract, and above all the safety property:
// only an explicit ResultCode of 0 may ever settle a payment.
//
// Where the contract came from: the official Safaricom Postman collection ships
// two similar endpoints. The generic /mpesa/transactionstatus/v1/query uses an
// Initiator-style body and answers "Invalid IdentifierType" / "Invalid
// Initiator" for an STK CheckoutRequestID. The one that answers for STK is
// /mpesa/stkpushquery/v1/query, authenticated exactly like the push itself.
// Verified live: stkpushquery returns HTTP 200 carrying the same ResultCode the
// callback delivered, while transactionstatus rejects the identical request.
import test from "node:test";
import assert from "node:assert/strict";
import {
  queryStkTransactionStatus,
  statusSucceeded,
  statusFailed,
} from "../../apps/web/lib/daraja-push.ts";

// Long dummy values on purpose: two-character dummies collide with our own field
// names ("ck" appears inside "checkoutRequestId"), which would make the
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

test("queries the STK status endpoint, not the generic transaction status one", async (t) => {
  const cap = stubFetch(t, {
    json: {
      ResponseCode: "0",
      ResponseDescription: "The service request has been accepted successfully",
      ResultCode: 0, ResultDesc: "The service request is processed successfully.",
    },
  });
  await queryStkTransactionStatus(CREDS, { transactionId: "ws_CO_1" });
  assert.match(cap.url, /\/mpesa\/stkpushquery\/v1\/query$/);
  assert.doesNotMatch(cap.url, /mpesa\/transactionstatus/);
  assert.match(cap.init.headers.authorization, /^Bearer tok$/);
  assert.equal(cap.init.method, "POST");
});

test("authenticates exactly like the STK push: shortcode + base64 password + timestamp", async (t) => {
  const cap = stubFetch(t, { json: { ResponseCode: "0", ResultCode: 0 } });
  await queryStkTransactionStatus(CREDS, { transactionId: "ws_CO_2" });

  const body = JSON.parse(cap.init.body);
  assert.equal(body.BusinessShortCode, "174379");
  assert.equal(body.CheckoutRequestID, "ws_CO_2");
  assert.match(body.Timestamp, /^\d{14}$/);
  // Same construction sendStkPush uses: base64(shortcode + passkey + timestamp).
  assert.equal(Buffer.from(body.Password, "base64").toString(), `174379test-passkey${body.Timestamp}`);
  // The endpoint this contract belongs to has no Initiator fields at all.
  assert.equal(body.InitiatorSecurityCredential, undefined);
  assert.equal(body.IdentifierType, undefined);
});

test("ResultCode 0 is settlement", async (t) => {
  stubFetch(t, { json: { ResponseCode: "0", ResultCode: 0, ResultDesc: "processed successfully." } });
  const s = await queryStkTransactionStatus(CREDS, { transactionId: "ws_CO_3" });
  assert.equal(s.resultCode, 0);
  assert.equal(statusSucceeded(s), true);
  assert.equal(statusFailed(s), false);
});

test("a non-zero ResultCode is a terminal failure, never settlement", async (t) => {
  // Live sandbox value: the simulator cancels the prompt with 1032, and the
  // callback for that same request carried 1032 too.
  stubFetch(t, { json: { ResponseCode: "0", ResultCode: 1032, ResultDesc: "Request Cancelled by user." } });
  const s = await queryStkTransactionStatus(CREDS, { transactionId: "ws_CO_4" });
  assert.equal(s.resultCode, 1032);
  assert.equal(statusFailed(s), true);
  assert.equal(statusSucceeded(s), false);
  assert.equal(s.resultDesc, "Request Cancelled by user.");
});

test("an accepted query reporting NO ResultCode settles nothing", async (t) => {
  // The dangerous case: HTTP 200 + ResponseCode "0" only means the QUERY was
  // accepted. If that read as paid, any CheckoutRequestID could become service.
  stubFetch(t, { json: { ResponseCode: "0", ResponseDescription: "The service request has been accepted successfully" } });
  const s = await queryStkTransactionStatus(CREDS, { transactionId: "ws_CO_5" });
  assert.equal(s.responseCode, "0");
  assert.equal(s.resultCode, null);
  assert.equal(statusSucceeded(s), false, "a missing ResultCode must never read as paid");
  assert.equal(statusFailed(s), false);
});

test("a rejected query throws and is NOT reported as a failed payment", async (t) => {
  stubFetch(t, { status: 400, json: { ResponseCode: "1", ResponseDescription: "Invalid CheckoutRequestID" } });
  await assert.rejects(
    () => queryStkTransactionStatus(CREDS, { transactionId: "ws_CO_6" }),
    /Invalid CheckoutRequestID/,
  );
});

test("an errorMessage-shaped rejection reaches the operator verbatim", async (t) => {
  // Observed live on the endpoint this code previously called.
  stubFetch(t, {
    status: 400,
    json: { requestId: "ac7b", errorCode: "400.002.02", errorMessage: "Bad Request - Invalid IdentifierType" },
  });
  await assert.rejects(
    () => queryStkTransactionStatus(CREDS, { transactionId: "ws_CO_7" }),
    /Bad Request - Invalid IdentifierType/,
  );
});

test("the status result never carries a credential back to the caller", async (t) => {
  stubFetch(t, { json: { ResponseCode: "0", ResultCode: 0, CheckoutRequestID: "ws_CO_8" } });
  const s = await queryStkTransactionStatus(CREDS, { transactionId: "ws_CO_8" });
  const serialised = JSON.stringify(s);
  for (const secret of [CREDS.passkey, CREDS.consumer_secret, CREDS.consumer_key]) {
    assert.equal(serialised.includes(secret), false, "result leaked a credential");
  }
});

// Source-shape guard for the route. The route cannot be imported here (it pulls
// Supabase), so its security-relevant invariants are asserted in the file.
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
  assert.match(src, /checkRateLimit\(/, "must be rate limited");
  // Settlement must require an explicit ResultCode, never a 200 on its own.
  assert.match(src, /status\.resultCode === null/, "a missing ResultCode must not settle");
  // The activation flip stays a compare-and-set, so a late callback is a duplicate.
  assert.match(src, /\.eq\("id", p\.id\)\.eq\("status", "pending"\)\.select\("id"\)/);
  assert.match(src, /applyConfirmedPayment/, "activation must reuse the shared helper");
});

