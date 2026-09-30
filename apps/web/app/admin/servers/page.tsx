"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

// Super Admin → VPS / Servers.
//
// The credential is write-only. There is no code path in this page that can
// display a stored secret, and the API never returns one — the UI only ever
// shows a status word (ACTIVE / EXPIRING / EXPIRED / MISSING).

type Server = {
  id: string; name: string; provider: string; region: string | null;
  hostname: string | null; ip_address: string; ssh_port: number;
  ssh_username: string; auth_method: string; credential_status: string;
  credential_expires_at: string | null; credential_updated_at: string | null;
  enabled: boolean; status: string; worker_status: string; radius_status: string;
  wireguard_status: string; firewall_status: string; os_name: string | null;
  kernel: string | null; cpu_percent: number | null; mem_percent: number | null;
  disk_percent: number | null; uptime_seconds: number | null;
  last_heartbeat_at: string | null; last_health_check_at: string | null;
  last_health_error: string | null; isp_id: string | null; notes: string | null;
  role: string; active: boolean; migration_status: string | null;
  migration_notes: string | null; created_at: string;
};

const STATUS_STYLE: Record<string, string> = {
  online: "bg-emerald-500/15 text-emerald-300",
  delayed: "bg-amber-500/15 text-amber-300",
  offline: "bg-rose-500/15 text-rose-300",
  disabled: "bg-white/10 text-slate-400",
  unknown: "bg-white/10 text-slate-400",
};
const CRED_STYLE: Record<string, string> = {
  active: "bg-emerald-500/15 text-emerald-300",
  expiring: "bg-amber-500/15 text-amber-300",
  expired: "bg-rose-500/15 text-rose-300",
  missing: "bg-rose-500/15 text-rose-300",
};
const SVC: Record<string, string> = {
  running: "text-emerald-400", stopped: "text-rose-400",
  active: "text-emerald-400", inactive: "text-rose-400", unknown: "text-slate-500",
};

