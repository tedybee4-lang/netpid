"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import PageShell, { Empty, StatGrid, fmtDate } from "@/components/PageShell";

type Q = {
  id: string; customer_no: string; full_name: string; phone: string;
  service_type: string; status: string; created_at: string;
  installation_date: string | null;
  packages: { name: string; service_type: string } | null;
  has_payment: boolean; has_service_account: boolean; next_step: string;
};

const STEP_BADGE: Record<string, string> = {
  "Take payment": "badge-bad",
  "Push credentials to the router": "badge-warn",
  "Activate on the router": "badge-info",
};

export default function ActivationPage() {
  const [queue, setQueue] = useState<Q[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const r = await fetch("/api/modules?module=activation");
    if (r.ok) setQueue((await r.json()).queue ?? []);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const waiting = queue.filter((q) => !q.has_payment).length;
  const ready = queue.filter((q) => q.has_payment && !q.has_service_account).length;
  const onRouter = queue.filter((q) => q.has_payment && q.has_service_account).length;

  return (
    <PageShell
      title="Activation"
      description="Newly registered customers waiting to go live. Work down the list — the next step is worked out for each row from their payment and service account."
    >
      <StatGrid items={[
        { label: "Waiting for payment", value: waiting, sub: "Take the money first" },
        { label: "Ready to push", value: ready, sub: "Paid, credentials not on router" },
        { label: "On the router", value: onRouter, sub: "Awaiting final activation" },
        { label: "Total in queue", value: queue.length, sub: "Status = pending" },
      ]} />

      <div className="card-flush overflow-x-auto">
        {loading
          ? <Empty>Loading the queue…</Empty>
          : !queue.length
            ? <Empty>No pending customers. New sign-ups land here automatically.</Empty>
            : (
              <table className="table" style={{ minWidth: 900 }}>
                <thead>
                  <tr>
                    <th>Customer</th><th>Phone</th><th>Package</th><th>Service</th>
                    <th>Registered</th><th>Next step</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {queue.map((q) => (
                    <tr key={q.id}>
                      <td>
                        <p className="font-semibold text-slate-900">{q.full_name}</p>
                        <p className="text-xs text-slate-400">{q.customer_no}</p>
                      </td>
                      <td>{q.phone}</td>
                      <td>{q.packages?.name ?? <span className="text-slate-400">—</span>}</td>
                      <td className="uppercase">{q.service_type}</td>
                      <td>{fmtDate(q.created_at)}</td>
                      <td><span className={`badge ${STEP_BADGE[q.next_step] ?? "badge-mute"}`}>{q.next_step}</span></td>
                      <td className="text-right">
                        <Link className="btn-ghost btn-sm" href={`/dashboard/customers/${q.id}`}>Open</Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
      </div>

      <p className="mt-4 text-xs text-slate-500">
        Moving a customer to <strong>Active</strong> on their profile is what pushes credentials to the
        router. Until then the account exists in NETPID but cannot authenticate.
      </p>
    </PageShell>
  );
}
