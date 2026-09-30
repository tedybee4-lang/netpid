"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

type Job = { id: string; kind: string; status: string; last_error: string | null };
type Health = {
  reachable: boolean; latency_ms: number | null; ros_version: string | null;
  model: string | null; uptime_seconds: number | null; cpu_load: number | null;
  mem_used_pct: number | null; checked_at: string; detail: { error?: string } | null;
};
type RouterInfo = {
  id: string; name: string; host: string; status: string; site: string | null;
  model: string | null; ros_version: string | null; arch: string | null;
  ram_mb: number | null; provisioning_profile: string | null;
  has_wireguard: boolean | null; has_radius: boolean | null;
  has_pppoe: boolean | null; has_hotspot: boolean | null;
  has_vlan: boolean | null; has_api_ssl: boolean | null;
  compatibility_notes: string | null; capabilities_checked_at: string | null;
  uptime_seconds: number | null; cpu_load: number | null; mem_used_pct: number | null;
};
type Tunnel = {
  status: string; router_tunnel_ip: string; vps_tunnel_ip: string;
  last_handshake_at: string | null; last_endpoint: string | null;
  needs_router_key: boolean;
};

export default function RouterDetail() {
  const { id } = useParams<{ id: string }>();
  const [job, setJob] = useState<Job | null>(null);
  const [health, setHealth] = useState<Health[]>([]);
  const [router, setRouter] = useState<RouterInfo | null>(null);
  const [tunnel, setTunnel] = useState<Tunnel | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [username, setUsername] = useState("");

  async function loadAll() {
    const r = await fetch(`/api/routers/${id}/test`);
    const j = await r.json().catch(() => ({}));
    setHealth(j.health ?? []);
    setRouter(j.router ?? null);
    setTunnel(j.tunnel ?? null);
  }
  useEffect(() => { loadAll(); }, [id]);

  async function poll(jobId: string) {
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const j = await fetch(`/api/network/jobs?job=${jobId}`).then((r) => r.json());
      setJob(j.job);
      if (["completed", "failed", "dead", "cancelled"].includes(j.job?.status)) break;
    }
    loadAll();
  }

  async function action(a: string) {
    setMsg("Queued…");
    const res = await fetch(`/api/routers/${id}/test`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: a, username: username || undefined }),
    });
    const j = await res.json();
    if (!res.ok) { setMsg(j.error ?? "Failed"); return; }
    setMsg("Running — polling job status…");
    poll(j.job_id);
  }

  return (
    <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8">
      <Link href="/dashboard/network" className="text-sm font-semibold text-indigo-600 hover:underline">
        ← Network
      </Link>
      <h1 className="mt-2 text-2xl font-black tracking-tight sm:text-3xl">
        Router{router ? ` — ${router.name}` : ""}
      </h1>
      {router && (
        <p className="mt-1 text-sm text-slate-500">
          {String(router.host)}{router.site ? ` · ${router.site}` : ""}
          {router.model ? ` · ${router.model}` : ""}
          {router.ros_version ? ` · ROS ${router.ros_version}` : ""} ·{" "}
          <span className={`badge ${router.status === "online" ? "badge-ok" : "badge-warn"}`}>
            {router.status}
          </span>
        </p>
      )}

      {router && (
        <div className="card mt-4">
          <h2 className="panel-title">Capabilities{router.provisioning_profile ? ` · ${router.provisioning_profile}` : ""}</h2>
          {!router.capabilities_checked_at ? (
            <p className="mt-2 text-sm text-slate-500">
              Not probed yet — press “Detect capabilities” below. Until then scripts fall back to your provisioning defaults.
            </p>
          ) : (
            <>
              <dl className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
                {[["WireGuard", router.has_wireguard], ["RADIUS", router.has_radius],
                  ["PPPoE", router.has_pppoe], ["HotSpot", router.has_hotspot],
                  ["VLAN", router.has_vlan], ["API-SSL", router.has_api_ssl],
                ].map(([label, v]) => (
                  <div key={label as string} className="rounded-lg bg-slate-50 px-3 py-2">
                    <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
                    <dd className="font-bold">{v == null ? "unknown" : (v as boolean) ? "yes" : "not supported on this router"}</dd>
                  </div>
                ))}
              </dl>
              {router.compatibility_notes && (
                <p className="mt-2 text-sm text-amber-700">{router.compatibility_notes}</p>
              )}
            </>
          )}
        </div>
      )}

      {tunnel && (
        <div className="card mt-4">
          <h2 className="panel-title">WireGuard tunnel · {tunnel.status}</h2>
          <p className="mt-2 text-sm text-slate-600">
            {tunnel.router_tunnel_ip} ↔ {tunnel.vps_tunnel_ip} · handshake{" "}
            {tunnel.last_handshake_at ? new Date(tunnel.last_handshake_at).toLocaleString() : "never"}
            {tunnel.needs_router_key ? " · waiting for the router public key" : ""}
          </p>
        </div>
      )}

      <div className="card mt-6">
        <h2 className="panel-title">Actions</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          <button className="btn-primary" onClick={() => action("test")}>Test connection</button>
          <button className="btn-ghost" onClick={() => action("capabilities")}>Detect capabilities</button>
          <button className="btn-ghost" onClick={() => action("backup")}>Backup now</button>
        </div>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <input className="input" placeholder="username to disconnect"
            value={username} onChange={(e) => setUsername(e.target.value)} />
          <button className="btn-ghost shrink-0" onClick={() => action("disconnect")}>
            Disconnect user
          </button>
        </div>
        {msg && <p className="mt-3 text-sm text-slate-600">{msg}</p>}
        {job && (
          <p className="mt-3 rounded-xl bg-slate-100 p-3 text-sm">
            <b className="font-mono">{job.kind}</b>: {job.status}
            {job.last_error ? ` — ${job.last_error}` : ""}
          </p>
        )}
      </div>

      <div className="card mt-4">
        <h2 className="panel-title">Recent health checks ({health.length})</h2>
        {!health.length ? (
          <p className="mt-2 text-sm text-slate-500">
            No checks yet — press “Test connection”, or wait for the scheduled router-health job.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-slate-100 text-sm">{health.map((h, i) => (
            <li key={i} className="flex items-center justify-between gap-2 py-2">
              <span>
                <span className={`badge ${h.reachable ? "badge-ok" : "badge-bad"}`}>
                  {h.reachable ? "online" : "offline"}
                </span>
                {h.model && <span className="ml-2 text-slate-500">{h.model}</span>}
              </span>
              <span className="text-xs text-slate-500 tnum">
                {h.latency_ms != null ? `${h.latency_ms}ms · ` : ""}
                {new Date(h.checked_at).toLocaleString()}
              </span>
            </li>))}</ul>
        )}
      </div>
    </main>
  );
}