function ago(iso: string | null) {
  if (!iso) return "never";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function uptime(sec: number | null) {
  if (sec == null) return "—";
  const d = Math.floor(sec / 86400);
  if (d > 0) return `${d}d ${Math.floor((sec % 86400) / 3600)}h`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

export default function ServersPage() {
  const router = useRouter();
  const [servers, setServers] = useState<Server[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({
    name: "", provider: "freevps", region: "", hostname: "",
    ip_address: "", ssh_port: 22, ssh_username: "", auth_method: "password" as "password" | "key",
    notes: "",
  });
  const [secret, setSecret] = useState("");
  const [expires, setExpires] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const r = await fetch("/api/admin/vps");
    if (r.ok) setServers((await r.json()).servers ?? []);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function call(url: string, init: RequestInit) {
    setBusy(true); setErr(null);
    const r = await fetch(url, init);
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setErr(j.error ?? "Request failed"); return null; }
    return j;
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const j = await call("/api/admin/vps", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form),
    });
    if (!j) return;
    setShowAdd(false);
    setMsg(`${j.server.name} registered. Add its credential next — it stays disabled until you do.`);
    load();
  }

  async function saveCredential(id: string, auth_method: string) {
    if (!secret.trim()) { setErr("Paste the credential first"); return; }
    const j = await call(`/api/admin/vps/${id}/credentials`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ auth_method, secret, expires_at: expires }),
    });
    if (!j) return;
    setSecret(""); setExpires(""); setMsg("Credential encrypted and stored. It will never be shown again.");
    load();
  }

  async function migrate(id: string, action: "switch" | "decommission" | "standby") {
    setMsg(null); setErr(null);
    const r = await fetch(`/api/admin/vps/${id}/migrate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { setErr(j.error ?? "Migration failed"); return; }
    setMsg(j.message ?? "Done");
    load();
  }

  async function test(id: string) {
    setTesting(id); setErr(null); setMsg(null);
    const j = await call(`/api/admin/vps/${id}/test`, { method: "POST" });
    setTesting(null);
    if (!j) return;
    const r = j.result;
    setMsg(r.ok
      ? `SSH OK · ${r.os ?? "unknown OS"} · worker ${r.worker} · radius ${r.radius} · wireguard ${r.wireguard} · firewall ${r.firewall} · CPU ${r.cpuPercent ?? "?"}% · RAM ${r.memPercent ?? "?"}% · disk ${r.diskPercent ?? "?"}% (${r.durationMs}ms)`
      : `Test failed: ${r.error}`);
    load();
  }

  async function toggle(s: Server) {
    const j = await call(`/api/admin/vps/${s.id}`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: !s.enabled }),
    });
    if (!j) return;
    setMsg(`${s.name} ${s.enabled ? "disabled" : "enabled"}`);
    load();
  }

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight sm:text-3xl">VPS / Servers</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            Platform infrastructure. Credentials are encrypted at rest and are never returned by
            any endpoint — only a status word.
          </p>
        </div>
        <button onClick={() => setShowAdd((v) => !v)} className="rounded-xl bg-rose-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-rose-700">
          {showAdd ? "Cancel" : "Add Server"}
        </button>
      </div>

      {msg && (
        <p className="mt-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-200">
          {msg}
        </p>
      )}
      {err && (
        <p className="mt-4 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">
          {err}
        </p>
      )}

      {showAdd && (
        <form onSubmit={add} className="mt-5 rounded-2xl border border-white/10 bg-slate-900 p-5">
          <h2 className="text-sm font-bold uppercase tracking-wide text-slate-400">New server</h2>
          <p className="mt-1 text-xs text-slate-500">
            The credential is added on the next screen, so the password is never part of this
            request body or this page state.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400" htmlFor="n">Name</label>
              <input id="n" required className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white outline-none focus:border-rose-500"
                value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400" htmlFor="p">Provider</label>
              <input id="p" className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white outline-none focus:border-rose-500"
                value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })} />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400" htmlFor="r">Region</label>
              <input id="r" className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white outline-none focus:border-rose-500"
                placeholder="USA" value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400" htmlFor="i">IP address</label>
              <input id="i" required className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 font-mono text-sm text-white outline-none focus:border-rose-500"
                placeholder="203.0.113.10" value={form.ip_address}
                onChange={(e) => setForm({ ...form, ip_address: e.target.value })} />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400" htmlFor="s">SSH port</label>
              <input id="s" type="number" min={1} max={65535} className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white outline-none focus:border-rose-500"
                value={form.ssh_port} onChange={(e) => setForm({ ...form, ssh_port: Number(e.target.value) })} />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400" htmlFor="u">SSH username</label>
              <input id="u" required className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white outline-none focus:border-rose-500"
                value={form.ssh_username} onChange={(e) => setForm({ ...form, ssh_username: e.target.value })} />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400" htmlFor="a">Auth method</label>
              <select id="a" className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white outline-none focus:border-rose-500"
                value={form.auth_method}
                onChange={(e) => setForm({ ...form, auth_method: e.target.value as "password" | "key" })}>
                <option value="password">Password</option>
                <option value="key">SSH private key</option>
              </select>
            </div>
          </div>
          <div className="mt-4">
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400" htmlFor="nt">Notes</label>
            <input id="nt" className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white outline-none focus:border-rose-500"
              value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
          <button type="submit" disabled={busy}
            className="mt-4 rounded-xl bg-rose-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-rose-700 disabled:opacity-50">
            {busy ? "Saving…" : "Register server"}
          </button>
        </form>
      )}

      <div className="mt-6 space-y-4">
        {loading && <p className="text-sm text-slate-500">Loading servers…</p>}
        {!loading && !servers.length && (
          <p className="rounded-2xl border border-dashed border-white/10 p-8 text-center text-sm text-slate-500">
            No servers registered yet. Use ›Add Server” to register one.
          </p>
        )}

        {servers.map((s) => (
          <article key={s.id} className="rounded-2xl border border-white/10 bg-slate-900 p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-bold">{s.name}</h2>
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold uppercase ${STATUS_STYLE[s.status] ?? STATUS_STYLE.unknown}`}>
                    {s.status}
                  </span>
                  <span className="rounded-full bg-white/5 px-2.5 py-0.5 text-xs font-semibold uppercase text-slate-400">
                    {s.role}{s.active ? " · active" : ""}
                  </span>
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold uppercase ${CRED_STYLE[s.credential_status] ?? CRED_STYLE.missing}`}>
                    credential {s.credential_status}
                  </span>
                </div>
                <p className="mt-1 font-mono text-xs text-slate-400">
                  {s.ip_address}:{s.ssh_port} · {s.ssh_username}@{s.ip_address}
                  {s.provider && <> · {s.provider}</>}
                  {s.region && <> · {s.region}</>}
                </p>
                {s.os_name && <p className="mt-0.5 text-xs text-slate-500">{s.os_name} · kernel {s.kernel ?? "—"}</p>}
              </div>
              <div className="flex flex-wrap gap-2">
                <button onClick={() => test(s.id)} disabled={testing === s.id || s.credential_status === "missing"}
                  className="rounded-lg border border-white/15 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-white/5 disabled:opacity-40">
                  {testing === s.id ? "Testing…" : "Test connection"}
                </button>
                <button onClick={() => toggle(s)} disabled={busy}
                  className="rounded-lg border border-white/15 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-white/5 disabled:opacity-40">
                  {s.enabled ? "Disable" : "Enable"}
                </button>
                {s.role !== "primary" && s.enabled && (
                  <button onClick={() => migrate(s.id, "switch")} disabled={busy}
                    className="rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-3 py-1.5 text-xs font-semibold text-emerald-200 transition hover:bg-emerald-500/25 disabled:opacity-40">
                    Switch active to this VPS
                  </button>
                )}
                <button onClick={() => {
                  if (confirm(`Decommission ${s.name}? It stays in history as retired.`)) migrate(s.id, "decommission");
                }} disabled={busy}
                  className="rounded-lg border border-white/15 px-3 py-1.5 text-xs font-semibold text-rose-300 transition hover:bg-white/5 disabled:opacity-40">
                  Decommission
                </button>
              </div>
            </div>

            <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
              {([
                ["Worker", s.worker_status],
                ["FreeRADIUS", s.radius_status],
                ["WireGuard", s.wireguard_status],
                ["Firewall", s.firewall_status],
                ["CPU", s.cpu_percent == null ? "—" : `${s.cpu_percent}%`],
                ["RAM", s.mem_percent == null ? "—" : `${s.mem_percent}%`],
                ["Disk", s.disk_percent == null ? "—" : `${s.disk_percent}%`],
              ] as [string, string][]).map(([k, v]) => (
                <div key={k} className="rounded-xl border border-white/5 bg-white/5 p-3">
                  <dt className="text-[11px] font-bold uppercase tracking-wide text-slate-500">{k}</dt>
                  <dd className={`mt-1 font-mono text-sm font-semibold ${
                    ["running", "active"].includes(v) ? "text-emerald-400"
                    : ["stopped", "inactive"].includes(v) ? "text-rose-400" : "text-slate-300"}`}>
                    {v}
                  </dd>
                </div>
              ))}
            </dl>

            <p className="mt-3 text-xs text-slate-500">
              Uptime {uptime(s.uptime_seconds)} · heartbeat {ago(s.last_heartbeat_at)} · last check{" "}
              {ago(s.last_health_check_at)}
              {s.last_health_error && (
                <> · <span className="text-rose-400">{s.last_health_error}</span></>
              )}
            </p>

            <details className="mt-4 rounded-xl border border-white/10 bg-white/5 p-4">
              <summary className="cursor-pointer text-sm font-semibold text-slate-200">
                Credential
                {s.credential_updated_at && (
                  <span className="ml-2 text-xs font-normal text-slate-500">
                    updated {ago(s.credential_updated_at)}
                    {s.credential_expires_at && ` · expires ${new Date(s.credential_expires_at).toLocaleDateString("en-KE")}`}
                  </span>
                )}
              </summary>
              <p className="mt-2 text-xs text-slate-500">
                {s.credential_status === "missing"
                  ? "No credential stored. The server cannot be reached over SSH until one is added."
                  : "A credential is stored. Its value is not retrievable through the API or this page — rotate it by pasting a replacement below."}
              </p>
              <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
                <div>
                  <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400" htmlFor={`sec-${s.id}`}>
                    {s.auth_method === "key" ? "New private key (PEM)" : "New password"}
                  </label>
                  <input id={`sec-${s.id}`} type="password" autoComplete="new-password"
                    className="w-full rounded-xl border border-white/10 bg-slate-950 px-3 py-2.5 text-sm text-white outline-none focus:border-rose-500"
                    value={secret} onChange={(e) => setSecret(e.target.value)} />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400" htmlFor={`exp-${s.id}`}>
                    Expires (optional)
                  </label>
                  <input id={`exp-${s.id}`} type="date"
                    className="rounded-xl border border-white/10 bg-slate-950 px-3 py-2.5 text-sm text-white outline-none focus:border-rose-500"
                    value={expires} onChange={(e) => setExpires(e.target.value)} />
                </div>
                <button onClick={() => saveCredential(s.id, s.auth_method)} disabled={busy || !secret.trim()}
                  className="rounded-xl bg-rose-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-rose-700 disabled:opacity-40">
                  Save credential
                </button>
              </div>
            </details>
          </article>
        ))}
      </div>
    </>
  );
}
