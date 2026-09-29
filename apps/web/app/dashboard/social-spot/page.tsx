"use client";
import PageShell, { Empty, StatGrid } from "@/components/PageShell";
import IntegrationCard, { useIntegrations } from "@/components/IntegrationCard";
import { useEffect, useState } from "react";

type Voucher = { id: string; code: string; status: string };

export default function SocialSpotPage() {
  const { rows, loading, reload } = useIntegrations();
  const spot = rows.find((r) => r.provider === "social_spot") ?? null;
  const [vouchers, setVouchers] = useState<Voucher[]>([]);
  const [err, setErr] = useState<string | null>(null);

  // The reconciliation view only makes sense once the link is on.
  useEffect(() => {
    if (!spot?.enabled) return;
    fetch("/api/vouchers").then((r) => r.json())
      .then((j) => {
        const all: { id: string; code: string; status: string }[] = j.codes ?? [];
        setVouchers(all.length ? all : []);
        if (!all.length) setErr("No voucher codes returned yet — generate a batch first.");
      })
      .catch(() => setErr("Could not load vouchers."));
  }, [spot?.enabled, spot?.id]);

  const redeemed = vouchers.filter((v) => v.status === "redeemed" || v.status === "used").length;
  const unused = vouchers.filter((v) => v.status === "unused").length;

  return (
    <PageShell
      title="Social Spot"
      description="Reconcile prepaid HotSpot sales from a Social Spot account into the same ledger NETPID already uses, so prepaid and subscription revenue agree at month end."
    >
      {loading ? <Empty>Loading…</Empty> : (
        <>
          <IntegrationCard key={spot?.id ?? "new"} provider="social_spot" initial={spot} />

          {spot?.enabled && (
            <>
              <h2 className="mt-8 text-lg font-bold">Reconciliation</h2>
              <StatGrid items={[
                { label: "Codes issued", value: vouchers.length, sub: "Synced from Social Spot" },
                { label: "Redeemed", value: redeemed, sub: "Already consumed" },
                { label: "Unused", value: unused, sub: "Still sellable" },
                { label: "Redemption rate", value: vouchers.length ? `${Math.round((redeemed / vouchers.length) * 100)}%` : "—", sub: "Redeemed ÷ issued" },
              ]} />
              {err && <p className="err-box">{err}</p>}
              <div className="card-flush overflow-x-auto">
                {!vouchers.length
                  ? <Empty>No codes to reconcile yet.</Empty>
                  : (
                    <table className="table" style={{ minWidth: 480 }}>
                      <thead><tr><th>Code</th><th>Status</th></tr></thead>
                      <tbody>
                        {vouchers.map((v) => (
                          <tr key={v.id}>
                            <td className="font-mono">{v.code}</td>
                            <td>
                              <span className={`badge ${v.status === "unused" ? "badge-ok"
                                : v.status === "redeemed" || v.status === "used" ? "badge-info" : "badge-mute"}`}>
                                {v.status}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
              </div>
            </>
          )}

          <div className="card mt-4">
            <p className="font-semibold">Before you connect</p>
            <p className="mt-1 text-sm text-slate-600">
              Set your Social Spot base URL to the API root (not the admin page) and give NETPID a read-only
              API key. A key with sales-write access is unnecessary and should not be used.
            </p>
            <button className="btn-ghost btn-sm mt-3" onClick={reload}>Reload status</button>
          </div>
        </>
      )}
    </PageShell>
  );
}
