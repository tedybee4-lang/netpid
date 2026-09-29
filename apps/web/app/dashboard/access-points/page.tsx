"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import PageShell, { Empty, StatGrid, fmtDateTime } from "@/components/PageShell";

type Ap = {
  id: string; router_id: string | null; name: string; ip: string | null; mac: string | null;
  ssid: string | null; location: string | null; status: string; clients: number;
  uptime_seconds: number | null; last_seen_at: string | null;
};
type Router = { id: string; name: string; site: string | null; status: string };

function uptime(sec: number | null) {
  if (sec == null) return "—";
  const d = Math.floor(sec / 86400);
  if (d > 0) return `${d}d ${Math.floor((sec % 86400) / 3600)}h`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

export default function AccessPointsPage() {
  const [aps, setAps] = useState<Ap[]>([]);
  const [routers, setRouters] = useState<Router[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const r = await fetch("/api/modules?module=access");
    if (r.ok) { const j = await r.json(); setAps(j.aps ?? []); setRouters(j.routers ?? []); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const online = aps.filter((a) => a.status === "online");
  const clients = aps.reduce((a, x) => a + (x.clients ?? 0), 0);

  return (
    <PageShell
      title="Access points"
      description="HotSpot and mesh units NETPID polls across your routers. Client counts come from the router's DHCP lease table, so they only move when a device actually connects."
    >
      <StatGrid items={[
        { label: "Access points", value: aps.length, sub: `${routers.length} router${routers.length === 1 ? "" : "s"} watched` },
        { label: "Online", value: online.length, sub: `${aps.length - online.length} offline or unknown` },
        { label: "Clients connected", value: clients, sub: "Across all APs" },
        { label: "Unique SSIDs", value: new Set(aps.map((a) => a.ssid).filter(Boolean)).size, sub: "Names in use" },
      ]} />

      <div className="card-flush overflow-x-auto">
        {loading
          ? <Empty>Loading access points…</Empty>
          : !aps.length
            ? (
              <Empty>
                No access points registered yet. Add one from{" "}
                <Link href="/dashboard/access/hotspot" className="font-semibold text-indigo-600 hover:underline">
                  Access HotSpot APs
                </Link>, or let the worker discover them on your routers.
              </Empty>
            )
            : (
              <table className="table" style={{ minWidth: 900 }}>
                <thead>
                  <tr>
                    <th>AP</th><th>Router</th><th>SSID</th><th>IP</th><th>MAC</th>
                    <th>Status</th><th>Clients</th><th>Uptime</th><th>Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {aps.map((a) => {
                    const rt = routers.find((r) => r.id === a.router_id);
                    return (
                      <tr key={a.id}>
                        <td>
                          <p className="font-semibold text-slate-900">{a.name}</p>
                          {a.location && <p className="text-xs text-slate-400">{a.location}</p>}
                        </td>
                        <td>
                          {rt
                            ? <Link href={`/dashboard/network/routers/${rt.id}`} className="text-indigo-600 hover:underline">{rt.name}</Link>
                            : <span className="text-slate-400">Unassigned</span>}
                        </td>
                        <td className="font-mono text-xs">{a.ssid ?? "—"}</td>
                        <td className="font-mono text-xs">{a.ip ?? "—"}</td>
                        <td className="font-mono text-xs uppercase">{a.mac ?? "—"}</td>
                        <td>
                          <span className={`badge ${a.status === "online" ? "badge-ok" : a.status === "offline" ? "badge-bad" : "badge-mute"}`}>
                            {a.status}
                          </span>
                        </td>
                        <td className="font-semibold">{a.clients ?? 0}</td>
                        <td>{uptime(a.uptime_seconds)}</td>
                        <td className="text-xs text-slate-500">{fmtDateTime(a.last_seen_at)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
      </div>
    </PageShell>
  );
}
