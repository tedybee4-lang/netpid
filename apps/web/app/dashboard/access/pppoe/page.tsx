"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import PageShell, { Empty, StatGrid, mb } from "@/components/PageShell";

type Session = {
  id: string; username: string | null; framed_ip: string | null; is_open: boolean;
  input_octets: number | null; output_octets: number | null; last_update: string;
  nas: { name: string } | null;
};

// The PPPoE access view: who is authenticated right now, on which router, and
// how much they have moved. This is the page an operator watches when a
// customer's link feels slow.
export default function AccessPppoePage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [accounts, setAccounts] = useState<{ id: string; enabled: boolean; profile: string | null }[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const [s, a] = await Promise.all([
      fetch("/api/radius/sessions").then((r) => r.json()).catch(() => ({ sessions: [] })),
      fetch("/api/radius/users").then((r) => r.json()).catch(() => ({ users: [] })),
    ]);
    setSessions(s.sessions ?? []);
    setAccounts(a.users ?? []);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const open = sessions.filter((s) => s.is_open);
  const total = sessions.reduce((a, s) => a + (s.input_octets ?? 0) + (s.output_octets ?? 0), 0);

  return (
    <PageShell
      title="Access — PPPoE routers"
      description="Live PPPoE sessions from every router you manage, with the RADIUS account behind each one. Counts update as the worker polls your routers."
      action={
        <Link href="/dashboard/network/routers/new" className="btn-primary">Add a PPPoE router</Link>
      }
    >
      <StatGrid items={[
        { label: "Live sessions", value: open.length, sub: `of ${sessions.length} tracked` },
        { label: "RADIUS accounts", value: accounts.length, sub: `${accounts.filter((a) => a.enabled).length} enabled` },
        { label: "Traffic this window", value: mb(total), sub: "Since each session opened" },
        { label: "Routers", value: new Set(sessions.map((s) => s.nas?.name).filter(Boolean)).size, sub: "Reporting sessions" },
      ]} />

      <div className="card-flush overflow-x-auto">
        {loading
          ? <Empty>Loading sessions…</Empty>
          : !sessions.length
            ? (
              <Empty>
                No PPPoE sessions recorded. Add a router and run its provisioning script to start
                authenticating subscribers.
              </Empty>
            )
            : (
              <table className="table" style={{ minWidth: 820 }}>
                <thead>
                  <tr><th>Username</th><th>IP address</th><th>Router</th><th>Uploaded</th><th>Downloaded</th><th>Last update</th><th>State</th></tr>
                </thead>
                <tbody>
                  {sessions.map((s) => (
                    <tr key={s.id}>
                      <td className="font-semibold text-slate-900">{s.username ?? "—"}</td>
                      <td className="font-mono text-xs">{s.framed_ip ?? "—"}</td>
                      <td>{s.nas?.name ?? "—"}</td>
                      <td>{mb(s.input_octets)}</td>
                      <td>{mb(s.output_octets)}</td>
                      <td className="text-xs text-slate-500">
                        {new Date(s.last_update).toLocaleString("en-KE")}
                      </td>
                      <td>
                        <span className={`badge ${s.is_open ? "badge-ok" : "badge-mute"}`}>
                          {s.is_open ? "online" : "closed"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
      </div>
      <p className="mt-3 text-xs text-slate-500">
        Uploaded and downloaded are the values RADIUS last reported for that session. A session that is
        closed but still listed has ended without a clean Stop message — common on power cuts.
      </p>
    </PageShell>
  );
}
