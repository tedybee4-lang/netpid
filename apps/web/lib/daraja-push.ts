import crypto from "crypto";
import type { DarajaCreds } from "./daraja";

function baseUrl(env: string): string {
  return env === "production"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";
}

const TOKEN_CACHE = new Map<string, { token: string; exp: number }>();

// Keyed by environment + consumer key ONLY. The OAuth token belongs to the
// app, not to a shortcode, and there is one app for the whole platform while
// every ISP has their own shortcode. Keying on the shortcode fetched a fresh
// token per ISP and cached it against a value that never varied.
function cacheKey(c: DarajaCreds): string {
  return `${c.environment}:${c.consumer_key}`;
}

async function accessToken(c: DarajaCreds, force = false): Promise<string> {
  const key = cacheKey(c);
  const cached = TOKEN_CACHE.get(key);
  if (!force && cached && cached.exp > Date.now() + 30_000) return cached.token;
  const auth = Buffer.from(`${c.consumer_key}:${c.consumer_secret}`).toString("base64");
  const res = await fetch(`${baseUrl(c.environment)}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { authorization: `Basic ${auth}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Daraja OAuth HTTP ${res.status}`);
  const body = (await res.json()) as { access_token?: string; expires_in?: string };
  if (!body.access_token) throw new Error("Daraja OAuth returned no token");
  TOKEN_CACHE.set(key, {
    token: body.access_token,
    exp: Date.now() + Number(body.expires_in ?? 3600) * 1000,
  });
  return body.access_token;
}

/**
 * Prove a candidate credential set against Daraja before it is marked active.
 * Bypasses the cache so a corrected secret is actually re-tested. Throws with
 * Safaricom's own reason on rejection.
 */
export async function verifyDarajaCreds(c: DarajaCreds): Promise<void> {
  await accessToken(c, true);
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export type StkResult = { merchantRequestId: string; checkoutRequestId: string };

/** Send an STK push. amountMinor is KES cents; Daraja wants whole shillings. */
export async function sendStkPush(
  c: DarajaCreds,
  opts: { phone: string; amountMinor: number; accountRef: string; callbackUrl: string },
): Promise<StkResult> {
  const amount = Math.max(1, Math.round(opts.amountMinor / 100));
  const ts = timestamp();
  const password = Buffer.from(`${c.shortcode}${c.passkey}${ts}`).toString("base64");
  const token = await accessToken(c);
  const res = await fetch(`${baseUrl(c.environment)}/mpesa/stkpush/v1/processrequest`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      BusinessShortCode: c.shortcode,
      Password: password,
      Timestamp: ts,
      TransactionType: "CustomerPayBillOnline",
      Amount: amount,
      PartyA: opts.phone,
      PartyB: c.shortcode,
      PhoneNumber: opts.phone,
      CallBackURL: opts.callbackUrl,
      AccountReference: opts.accountRef.slice(0, 20) || "NETPID",
      TransactionDesc: `NETPID ${opts.accountRef.slice(0, 40)}`,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => ({}))) as {
    ResponseCode?: string; ResponseDescription?: string;
    MerchantRequestID?: string; CheckoutRequestID?: string;
  };
  if (!res.ok || body.ResponseCode !== "0" || !body.CheckoutRequestID) {
    throw new Error(body.ResponseDescription ?? `Daraja STK HTTP ${res.status}`);
  }
  return { merchantRequestId: body.MerchantRequestID ?? "", checkoutRequestId: body.CheckoutRequestID };
}

export type DarajaStatusResult = {
  /** "0" = the QUERY was accepted. NOT the payment outcome. */
  responseCode: string;
  responseDescription: string;
  /**
   * The STK push's own result, using the same vocabulary as the callback.
   * 0 = the customer paid. Non-zero = it did not (1032 = cancelled, etc).
   * null = Daraja did not report one, which must never be read as success.
   */
  resultCode: number | null;
  resultDesc: string | null;
  checkoutRequestId: string | null;
  merchantRequestId: string | null;
};

function readStatus(body: Record<string, unknown>): DarajaStatusResult {
  const raw = body.ResultCode;
  // ResultCode must be a real JSON number, exactly as the callback parser
  // requires. Coercing here would let a string "0" settle a payment that the
  // callback path would refuse, so the two paths disagreed about the one value
  // that issues service. An unrecognised code fails closed: it leaves the
  // payment pending for an operator rather than activating on a guess.
  const resultCode = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
  return {
    responseCode: String(body.ResponseCode ?? ""),
    responseDescription: String(body.ResponseDescription ?? ""),
    resultCode,
    resultDesc: body.ResultDesc ? String(body.ResultDesc) : null,
    checkoutRequestId: body.CheckoutRequestID ? String(body.CheckoutRequestID) : null,
    merchantRequestId: body.MerchantRequestID ? String(body.MerchantRequestID) : null,
  };
}

/**
 * Lipa na M-Pesa Online — STK transaction status.
 *
 * This is the reconciliation path for a callback that never arrived: the request
 * was accepted by Daraja (a CheckoutRequestID exists) but the handset was
 * offline, the customer walked away, or the notification was dropped. The payment
 * then sits at 'pending' forever while the customer has already paid.
 *
 * ENDPOINT: /mpesa/stkpushquery/v1/query. NOT the generic
 * /mpesa/transactionstatus/v1/query, which is a different product with a
 * different (Initiator-style) contract that this app is not provisioned for and
 * which answers "Invalid IdentifierType" / "Invalid Initiator". The one that
 * answers for an STK CheckoutRequestID is stkpushquery.
 *
 * AUTH: the same shape as the STK push itself - BusinessShortCode plus a
 * Password of base64(shortcode + passkey + timestamp). There is no
 * InitiatorSecurityCredential on this endpoint.
 *
 * OUTCOME: carried by ResultCode, the same vocabulary the callback uses. 0 means
 * the customer paid. A successful HTTP response on its own means only that the
 * query was accepted, so nothing here may settle a payment without an explicit
 * ResultCode of 0.
 *
 * It is deliberately NOT a substitute for the callback's amount check: this
 * endpoint does not return the amount, so it can only ever confirm that Daraja
 * recorded this request as settled, never re-price it.
 */
export async function queryStkTransactionStatus(
  c: DarajaCreds,
  opts: { transactionId: string },
): Promise<DarajaStatusResult> {
  const token = await accessToken(c);
  const ts = timestamp();
  const password = Buffer.from(`${c.shortcode}${c.passkey}${ts}`).toString("base64");
  const res = await fetch(`${baseUrl(c.environment)}/mpesa/stkpushquery/v1/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      BusinessShortCode: c.shortcode,
      Password: password,
      Timestamp: ts,
      CheckoutRequestID: opts.transactionId,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || body.ResponseCode !== "0") {
    // Errors here arrive as errorMessage/errorCode; a rejected QUERY is not a
    // failed PAYMENT and must not be reported as one.
    throw new Error(String(
      body.errorMessage ?? body.ResponseDescription ?? `Daraja transaction status HTTP ${res.status}`,
    ));
  }
  return readStatus(body);
}

