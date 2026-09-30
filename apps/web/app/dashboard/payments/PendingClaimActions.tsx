"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

// Confirm / reject a manual M-Pesa claim.
//
// The server performs the state change as a compare-and-set on the payment row,
// so a double-click is safe: the second confirm matches zero rows and reports
// "processed" instead of extending the customer twice.
export default function PendingClaimActions({ paymentId }: { paymentId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"confirm" | "reject" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function act(action: "confirm" | "reject") {
    setBusy(action); setErr(null);
    try {
      const r = await fetch(`/api/payments/${paymentId}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Could not update the payment");
      router.refresh();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        <button type="button" className="btn-primary btn-sm" disabled={busy !== null}
          onClick={() => act("confirm")}>
          {busy === "confirm" ? "Confirming…" : "Confirm"}
        </button>
        <button type="button" className="btn-ghost btn-sm" disabled={busy !== null}
          onClick={() => act("reject")}>
          {busy === "reject" ? "Rejecting…" : "Reject"}
        </button>
      </div>
      {err && <p className="max-w-[220px] text-right text-xs text-red-600">{err}</p>}
    </div>
  );
}
