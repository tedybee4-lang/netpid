"use client";
import { useCallback, useEffect, useState } from "react";
import PageShell, { Empty, StatGrid, fmtDate, mb } from "@/components/PageShell";

type Payload = {
  days: number;
  totals: { down: number; up: number; total: number; seconds: number; sessions: number; customers_reported: number };
  daily: { day: string; bytes: number }[];
  perCustomer: { id: string; up: number; down: number; sec: number; sess: number; name: string }[];
  caps: Record<string, number | null>;
};

const RANGES = [7, 30, 90];

function hours(sec: number) {
  return `${Math.round(sec / 3600).toLocaleString("en-KE")} h`;
}

export default function DataUsagePage() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const r = await fetch(`/api/modules?module=data-usage&days=${days}`);
    if (r.ok) setData(await r.json());
    setLoading(false);
  }, [days]);
  useEffect(() => { load(); }, [load]);

  // Sparkline scaled to the busiest day, so a quiet month still reads as a shape
  // rather than a flat line.
  const peak = Math.max(1, ...(data?.daily ?? []).map((d) => d.bytes));

  return (
    <PageShell
      title="Data usage"
      description="Traffic accounted from RADIUS Acct-Start/Interim/Stop, rolled up daily by the network worker."
      action={
        <div className="flex gap-1 rounded-xl border border-slate-200 bg-white p-1">
          {RANGES.map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${
                days === d ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-50"
              }`}
            >
              {d}d
            </button>
          ))}
        </div>
      }
    >
      {loading || !data
        ? <Empty>Loading usage…</Empty>
        : (
          <>
            <StatGrid items={[
              { label: "Total traffic", value: mb(data.totals.total), sub: `Last ${days} days` },
              { label: "Downloaded", value: mb(data.totals.down), sub: `${Math.round(data.totals.down / Math.max(1, data.totals.total) * 100)}% of all traffic` },
              { label: "Uploaded", value: mb(data.totals.up), sub: "Customer → internet" },
              { label: "Online time", value: hours(data.totals.seconds), sub: `${data.totals.sessions.toLocaleString("en-KE")} sessions` },
            ]} />

            <div className="card mb-4">
              <p className="panel-title mb-3">Daily volume</p>
              {!data.daily.length
                ? <p className="text-sm text-slate-500">No accounting data in this window yet.</p>
                : (
                  <div className="flex h-32 items-end gap-[3px]" role="img" aria-label="Daily traffic volume">
                    {data.daily.map((d) => (
                      <div
                        key={d.day}
                        title={`${d.day}: ${mb(d.bytes)}`}
                        className="flex-1 rounded-t bg-indigo-500/80 transition hover:bg-indigo-600"
                        style={{ height: `${Math.max(3, (d.bytes / peak) * 100)}%` }}
                      />
                    ))}
                  </div>
                )}
            </div>

            <div className="card-flush overflow-x-auto">
              {!data.perCustomer.length
                ? <Empty>No per-customer usage in this window.</Empty>
                : (
                  <table className="table" style={{ minWidth: 780 }}>
                    <thead>
                      <tr>
                        <th>Customer</th><th>Downloaded</th><th>Uploaded</th><th>Total</th>
                        <th>Sessions</th><th>Online time</th><th>Package cap</th><th>Cap used</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.perCustomer.map((c) => {
                        const capMb = data.caps[c.id];
                        const usedPct = capMb ? Math.round(((c.down + c.up) / 1048576 / capMb) * 100) : null;
                        return (
                          <tr key={c.id}>
                            <td className="font-semibold text-slate-900">{c.name}</td>
                            <td>{mb(c.down)}</td>
                            <td>{mb(c.up)}</td>
                            <td className="font-semibold">{mb(c.down + c.up)}</td>
                            <td>{c.sess.toLocaleString("en-KE")}</td>
                            <td>{hours(c.sec)}</td>
                            <td>{capMb ? mb(capMb * 1048576) : <span className="text-slate-400">Uncapped</span>}</td>
                            <td>
                              {usedPct == null ? <span className="text-slate-400">—</span> : (
                                <span className={`badge ${usedPct >= 100 ? "badge-bad" : usedPct >= 80 ? "badge-warn" : "badge-ok"}`}>
                                  {usedPct}%
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
            </div>
            <p className="mt-3 text-xs text-slate-500">
              Rows are limited to the top 100 by traffic. Daily chart starts {data.daily[0]?.day ?? fmtDate(new Date().toISOString())}.
            </p>
          </>
        )}
    </PageShell>
  );
}
