// The Daraja callback is the single point where money becomes service: a
// payment row flips to 'completed' and the customer's expiry is extended. These
// tests pin the parser, because everything the route decides (activate,
// reject-as-failure, reject-as-mismatch, reject-as-unparseable) is derived from
// what parseDarajaCallback returns.
//
// Why this test lives under network-worker/test: that glob is the repo's only
// test harness (`node --test "network-worker/test/*.test.js"`), and there is no
// root package.json or CI workflow. `lib/daraja-push.ts` is imported directly —
// Node 24 strips the types, and that module's only import is a type-only import
// of ./daraja, so it carries no runtime dependency on Supabase.
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseDarajaCallback,
  sendStkPush,
  signCallback,
  verifyDarajaCreds,
} from "../../apps/web/lib/daraja-push.ts";

// Verbatim shape of a real Safaricom STK success notification.
function successPayload(overrides = {}) {
  return {
    Body: {
      stkCallback: {
        MerchantRequestID: "29115-34620561-1",
        CheckoutRequestID: "ws_CO_191220191020363925",
        ResultCode: 0,
        ResultDesc: "The service request is processed successfully.",
        CallbackMetadata: {
          Item: [
            { Name: "Amount", Value: 100 },
            { Name: "MpesaReceiptNumber", Value: "NLJ7RT61SV" },
            { Name: "TransactionDate", Value: 20191219102115 },
            { Name: "PhoneNumber", Value: 254708374149 },
          ],
        },
        ...overrides,
      },
    },
  };
}

test("a successful callback exposes the identifiers the route keys on", () => {
  const cb = parseDarajaCallback(successPayload());
  assert.ok(cb, "a well-formed success payload must parse");
  assert.equal(cb.resultCode, 0);
  assert.equal(cb.checkoutRequestId, "ws_CO_191220191020363925");
  assert.equal(cb.merchantRequestId, "29115-34620561-1");
  assert.equal(cb.mpesaReceipt, "NLJ7RT61SV");
  assert.equal(cb.phone, "254708374149");
  assert.equal(cb.amount, 100);
});

test("Amount is whole shillings, so the route must scale it to minor units", () => {
  // payments.amount is KES cents (the UI renders price / 100) while Daraja
  // quotes whole shillings. The callback multiplies by 100; sendStkPush divides
  // by 100. If either side drifts, every real payment is rejected as a mismatch.
  const cb = parseDarajaCallback(successPayload());
  assert.equal(Math.round(cb.amount * 100), 10000);
});

test("a cancelled push parses without a receipt, so it is rejected as failed", () => {
  // Safaricom omits CallbackMetadata entirely on failure. The route must reach
  // the ResultCode branch — not mislabel this an "amount mismatch".
  const cb = parseDarajaCallback({
    Body: {
      stkCallback: {
        MerchantRequestID: "29115-34620561-1",
        CheckoutRequestID: "ws_CO_191220191020363925",
        ResultCode: 1032,
        ResultDesc: "Request cancelled by the user",
      },
    },
  });
  assert.ok(cb, "a cancelled push is still a parseable callback");
  assert.equal(cb.resultCode, 1032);
  assert.equal(cb.checkoutRequestId, "ws_CO_191220191020363925");
  assert.equal(cb.amount, null);
  assert.equal(cb.mpesaReceipt, null);
});

test("an unknown or missing CheckoutRequestID is unparseable, not activatable", () => {
  const missingId = parseDarajaCallback({
    Body: { stkCallback: { ResultCode: 0, ResultDesc: "ok" } },
  });
  // ResultCode is present, so this parses — but with an empty id, which is what
  // the route's `!cb.checkoutRequestId` guard catches.
  assert.ok(missingId);
  assert.equal(missingId.checkoutRequestId, "");
});

test("ResultCode must be a number, so a string cannot sneak past the 0 gate", () => {
  // `=== 0` on the string "0" is false while Number("0") would be true.
  // Requiring a real number keeps the activation gate off loose coercion.
  assert.equal(parseDarajaCallback(successPayload({ ResultCode: "0" })), null);
});

test("a malformed body is rejected rather than throwing", () => {
  for (const bad of [
    null,
    undefined,
    {},
    { Body: {} },
    { Body: { stkCallback: {} } },
    "not json",
    42,
    [],
  ]) {
    assert.equal(
      parseDarajaCallback(bad),
      null,
      `expected null for ${JSON.stringify(bad)}`,
    );
  }
});

