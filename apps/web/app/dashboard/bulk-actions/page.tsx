"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import PageShell, { Empty, fmtDateTime } from "@/components/PageShell";

type Customer = {
  id: string; customer_no: string; full_name: string;
  phone: string; status: string; expiry_date: string | null;
};
type Job = {
  id: string; kind: string; total: number; succeeded: number;
  failed: number; status: string; created_at: string; finished_at: string | null;
};

type Kind = "suspend" | "resume" | "expire" | "extend" | "notify_expiry";
const ACTIONS: { kind: Kind; label: string; blurb: string; danger?: boolean }[] = [
  { kind: "suspend", label: "Suspend", blurb: "Sets status to suspended. Stops authentication on the next poll." },
  { kind: "resume", label: "Resume", blurb: "Returns suspended customers to active." },
  { kind: "expire", label: "Expire now", blurb: "Ends the subscription today and blocks the account.", danger: true },
  { kind: "extend", label: "Extend", blurb: "Adds days to the expiry date. Expired accounts restart from today." },
  { kind: "notify_expiry", label: "Send expiry SMS", blurb: "Queues a renewal reminder for every phone number on file." },
];
const STATUSES = ["active", "pending", "suspended", "expired", "blocked", "terminated"];

/** Scrollable picker with a sticky header; the page can hold thousands of rows. */
function CustomerTable({ shown, picked, onToggle }: {
  shown: Customer[]; picked: Set<string>; onToggle: (id: string) => void;
}) {
  return (
    <div className="max-h-[520px] overflow-auto">
      <table className="table" style={{ minWidth: 560 }}>
        <thead className="sticky top-0 bg-white">
          <tr><th /><th>Customer</th><th>Phone</th><th>Status</th><th>Expires</th></tr>
        </thead>
        <tbody>
          {!shown.length
            ? <tr><td colSpan={5}><Empty>No customers match.</Empty></td></tr>
            : shown.map((c) => (
              <tr key={c.id} className={picked.has(c.id) ? "bg-indigo-50/60" : undefined}>
                <td>
                  <input type="checkbox" checked={picked.has(c.id)} onChange={() => onToggle(c.id)}
                    aria-label={`Select ${c.full_name}`} className="h-4 w-4 accent-indigo-600" />
                </td>
                <td>
                  <p className="font-semibold text-slate-900">{c.full_name}</p>
                  <p className="text-xs text-slate-400">{c.customer_no}</p>
                </td>
                <td>{c.phone}</td>
                <td>
                  <span className={`badge ${c.status === "active" ? "badge-ok"
                    : c.status === "suspended" || c.status === "blocked" ? "badge-bad" : "badge-mute"}`}>
                    {c.status}
                  </span>
                </td>
                <td className="text-xs text-slate-500">
                  {c.expiry_date ? new Date(c.expiry_date).toLocaleDateString("en-KE") : "—"}
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}


export default function BulkActionsPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("all");
  const [q, setQ] = useState("");
  const [action, setAction] = useState<Kind>("suspend");
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    ok: boolean; text: string; failures?: { customer_no: string; reason: string }[];
  } | null>(null);

  const load = useCallback(async () => {
    const [c, j] = await Promise.all([
      fetch("/api/customers?limit=1000").then((r) => r.json()).catch(() => ({ customers: [] })),
      fetch("/api/bulk-actions").then((r) => r.json()).catch(() => ({ jobs: [] })),
    ]);
    setCustomers(c.customers ?? []);
    setJobs(j.jobs ?? []);
  }, []);
  useEffect(() => { load(); }, [load]);

  const term = q.trim().toLowerCase();
  const shown = useMemo(
    () => customers.filter((c) =>
      (filter === "all" || c.status === filter)
      && (!term
        || c.full_name.toLowerCase().includes(term)
        || c.customer_no.toLowerCase().includes(term)
        || c.phone.includes(term))),
    [customers, filter, term],
  );

  const toggle = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id); else next.add(id);
    setPicked(next);
  };
  const allShown = shown.length > 0 && shown.every((c) => picked.has(c.id));

  async function run() {
    if (!picked.size) { setResult({ ok: false, text: "Select at least one customer first." }); return; }
    setBusy(true); setResult(null);
    const r = await fetch("/api/bulk-actions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: action, customer_ids: [...picked], days }),
    });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setResult({ ok: false, text: j.error ?? "Run failed" }); return; }
    setResult({
      ok: j.failed === 0,
      text: `${j.succeeded} of ${j.total} succeeded${j.failed ? `, ${j.failed} failed` : ""}.`,
      failures: j.failures,
    });
    setPicked(new Set());
    load();
  }

  const chosen = ACTIONS.find((a) => a.kind === action)!;

  return (
    <PageShell
      title="Bulk actions"
      description="Act on many customers at once. Selections are re-checked against your ISP on the server, and every run is recorded below."
    >
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="card-flush overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-3">
            <select className="input sm:max-w-44" value={filter}
              onChange={(e) => setFilter(e.target.value)} aria-label="Status filter">
              <option value="all">All statuses</option>
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <input className="input flex-1 sm:max-w-56" type="search" placeholder="Name, number or phone…"
              value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search customers" />
            <button className="btn-ghost btn-sm ml-auto"
              onClick={() => setPicked(allShown ? new Set() : new Set(shown.map((c) => c.id)))}>
              {allShown ? "Clear page" : "Select page"}
            </button>
          </div>
          <CustomerTable shown={shown} picked={picked} onToggle={toggle} />
        </div>

        <div>
          <div className="card">
            <p className="panel-title mb-3">Run an action</p>
            <p className="mb-3 text-sm text-slate-700">
              <strong>{picked.size}</strong> customer{picked.size === 1 ? "" : "s"} selected
            </p>
            <div className="space-y-1.5">
              {ACTIONS.map((a) => (
                <button key={a.kind} onClick={() => setAction(a.kind)} disabled={busy}
                  className={`w-full rounded-xl border px-3 py-2.5 text-left text-sm font-semibold transition ${
                    action === a.kind
                      ? a.danger
                        ? "border-red-500 bg-red-50 text-red-700"
                        : "border-indigo-600 bg-indigo-50 text-indigo-700"
                      : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                  }`}>
                  {a.label}
                </button>
              ))}
            </div>
            <p className="mt-3 text-xs text-slate-500">{chosen.blurb}</p>
            {action === "extend" && (
              <div className="mt-3">
                <label className="label" htmlFor="days">Days to add</label>
                <input id="days" className="input" type="number" min={1} max={3650} value={days}
                  onChange={(e) => setDays(Number(e.target.value))} />
              </div>
            )}
            <button className={`mt-4 w-full ${chosen.danger ? "btn-danger" : "btn-primary"}`}
              onClick={run} disabled={busy || !picked.size}>
              {busy ? "Running…" : `${chosen.label} ${picked.size || ""}`.trim()}
            </button>
          </div>

          {result && (
            <div className={`mt-4 ${result.ok ? "ok-box" : "err-box"}`}>
              <p className="font-semibold">{result.text}</p>
              {!!result.failures?.length && (
                <ul className="mt-2 space-y-1 text-xs">
                  {result.failures.map((f, i) => (
                    <li key={i}><strong>{f.customer_no}</strong> — {f.reason}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>

      <h2 className="mt-8 text-lg font-bold">Run history</h2>
      <div className="card-flush mt-2 overflow-x-auto">
        {!jobs.length ? <Empty>No bulk runs yet.</Empty> : (
          <table className="table" style={{ minWidth: 700 }}>
            <thead>
              <tr><th>When</th><th>Action</th><th>Total</th><th>Succeeded</th><th>Failed</th><th>Status</th></tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td>{fmtDateTime(j.created_at)}</td>
                  <td className="capitalize">{j.kind.replace(/_/g, " ")}</td>
                  <td>{j.total}</td>
                  <td className="text-emerald-600">{j.succeeded}</td>
                  <td className={j.failed ? "text-red-600" : undefined}>{j.failed}</td>
                  <td>
                    <span className={`badge ${j.status === "done" ? "badge-ok"
                      : j.status === "failed" ? "badge-bad" : "badge-warn"}`}>{j.status}</span>
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

