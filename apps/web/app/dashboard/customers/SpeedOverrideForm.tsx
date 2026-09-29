"use client";

import { useState } from "react";

// Per-customer speed override (download AND upload, independently).
// A blank field = no override on that side: blank + blank hands the customer
// back to their package's group. Never pass 0 — 0 kills the override concept.
export default function SpeedOverrideForm({
  customerId, downloadKbps, uploadKbps,
}: {
  customerId: string; downloadKbps: number | null; uploadKbps: number | null;
}) {
  const [down, setDown] = useState(downloadKbps != null ? String(downloadKbps / 1000) : "");
  const [up, setUp] = useState(uploadKbps != null ? String(uploadKbps / 1000) : "");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const overridden = downloadKbps != null || uploadKbps != null;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null); setErr(null); setSaving(true);
    try {
      const res = await fetch(`/api/customers/${customerId}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          download_mbps: down.trim() === "" ? null : Number(down),
          upload_mbps: up.trim() === "" ? null : Number(up),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to save speed override");
      setMsg(json.message ?? "Saved.");
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : "Failed."); }
    finally { setSaving(false); }
  }

  return (
    <form onSubmit={save} className="mt-3 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor={`dl-${customerId}`}>Download (Mbps)</label>
          <input id={`dl-${customerId}`} className="input" inputMode="decimal"
            value={down} onChange={(e) => setDown(e.target.value)}
            placeholder="Blank = package speed" />
        </div>
        <div>
          <label className="label" htmlFor={`ul-${customerId}`}>Upload (Mbps)</label>
          <input id={`ul-${customerId}`} className="input" inputMode="decimal"
            value={up} onChange={(e) => setUp(e.target.value)}
            placeholder="Blank = package speed" />
        </div>
      </div>
      {overridden ? (
        <p className="text-xs font-semibold text-amber-700">
          Override active — this customer ignores their package&apos;s speeds.
        </p>
      ) : (
        <p className="hint">No override — this customer uses their package&apos;s speeds.</p>
      )}
      {msg && <p className="ok-box">{msg}</p>}
      {err && <p className="err-box">{err}</p>}
      <button className="btn-primary w-full" disabled={saving}>
        {saving ? "Saving…" : "Save speed override"}
      </button>
    </form>
  );
}
