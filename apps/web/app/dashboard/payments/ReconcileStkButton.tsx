"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

// Reconcile a Safaricom STK payment whose callback never arrived.
//
// The normal activation path is Daraja's callback. This button is the recovery
// path: it asks Daraja directly for the transaction's status, so an operator can
// settle a payment the customer genuinely made without inventing a manual
// receipt. It is only offered for a PENDING Daraja payment that has a
// CheckoutRequestID — a completed payment has nothing left to reconcile.
export default function ReconcileStkButton({ paymentId }: { paymentId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function check() {
    setBusy(true); setMsg(null); setErr(null);
    try {
      const res = await fetch(`/api/payments/${paymentId}/status`, { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(j.error ?? "Could not reach Safaricom."); return; }
      if (j.settled) {
        setMsg(j.already === "processed"
          ? "Already settled — nothing to do."
          : `Daraja reports this payment completed. Service is active${j.expiry ? ` until ${new Date(j.expiry).toLocaleDateString()}` : ""}.`);
      } else {
        setMsg(j.message ?? `Safaricom result code ${j.result_code ?? "none"}.`);
      }
      router.refresh();
    } catch {
      setErr("Could not reach Safaricom. Check this ISP's Daraja settings.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <button className="btn-primary" onClick={check} disabled={busy}>
        {busy ? "Asking Safaricom…" : "Check status with Safaricom"}
      </button>
      {msg && <p className="max-w-xs text-right text-xs text-slate-600">{msg}</p>}
      {err && <p className="max-w-xs text-right text-xs text-amber-800">{err}</p>}
    </div>
  );
}
