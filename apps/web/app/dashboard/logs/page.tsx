"use client";
import { useCallback, useEffect, useState } from "react";
import PageShell, { Empty, fmtDateTime } from "@/components/PageShell";

type LogRow = {
  id: string; at: string; kind: string; summary: string;
  status: "ok" | "warn" | "bad"; source: string; detail?: Record<string, unknown>;
};
const KINDS = ["all", "Router", "Payment", "Ticket", "SMS", "Diagnostic"] as const;

const DOT: Record<string, string> = { ok: "bg-emerald-500", warn: "bg-amber-500", bad: "bg-red-500" };

export default function LogsPage() {
  const [kind, setKind] = useState<string>("all");
  const [log, setLog] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const r = await fetch(`/api/logs?kind=${kind}`);
    if (r.ok) setLog((await r.json()).log ?? []);
    setLoading(false);
  }, [kind]);
  useEffect(() => { load(); }, [load]);

  const term = q.trim().toLowerCase();
  const shown = term ? log.filter((l) => l.summary.toLowerCase().includes(term)) : log;

  return (
    <PageShell
      title="Logs"
      description="One timeline across router provisioning, payments, tickets, SMS delivery and AI diagnostics — the audit trail of everything NETPID did on your behalf."
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex flex-1 flex-wrap gap-1 rounded-xl border border-slate-200 bg-white p-1">
          {KINDS.map((k) => (
            <button key={k} onClick={() => setKind(k)}
              className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${
                kind === k ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-50"
              }`}>
              {k}
            </button>
          ))}
        </div>
        <input
          className="input sm:max-w-64"
          type="search"
          placeholder="Filter the timeline…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Filter logs"
        />
      </div>

      <div className="card-flush">
        {loading
          ? <Empty>Loading activity…</Empty>
          : !shown.length
            ? <Empty>{term ? "Nothing matches that filter." : "No activity recorded yet."}</Empty>
            : (
              <ol className="divide-y divide-slate-100">
                {shown.map((l) => (
                  <li key={`${l.kind}-${l.id}`} className="flex items-start gap-3 px-4 py-3">
                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT[l.status] ?? DOT.ok}`} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-slate-800">{l.summary}</p>
                      <p className="mt-0.5 text-xs text-slate-400">
                        <span className="badge badge-mute mr-1.5">{l.kind}</span>
                        {fmtDateTime(l.at)} · source: {l.source}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
      </div>
      <p className="mt-3 text-xs text-slate-500">Newest first, up to 300 entries per filter.</p>
    </PageShell>
  );
}
