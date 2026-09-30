"use client";
import { useEffect, useRef, useState } from "react";

// Public checkout form. It talks only to /api/portal/[slug]/pay — the public,
// session-less endpoint. Nothing in this component can name a price or activate
// an account: the server prices the package and only the verified Daraja
// callback (or an operator confirming a receipt) grants service.
export default function BuyForm({
  slug, packageId, price, instructions, support,
}: {
  slug: string; packageId: string; price: number;
  instructions: string | null; support: string;
}) {
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [receipt, setReceipt] = useState("");
  const [mode, setMode] = useState<"stk" | "manual">("stk");
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
          stop(); setWaiting(false); setMode("manual");
          setErr("That M-Pesa payment did not go through. Try again, or pay manually and submit the receipt.");
        }
      } catch { /* transient network blip — keep polling */ }
      if (tries >= 20) {
        stop(); setWaiting(false);
        setErr("Still waiting for M-Pesa. If you were not charged, try again or pay manually below.");
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
          kind: mode, mpesa_receipt: mode === "manual" ? receipt.trim() : "",
        }),
      });
      const j = await r.json();
      if (r.status === 422) {
        // This ISP has not connected Daraja. The server says so explicitly and
        // the manual path is the supported fallback — never a dead end.
        setMode("manual");
        setErr(j.error ?? "STK Push is not available yet.");
        return;
      }
      if (!r.ok) throw new Error(j.error ?? "Could not start the payment");
      if (mode === "stk") { setMsg(j.message); poll(j.payment_id); }
      else { setDone(true); setMsg(j.message); }
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
        <button type="button" onClick={() => { setMode("stk"); setErr(null); }}
          className={mode === "stk" ? "btn-primary btn-sm" : "btn-ghost btn-sm"}>
          Pay with M-Pesa
        </button>
        <button type="button" onClick={() => { setMode("manual"); setErr(null); }}
          className={mode === "manual" ? "btn-primary btn-sm" : "btn-ghost btn-sm"}>
          Already paid
        </button>
      </div>

      <div>
        <label className="label" htmlFor="buy-phone">M-Pesa number</label>
        <input id="buy-phone" className="input" required inputMode="tel"
          placeholder="07…" value={phone} onChange={(e) => setPhone(e.target.value)} />
      </div>

      {mode === "stk" && (
        <div>
          <label className="label" htmlFor="buy-name">Your name (optional)</label>
          <input id="buy-name" className="input" value={name}
            onChange={(e) => setName(e.target.value)} placeholder="e.g. Brian O." />
        </div>
      )}

      {mode === "manual" && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
          <p className="text-xs font-bold uppercase tracking-wide text-slate-500">
            How to pay {shillings}
          </p>
          <p className="mt-1 whitespace-pre-line text-sm text-slate-700">
            {instructions?.trim()
              ? instructions
              : `Pay ${shillings} to the operator's M-Pesa Till/PayBill, then enter the M-Pesa receipt code below.`}
          </p>
          <label className="label mt-3" htmlFor="buy-receipt">M-Pesa receipt code</label>
          <input id="buy-receipt" className="input" value={receipt}
            onChange={(e) => setReceipt(e.target.value.toUpperCase())}
            placeholder="e.g. QHX4…7K" />
          <p className="mt-1 text-xs text-slate-500">
            Your account is activated as soon as the operator confirms this receipt.
          </p>
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
          : mode === "stk" ? `Pay ${shillings} with M-Pesa`
          : "Submit receipt"}
      </button>
    </form>
  );
}