test("the signature helper is deterministic and key-dependent", () => {
  const raw = JSON.stringify(successPayload());
  assert.equal(signCallback(raw, "pass-key"), signCallback(raw, "pass-key"));

test("sendStkPush refuses to push when Daraja rejects the request", async (t) => {
  // No network: the real fetch is replaced so the request body can be inspected.
  const calls = [];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    if (String(url).includes("/oauth/v1/generate")) {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: "3599" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      ResponseCode: "1", ResponseDescription: "The initiator information is invalid.",
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const creds = {
    consumer_key: "ck", consumer_secret: "cs", passkey: "pk",
    shortcode: "174379", environment: "sandbox",
  };
  await assert.rejects(
    () => sendStkPush(creds, {
      phone: "254708374149", amountMinor: 10000,
      accountRef: "C-0001", callbackUrl: "https://example.test/cb",
    }),
    /initiator information is invalid/,
  );
  assert.equal(calls.length, 2, "one token call, one push call");
});

test("sendStkPush converts minor units to whole shillings and signs correctly", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let pushBody = null;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/oauth/v1/generate")) {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: "3599" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    pushBody = JSON.parse(init.body);
    return new Response(JSON.stringify({
      ResponseCode: "0", MerchantRequestID: "m-1", CheckoutRequestID: "c-1",
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const creds = {
    consumer_key: "ck", consumer_secret: "cs", passkey: "pk",
    shortcode: "174379", environment: "sandbox",
  };
  const res = await sendStkPush(creds, {
    phone: "254708374149", amountMinor: 10000,
    accountRef: "C-0001", callbackUrl: "https://example.test/cb",
  });

  assert.deepEqual(res, { merchantRequestId: "m-1", checkoutRequestId: "c-1" });
  assert.equal(pushBody.Amount, 100, "10000 cents must be sent as 100 shillings");
  assert.equal(pushBody.PartyA, pushBody.PhoneNumber);
  assert.equal(pushBody.BusinessShortCode, "174379");
  assert.equal(pushBody.CallBackURL, "https://example.test/cb");
  // Password is base64(shortcode + passkey + 14-digit timestamp).
  const decoded = Buffer.from(pushBody.Password, "base64").toString();
  assert.equal(decoded, `174379pk${pushBody.Timestamp}`);
  assert.match(pushBody.Timestamp, /^\d{14}$/);
});

test("one platform app collects into each ISP's own Till, and never the app's", async (t) => {
  // NETPID authenticates with ONE app (migration 0044) but must name the
  // RECEIVER per push. This is the property the whole platform-app change rests
  // on: the OAuth token and the passkey belong to the platform, while
  // BusinessShortCode and PartyB must be the individual ISP's Till. Getting this
  // backwards is what sent a customer to a Daraja sandbox account while the
  // operator's own till sat unused.
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });

  const authHeaders = [];
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/oauth/v1/generate")) {
      authHeaders.push(init.headers.authorization);
      return new Response(JSON.stringify({ access_token: "tok", expires_in: "3599" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({
      ResponseCode: "0", MerchantRequestID: "m-1", CheckoutRequestID: "c-1",
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  // The platform half, identical for every ISP.
  const platform = { consumer_key: "PLATFORM_CK", consumer_secret: "PLATFORM_CS", passkey: "PLATFORM_PK" };
  // Two ISPs, each with their own Till. getDarajaCreds() composes exactly this.
  const ispOne = { ...platform, shortcode: "5441898", environment: "production" };
  const ispTwo = { ...platform, shortcode: "2211000", environment: "production" };

  for (const creds of [ispOne, ispTwo]) {
    await sendStkPush(creds, {
      phone: "254708374149", amountMinor: 10000,
      accountRef: "C-0001", callbackUrl: "https://example.test/cb",
    });
  }

  assert.equal(bodies.length, 2);
  // Each push collects into THAT ISP's Till, as both the shortcode and PartyB.
  assert.equal(bodies[0].BusinessShortCode, "5441898");
  assert.equal(bodies[0].PartyB, "5441898");
  assert.equal(bodies[1].BusinessShortCode, "2211000");
  assert.equal(bodies[1].PartyB, "2211000");

  // The password signs with the RECEIVER's shortcode and the PLATFORM passkey.
  // If it ever used the app's own shortcode, Safaricom would reject the push.
  const decoded = Buffer.from(bodies[0].Password, "base64").toString();
  assert.equal(decoded, `5441898PLATFORM_PK${bodies[0].Timestamp}`);

  // Authentication is the platform's, so both ISPs share one token: the cache
  // is keyed on environment + consumer key, and there is exactly one OAuth call
  // for the pair. Keying it on the shortcode would have fetched a token per ISP.
  assert.equal(authHeaders.length, 1, "both ISPs must reuse the platform token");
  const expected = `Basic ${Buffer.from("PLATFORM_CK:PLATFORM_CS").toString("base64")}`;
  assert.equal(authHeaders[0], expected);

  // Production really is production. A sandbox app collects every approval into
  // a Safaricom test account while the operator believes they are taking money,
  // so the environment must select the production host and not merely be passed
  // along in the payload.
  const urls = [];
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, init) => {
    urls.push(String(url));
    if (String(url).includes("/oauth/v1/generate")) {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: "3599" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      ResponseCode: "0", MerchantRequestID: "m-1", CheckoutRequestID: "c-1",
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  await sendStkPush(ispOne, {
    phone: "254708374149", amountMinor: 10000,
    accountRef: "C-0001", callbackUrl: "https://example.test/cb",
  });
  assert.ok(
    urls.every((u) => u.startsWith("https://api.safaricom.co.ke")),
    `production must hit the live host, got: ${urls.join(", ")}`,
  );
});

  assert.notEqual(signCallback(raw, "pass-key"), signCallback(raw, "other-key"));

test("verifyDarajaCreds rejects bad credentials even when a token is cached", async (t) => {
  // daraja-config calls this before marking a provider 'active'. It must bypass
  // the token cache, otherwise correcting a wrong secret would appear to
  // succeed after any earlier token request for the same shortcode.
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });

  let status = 200;
  let hits = 0;
  globalThis.fetch = async () => {
    hits += 1;
    return new Response(JSON.stringify({ access_token: "tok", expires_in: "3599" }), {
      status, headers: { "content-type": "application/json" },
    });
  };

  const good = {
    consumer_key: "ck", consumer_secret: "cs", passkey: "pk",
    shortcode: "999999", environment: "sandbox",
  };
  await verifyDarajaCreds(good);
  await verifyDarajaCreds(good);
  assert.equal(hits, 2, "verification must not be served from the cache");

  status = 401;
  await assert.rejects(
    () => verifyDarajaCreds(good),
    /Daraja OAuth HTTP 401/,
    "a rejected credential set must throw so the caller can disable the provider",
  );
});

});