/** True only when Daraja reports the push itself completed. */
export function statusSucceeded(s: DarajaStatusResult): boolean {
  return s.resultCode === 0;
}

/** True when Daraja reports the push definitively did not complete. */
export function statusFailed(s: DarajaStatusResult): boolean {
  return s.resultCode !== null && s.resultCode !== 0;
}

export type DarajaCallback = {
  resultCode: number; resultDesc: string;
  merchantRequestId: string; checkoutRequestId: string;
  mpesaReceipt: string | null; amount: number | null; phone: string | null;
};

export function parseDarajaCallback(body: unknown): DarajaCallback | null {
  const stk = (body as Record<string, unknown> | null)?.Body as Record<string, unknown> | undefined;
  const cb = stk?.stkCallback as Record<string, unknown> | undefined;
  if (!cb || typeof cb.ResultCode !== "number") return null;
  let amount: number | null = null;
  let receipt: string | null = null;
  let phone: string | null = null;
  const items = (cb.CallbackMetadata as Record<string, unknown> | undefined)?.Item as
    | { Name?: string; Value?: unknown }[] | undefined;
  if (Array.isArray(items)) {
    for (const it of items) {
      if (it.Name === "Amount") amount = Number(it.Value ?? 0);
      if (it.Name === "MpesaReceiptNumber") receipt = String(it.Value ?? "");
      if (it.Name === "PhoneNumber") phone = String(it.Value ?? "");
    }
  }
  return {
    resultCode: cb.ResultCode,
    resultDesc: String(cb.ResultDesc ?? ""),
    merchantRequestId: String(cb.MerchantRequestID ?? ""),
    checkoutRequestId: String(cb.CheckoutRequestID ?? ""),
    mpesaReceipt: receipt || null,
    amount,
    phone,
  };
}

/** HMAC of the raw callback with the ISP's passkey — replay/forge guard. */
export function signCallback(raw: string, passkey: string): string {
  return crypto.createHmac("sha256", passkey).update(raw).digest("hex");
}
