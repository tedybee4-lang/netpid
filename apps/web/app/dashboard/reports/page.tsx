"use client";

import { useEffect, useState } from "react";

interface RevenueDay { day: string; count: number; total_minor: number }
interface UsageDay { day: string; upload: number; download: number; total: number; sessions: number }
interface ExpiringCust { id: string; full_name: string; phone: string; expiry_date: string; status: string }

export default function ReportsPage() {
  const [tab, setTab] = useState<"revenue" | "usage" | "expiry">("revenue");
  const [range, setRange] = useState<number>(30);
  const [loading, setLoading] = useState(true);
  const [revenueData, setRevenueData] = useState<{ total_minor: number; daily: RevenueDay[] } | null>(null);
  const [usageData, setUsageData] = useState<UsageDay[]>([]);
  const [expiryData, setExpiryData] = useState<{ expiring_soon: ExpiringCust[]; recently_expired: ExpiringCust[] } | null>(null);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/reports?kind=${tab}&range=${range}`)
      .then((r) => r.json())
      .then((d) => {
        if (tab === "revenue") setRevenueData(d);
        else if (tab === "usage") setUsageData(d.data ?? []);
        else if (tab === "expiry") setExpiryData(d);
      })
      .finally(() => setLoading(false));
  }, [tab, range]);

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Reports & Analytics</h1>
          <p className="text-sm text-muted-foreground">Revenue, bandwidth consumption, and customer expiry tracking.</p>
        </div>
        <a
          href={`/api/reports/export?kind=${tab === "expiry" ? "customers" : tab}`}
          className="px-3 py-1.5 text-xs font-medium border rounded hover:bg-muted"
          download
        >
          Export CSV
        </a>
      </div>

      <div className="flex items-center justify-between border-b pb-2">
        <div className="flex gap-4 text-sm">
          {(["revenue", "usage", "expiry"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`pb-2 capitalize font-medium ${tab === t ? "border-b-2 border-primary text-foreground" : "text-muted-foreground"}`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading report data…</p>
      ) : tab === "revenue" ? (
        <div className="space-y-4">
          <div className="p-4 border rounded bg-card">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Total Revenue ({range} days)</p>
            <p className="text-3xl font-bold mt-1">
              KSh {((revenueData?.total_minor ?? 0) / 100).toLocaleString("en-KE", { maximumFractionDigits: 2 })}
            </p>
          </div>
          <div className="border rounded overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
                <tr><th className="p-3">Date</th><th className="p-3">Count</th><th className="p-3 text-right">Revenue</th></tr>
              </thead>
              <tbody className="divide-y">
                {(revenueData?.daily ?? []).length === 0 ? (
                  <tr><td colSpan={3} className="p-4 text-center text-muted-foreground">No completed payments in range.</td></tr>
                ) : (
                  (revenueData?.daily ?? []).map((d) => (
                    <tr key={d.day}>
                      <td className="p-3 font-mono text-xs">{d.day}</td>
                      <td className="p-3">{d.count}</td>
                      <td className="p-3 text-right font-medium">KSh {(d.total_minor / 100).toLocaleString()}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : tab === "usage" ? (
        <div className="border rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="p-3">Date</th>
                <th className="p-3 text-right">Upload</th>
                <th className="p-3 text-right">Download</th>
                <th className="p-3 text-right">Total</th>
                <th className="p-3 text-right">Sessions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {usageData.length === 0 ? (
                <tr><td colSpan={5} className="p-4 text-center text-muted-foreground">No usage data recorded. Worker aggregates daily sessions.</td></tr>
              ) : (
                usageData.map((u) => (
                  <tr key={u.day}>
                    <td className="p-3 font-mono text-xs">{u.day}</td>
                    <td className="p-3 text-right font-mono text-xs">{(u.upload / 1048576).toFixed(1)} MB</td>
                    <td className="p-3 text-right font-mono text-xs">{(u.download / 1048576).toFixed(1)} MB</td>
                    <td className="p-3 text-right font-mono text-xs font-bold">{(u.total / 1048576).toFixed(1)} MB</td>
                    <td className="p-3 text-right">{u.sessions}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="grid md:grid-cols-2 gap-4">
          <div className="border rounded p-4 space-y-3">
            <h2 className="font-semibold text-sm">Expiring Next 7 Days ({expiryData?.expiring_soon.length ?? 0})</h2>
            <div className="divide-y text-xs max-h-96 overflow-y-auto">
              {(expiryData?.expiring_soon ?? []).length === 0 ? (
                <p className="text-muted-foreground py-2">No customers expiring soon.</p>
              ) : (
                expiryData?.expiring_soon.map((c) => (
                  <div key={c.id} className="py-2 flex justify-between items-center">
                    <div><p className="font-medium">{c.full_name}</p><p className="text-muted-foreground">{c.phone}</p></div>
                    <span className="font-mono text-amber-600">{new Date(c.expiry_date).toLocaleDateString()}</span>
                  </div>
                ))
              )}
            </div>
          </div>
          <div className="border rounded p-4 space-y-3">
            <h2 className="font-semibold text-sm">Recently Expired ({expiryData?.recently_expired.length ?? 0})</h2>
            <div className="divide-y text-xs max-h-96 overflow-y-auto">
              {(expiryData?.recently_expired ?? []).length === 0 ? (
                <p className="text-muted-foreground py-2">No expired accounts.</p>
              ) : (
                expiryData?.recently_expired.map((c) => (
                  <div key={c.id} className="py-2 flex justify-between items-center">
                    <div><p className="font-medium">{c.full_name}</p><p className="text-muted-foreground">{c.phone}</p></div>
                    <span className="font-mono text-rose-600">{new Date(c.expiry_date).toLocaleDateString()}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
