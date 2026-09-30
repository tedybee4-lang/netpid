import crypto from "crypto";
import type { DarajaCreds } from "./daraja";

function baseUrl(env: string): string {
  return env === "production"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";
}

const TOKEN_CACHE = new Map<string, { token: string; exp: number }>();

// Keyed by environment + shortcode + consumer key: two ISPs can share a
// shortcode, and sandbox/production tokens are not interchangeable.
function cacheKey(c: DarajaCreds): string {
  return `${c.environment}:${c.shortcode}:${c.consumer_key}`;
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
  /** "0" = accepted the query request. NOT the payment outcome. */
  responseCode: string;
  responseDescription: string;
  /** null when Daraja did not report a status. */
  transactionStatus: string | null;
  checkoutRequestId: string | null;
  merchantRequestId: string | null;
  /** ResultCode from the underlying STK push, when Daraja echoes it. */
  resultCode: number | null;
  resultDesc: string | null;
};

function readStatus(body: Record<string, unknown>): DarajaStatusResult {
  const num = (v: unknown) => (v === undefined || v === null || v === "" ? null : Number(v));
  return {
    responseCode: String(body.ResponseCode ?? ""),
    responseDescription: String(body.ResponseDescription ?? ""),
    transactionStatus: body.TransactionStatus ? String(body.TransactionStatus) : null,
    checkoutRequestId: body.CheckoutRequestID ? String(body.CheckoutRequestID) : null,
    merchantRequestId: body.MerchantRequestID ? String(body.MerchantRequestID) : null,
    resultCode: num(body.ResultCode),
    resultDesc: body.ResultDesc ? String(body.ResultDesc) : null,
  };
}

/**
 * M-Pesa Express Transaction Status Query.
 *
 * This is the recovery path for a callback that never arrived — the request was
 * accepted by Daraja (CheckoutRequestID exists) but the handset was offline, the
 * user walked away, or Safaricom's notification was dropped. Querying is safe
 * and read-only against Daraja, so an operator can reconcile a stuck payment
 * without inventing a manual receipt.
 *
 * It is deliberately NOT a substitute for the callback: only the activation
 * rules in the callback route decide that money became service.
 */
export async function queryStkTransactionStatus(
  c: DarajaCreds,
  opts: { transactionId: string },
): Promise<DarajaStatusResult> {
  const token = await accessToken(c);
  const res = await fetch(`${baseUrl(c.environment)}/mpesa/transactionstatus/v1/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      InitiatorSecurityCredential: c.passkey,
      SecurityCredential: c.passkey,
      TransactionID: opts.transactionId,
      ShortCode: c.shortcode,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(String(body.ResponseDescription ?? `Daraja transaction status HTTP ${res.status}`));
  }
  return readStatus(body);
}

/** True when a status query says the money definitively settled. */
export function statusSucceeded(s: DarajaStatusResult): boolean {
  return s.transactionStatus?.toLowerCase() === "completed";
}

/** True when Daraja says the STK push definitively failed and will not settle. */
export function statusFailed(s: DarajaStatusResult): boolean {
  const t = s.transactionStatus?.toLowerCase();
  return t === "failed" || t === "reversed" || t === "reversed earlier";
}

/** True when the request is accepted but the payment has not settled yet. */
export function statusPending(s: DarajaStatusResult): boolean {
  const t = s.transactionStatus?.toLowerCase();
  return t === "in progress" || t === "pending" || t === "queued";
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
