"use client";
import { useEffect, useState } from "react";

type Nas = { id: string; shortname: string; nasname: string; sync_status: string; enabled: boolean };

export default function NasPage() {
  const [nas, setNas] = useState<Nas[]>([]);
  const [form, setForm] = useState({ shortname: "", nasname: "" });
  const [secretOnce, setSecretOnce] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    const j = await fetch("/api/radius/nas").then((r) => r.json());
    setNas(j.nas ?? []);
  }
  useEffect(() => { load(); }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault(); setMsg(null); setSecretOnce(null);
    const res = await fetch("/api/radius/nas", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form),
    });
    const j = await res.json();
    if (!res.ok) { setMsg(j.error ?? "Failed"); return; }
    setSecretOnce(j.secret_once);
    setMsg(j.warning);
    setForm({ shortname: "", nasname: "" });
    load();
  }

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <a className="text-sm text-indigo-600 hover:underline" href="/dashboard/radius">← RADIUS</a>
      <h1 className="mt-2 text-2xl font-black">NAS clients</h1>
      <form onSubmit={add} className="card mt-4 grid gap-2 sm:grid-cols-3">
        <input className="input" required placeholder="Short name (nairobi-core-1)" value={form.shortname} onChange={(e) => setForm({ ...form, shortname: e.target.value })} />
        <input className="input" required placeholder="Router public IP" value={form.nasname} onChange={(e) => setForm({ ...form, nasname: e.target.value })} />
        <button className="btn-primary">Register NAS</button>
      </form>
      {secretOnce && (
        <div className="card mt-4 border-amber-300 bg-amber-50">
          <p className="font-semibold">Secret (shown once — copy now):</p>
          <code className="mt-1 block break-all rounded bg-white p-2 text-sm">{secretOnce}</code>
          <p className="mt-2 text-xs">Router config preview:</p>
          <code className="mt-1 block rounded bg-slate-900 p-2 text-xs text-green-300">/radius add service=ppp,hotspot address=&lt;RADIUS_IP&gt; secret={secretOnce.slice(0, 6)}…&#10;/ppp aaa set use-radius=yes accounting=yes</code>
          {msg && <p className="mt-2 text-xs text-amber-800">{msg}</p>}
        </div>
      )}
      <div className="card mt-4">
        {!nas.length ? <p className="text-sm text-slate-500">No data yet.</p> : (
          <ul className="space-y-1 text-sm">{nas.map((n) => (
            <li key={n.id} className="flex justify-between"><span>{n.shortname} · {n.nasname}</span>
            <span className="badge bg-slate-100 text-slate-700">{n.enabled ? n.sync_status : "disabled"}</span></li>))}</ul>)}
      </div>
    </main>
  );
}
