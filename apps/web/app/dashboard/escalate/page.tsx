"use client";
import { useCallback, useEffect, useState } from "react";
import PageShell, { Empty, fmtDateTime } from "@/components/PageShell";

type Escalation = {
  id: string; category: string; summary: string; detail: string;
  status: string; created_at: string; resolved_at: string | null;
};

const CATEGORIES = [
  { v: "outage", label: "Outage" },
  { v: "billing", label: "Billing or payments" },
  { v: "router", label: "Router / provisioning" },
  { v: "bug", label: "Something is broken" },
  { v: "data_loss", label: "Data loss or wrong data" },
  { v: "general", label: "General question" },
  { v: "other", label: "Other" },
];

export default function EscalatePage() {
  const [rows, setRows] = useState<Escalation[]>([]);
  const [form, setForm] = useState({
    category: "general", summary: "", detail: "", attach_diagnostics: true,
  });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string; diag?: Record<string, unknown> } | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/escalations");
    if (r.ok) setRows((await r.json()).escalations ?? []);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setResult(null);
    const r = await fetch("/api/escalations", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form),
    });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setResult({ ok: false, text: j.error ?? "Could not raise the escalation" }); return; }
    setResult({ ok: true, text: "Escalation raised. Support will reply in your notifications.", diag: j.diagnostics });
    setForm({ category: "general", summary: "", detail: "", attach_diagnostics: true });
    load();
  }

  const open = rows.filter((r) => r.status !== "resolved").length;

  return (
    <PageShell
      title="Escalate"
      description="Hand a problem to the NETPID platform team. Attach a snapshot of your own health data so support does not have to ask you for screenshots."
    >
      <form onSubmit={send} className="card mb-6">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="e-cat">Category</label>
            <select id="e-cat" className="input" value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })}>
              {CATEGORIES.map((c) => <option key={c.v} value={c.v}>{c.label}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="e-summary">Summary</label>
            <input id="e-summary" className="input" required minLength={5} maxLength={160}
              value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })}
              placeholder="Customers on Ruiru cannot authenticate since 09:00" />
          </div>
        </div>
        <div className="mt-3">
          <label className="label" htmlFor="e-detail">Details</label>
          <textarea id="e-detail" className="input" rows={5} maxLength={8000}
            value={form.detail} onChange={(e) => setForm({ ...form, detail: e.target.value })}
            placeholder="What you expected, what happened instead, and what you have already tried." />
        </div>
        <label className="mt-3 flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={form.attach_diagnostics} className="h-4 w-4 accent-indigo-600"
            onChange={(e) => setForm({ ...form, attach_diagnostics: e.target.checked })} />
          Attach diagnostics (router and customer counts, app version) — no customer names or phone numbers
        </label>
        <button className="btn-primary mt-4" type="submit" disabled={busy}>
          {busy ? "Sending…" : "Raise escalation"}
        </button>
      </form>

      {result && (
        <div className={`mb-6 ${result.ok ? "ok-box" : "err-box"}`}>
          <p className="font-semibold">{result.text}</p>
          {result.diag && (
            <p className="mt-1 text-xs">
              Attached: {Object.entries(result.diag).filter(([k]) => k !== "captured_at")
                .map(([k, v]) => `${k}=${v}`).join(" · ")}
            </p>
          )}
        </div>
      )}

      <h2 className="text-lg font-bold">Your escalations ({open} open)</h2>
      <div className="card-flush mt-2 overflow-x-auto">
        {!rows.length
          ? <Empty>You have not raised any escalations.</Empty>
          : (
            <table className="table" style={{ minWidth: 700 }}>
              <thead><tr><th>Raised</th><th>Category</th><th>Summary</th><th>Status</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="text-xs text-slate-500">{fmtDateTime(r.created_at)}</td>
                    <td className="capitalize">{r.category}</td>
                    <td>
                      <p className="font-semibold text-slate-900">{r.summary}</p>
                      {r.detail && <p className="max-w-md truncate text-xs text-slate-500">{r.detail}</p>}
                    </td>
                    <td>
                      <span className={`badge ${r.status === "resolved" ? "badge-ok"
                        : r.status === "ack" ? "badge-warn" : "badge-info"}`}>{r.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
    </PageShell>
  );
}
