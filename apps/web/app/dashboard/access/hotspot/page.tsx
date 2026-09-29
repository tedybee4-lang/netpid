"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import PageShell, { Empty, StatGrid, fmtDateTime } from "@/components/PageShell";

type Ap = {
  id: string; name: string; ip: string | null; mac: string | null; ssid: string | null;
  location: string | null; status: string; clients: number; last_seen_at: string | null;
  router_id: string | null; routers: { name: string } | null;
};
type HotUser = {
  id: string; username: string | null; mac: string | null; ip: string | null;
  is_active: boolean; uptime_seconds: number | null;
};

function uptime(sec: number | null) {
  if (sec == null) return "—";
  const d = Math.floor(sec / 86400);
  return d > 0 ? `${d}d ${Math.floor((sec % 86400) / 3600)}h` : `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

export default function AccessHotspotPage() {
  const [aps, setAps] = useState<Ap[]>([]);
  const [users, setUsers] = useState<HotUser[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const [a, u] = await Promise.all([
      fetch("/api/modules?module=access").then((r) => r.json()).catch(() => ({ aps: [] })),
      fetch("/api/radius/sessions?type=hotspot").then((r) => r.json()).catch(() => ({ sessions: [] })),
    ]);
    setAps(a.aps ?? []);
    setUsers(u.sessions ?? []);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const online = aps.filter((a) => a.status === "online");
  const activeUsers = users.filter((u) => u.is_active);

  return (
    <PageShell
      title="Access — HotSpot APs"
      description="Your captive-portal access points and the devices currently authenticated against them."
      action={<Link href="/dashboard/access-points" className="btn-ghost">All access points</Link>}
    >
      <StatGrid items={[
        { label: "HotSpot APs", value: aps.length, sub: `${online.length} online` },
        { label: "Clients online", value: aps.reduce((a, x) => a + (x.clients ?? 0), 0), sub: "From router lease tables" },
        { label: "Active sessions", value: activeUsers.length, sub: "Authenticated right now" },
        { label: "SSIDs published", value: new Set(aps.map((a) => a.ssid).filter(Boolean)).size, sub: "Distinct names" },
      ]} />

      <h2 className="mb-2 text-lg font-bold">Access points</h2>
      <div className="card-flush overflow-x-auto">
        {loading
          ? <Empty>Loading…</Empty>
          : !aps.length
            ? <Empty>No HotSpot access points yet.</Empty>
            : (
              <table className="table" style={{ minWidth: 860 }}>
                <thead>
                  <tr><th>AP</th><th>Router</th><th>SSID</th><th>IP</th><th>Status</th><th>Clients</th><th>Last seen</th></tr>
                </thead>
                <tbody>
                  {aps.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <p className="font-semibold text-slate-900">{a.name}</p>
                        {a.location && <p className="text-xs text-slate-400">{a.location}</p>}
                      </td>
                      <td>{a.routers?.name ?? <span className="text-slate-400">Unassigned</span>}</td>
                      <td className="font-mono text-xs">{a.ssid ?? "—"}</td>
                      <td className="font-mono text-xs">{a.ip ?? "—"}</td>
                      <td>
                        <span className={`badge ${a.status === "online" ? "badge-ok"
                          : a.status === "offline" ? "badge-bad" : "badge-mute"}`}>{a.status}</span>
                      </td>
                      <td className="font-semibold">{a.clients ?? 0}</td>
                      <td className="text-xs text-slate-500">{fmtDateTime(a.last_seen_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
      </div>

      <h2 className="mb-2 mt-8 text-lg font-bold">Authenticated devices</h2>
      <div className="card-flush overflow-x-auto">
        {!users.length
          ? <Empty>No HotSpot sessions. Bind a device MAC under HotSpot binding to get started.</Empty>
          : (
            <table className="table" style={{ minWidth: 640 }}>
              <thead><tr><th>Username</th><th>MAC</th><th>IP</th><th>Uptime</th><th>State</th></tr></thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td className="font-semibold text-slate-900">{u.username ?? "Anonymous"}</td>
                    <td className="font-mono text-xs uppercase">{u.mac ?? "—"}</td>
                    <td className="font-mono text-xs">{u.ip ?? "—"}</td>
                    <td>{uptime(u.uptime_seconds)}</td>
                    <td>
                      <span className={`badge ${u.is_active ? "badge-ok" : "badge-mute"}`}>
                        {u.is_active ? "online" : "closed"}
                      </span>
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
