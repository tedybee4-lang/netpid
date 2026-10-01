"use client";
import { useEffect, useRef, useState } from "react";

// Public checkout form. It talks only to /api/portal/[slug]/pay — the public,
// session-less endpoint. Nothing in this component can name a price or activate
// an account: the server prices the package and only the verified Daraja
// callback (or an operator confirming a receipt) grants service.
export default function BuyForm({
  slug, packageId, price, support, stkAvailable,}: {
  slug: string; packageId: string; price: number;  support: string;
  /**
   * Whether this ISP has a verified Daraja app. When false the form opens on
   * the manual till: an STK-first form on an ISP with no Daraja makes the
   * customer press a button that can only fail, and hides the till number they
   * actually need.
   */
  stkAvailable: boolean;
}) {
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const shillings = `KSh ${(price / 100).toLocaleString("en-KE")}`;

  // A buyer who closes the tab must not leave an interval polling forever.
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);

  function stop() { if (timer.current) { clearInterval(timer.current); timer.current = null; } }

  // STK Push is asynchronous: Safaricom confirms out-of-band and the callback
  // flips the row to 'completed'. Poll until that happens, or give up quietly
  // after ~60s and hand the buyer the manual route instead of a spinner.
  function poll(paymentId: string) {
    setWaiting(true);
    let tries = 0;
    timer.current = setInterval(async () => {
      tries += 1;
      try {
        const r = await fetch(
          `/api/portal/${slug}/pay?payment_id=${paymentId}&phone=${encodeURIComponent(phone)}`,
        );
        const j = await r.json();
        if (j.status === "completed") {
          stop(); setWaiting(false); setDone(true);
          setMsg("Payment received. You're connected — log in with the details you were sent.");
        } else if (j.status === "failed" || j.status === "cancelled") {
          stop(); setWaiting(false);
          setErr("That M-Pesa payment did not go through. Check your M-Pesa app for the "
            + "request, then try again.");
        }
      } catch { /* transient network blip — keep polling */ }
      if (tries >= 20) {
        stop(); setWaiting(false);
        setErr("Still waiting for M-Pesa. If you were not charged, please try again.");
      }
    }, 3000);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr(null); setMsg(null); setBusy(true);
    try {
      const r = await fetch(`/api/portal/${slug}/pay`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          package_id: packageId, phone, full_name: name,
          kind: "stk", mpesa_receipt: "",
        }),
      });
      const j = await r.json();
      if (r.status === 422) {
        // No platform app, or this ISP has no Till declared. There is no manual
        // fallback on the portal any more, so say what is actually missing.
        setErr(j.error ?? "M-Pesa is not available for this network yet.");
        return;
      }
      if (!r.ok) throw new Error(j.error ?? "Could not start the payment");
      setMsg(j.message); poll(j.payment_id);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Something went wrong. Try again.");
    } finally { setBusy(false); }
  }

  if (done) {
    return (
      <div className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
        <p className="font-bold text-emerald-900">Order received</p>
        <p className="mt-1 text-sm text-emerald-800">{msg}</p>
        <p className="mt-2 text-xs text-emerald-700">Questions? {support}</p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="mt-5 space-y-3 text-left">
      <div className="flex gap-2 text-sm">
        <span className="btn-primary btn-sm cursor-default">
          Pay with M-Pesa
        </span>
        {!stkAvailable && (
          <span className="text-xs text-slate-500">
            M-Pesa is being set up for this network. Please check back shortly.
          </span>
        )}
      </div>

      <div>
        <label className="label" htmlFor="buy-phone">M-Pesa number</label>
        <input id="buy-phone" className="input" required inputMode="tel"
          placeholder="07…" value={phone} onChange={(e) => setPhone(e.target.value)} />
      </div>

      {stkAvailable && (
        <div>
          <label className="label" htmlFor="buy-name">Your name (optional)</label>
          <input id="buy-name" className="input" value={name}
            onChange={(e) => setName(e.target.value)} placeholder="e.g. Brian O." />
        </div>
      )}

      {err && <p className="err-box">{err}</p>}
      {msg && !err && <p className="text-sm text-slate-600">{msg}</p>}
      {waiting && (
        <p className="text-sm text-slate-600">
          Waiting for you to enter your M-Pesa PIN… keep this page open.
        </p>
      )}

      <button className="btn-primary w-full" disabled={busy || waiting}>
        {busy ? "Starting…"
          : waiting ? "Waiting for M-Pesa…"
          : `Pay ${shillings} with M-Pesa`}
      </button>
    </form>
  );
}
