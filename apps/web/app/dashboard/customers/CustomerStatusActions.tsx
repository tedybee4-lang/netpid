"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Kind = "suspend" | "resume" | "expire";

/**
 * Suspend / resume / expire a single customer.
 *
 * This deliberately posts to /api/bulk-actions with a one-element id list rather
 * than adding a second implementation of the same rules: that route already owns
 * the transition guards (resume only from suspended, expire not from terminated…),
 * writes a bulk_jobs audit row, and re-checks every id against the caller's ISP.
 * Duplicating it here would let the two drift.
 *
 * Status changes take effect on the worker's next poll — isEnabledForStatus()
 * only authorizes "active" — so the copy tells the operator that honestly
 * instead of implying an instant cut-off.
 */
export default function CustomerStatusActions({
  customerId, status,
}: { customerId: string; status: string }) {
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<Kind | null>(null);

  // Mirror the guards in /api/bulk-actions so we never offer an action that the
  // API is going to reject as "Already in that state".
  const isSuspended = status === "suspended";
  const canExpire = !["expired", "suspended", "terminated"].includes(status);
  // Annotated on the array itself (not on the .filter() result): the contextual
  // type would not otherwise reach the literal, and `kind` would widen to string.
  const allActions: { kind: Kind; label: string; danger?: boolean; show: boolean }[] = [
    { kind: "suspend", label: "Suspend", danger: true, show: !isSuspended },
    { kind: "resume", label: "Resume", show: isSuspended },
    { kind: "expire", label: "Expire now", danger: true, show: canExpire },
  ];
  const actions = allActions.filter((a) => a.show);

  if (!actions.length) return null;

  async function run(kind: Kind, label: string) {
    const verb = kind === "resume" ? "resume" : kind;
    if (!confirm(`${label} this customer? They stop authenticating on the next poll.`)) return;
    setErr(null);
    setBusy(kind);
    try {
      const res = await fetch("/api/bulk-actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, customer_ids: [customerId] }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `Failed to ${verb}`);
      if (Array.isArray(json.failures) && json.failures.length) {
        throw new Error(json.failures[0]?.reason ?? "No change was made.");
      }
      router.refresh();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {actions.map((a) => (
          <button
            key={a.kind}
            type="button"
            disabled={busy !== null}
            onClick={() => run(a.kind, a.label)}
            className={
              a.danger
                ? "btn-ghost btn-sm border-red-200 text-red-700 hover:bg-red-50 disabled:opacity-50"
                : "btn-ghost btn-sm disabled:opacity-50"
            }
          >
            {busy === a.kind ? "Working…" : a.label}
          </button>
        ))}
      </div>
      {err && <p className="err-box mt-2">{err}</p>}
      <p className="hint">
        Takes effect on the next worker poll, not the instant you click.
      </p>
    </div>
  );
}
