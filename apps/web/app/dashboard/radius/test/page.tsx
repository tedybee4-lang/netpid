"use client";
import { useEffect, useState } from "react";

export default function RadiusTestPage() {
  const [nas, setNas] = useState<{ id: string; shortname: string }[]>([]);
  const [form, setForm] = useState({ nas_id: "", username: "", password: "" });
  const [result, setResult] = useState<string | null>(null);
  const [logs, setLogs] = useState<{ username: string; event: string; created_at: string }[]>([]);

  useEffect(() => {
    fetch("/api/radius/nas").then((r) => r.json()).then((j) => setNas(j.nas ?? []));
    fetch("/api/radius/test").then((r) => r.json()).then((j) => setLogs(j.logs ?? []));
  }, []);

  async function run(e: React.FormEvent) {
    e.preventDefault(); setResult("Testing… (server-side radtest, max ~15s)");
    const res = await fetch("/api/radius/test", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form),
    });
    const j = await res.json();
    setResult(res.ok ? `${j.result} · ${j.latency_ms}ms` : (j.error ?? "Failed"));
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <a className="text-sm text-indigo-600 hover:underline" href="/dashboard/radius">← RADIUS</a>
      <h1 className="mt-2 text-2xl font-black">Test authentication</h1>
      <form onSubmit={run} className="card mt-4 space-y-2">
        <select className="input" required value={form.nas_id} onChange={(e) => setForm({ ...form, nas_id: e.target.value })}>
          <option value="">Select NAS…</option>
          {nas.map((n) => <option key={n.id} value={n.id}>{n.shortname}</option>)}
        </select>
        <input className="input" required placeholder="username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
        <input className="input" required type="password" placeholder="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        <button className="btn-primary w-full">Run test</button>
        {result && <p className="rounded-xl bg-slate-100 p-3 text-sm font-bold">{result}</p>}
        <p className="text-xs text-slate-500">Runs on the server via radtest. Passwords are never logged or stored in logs.</p>
      </form>
      <div className="card mt-4">
        <p className="font-semibold">Recent results</p>
        {!logs.length ? <p className="mt-1 text-sm text-slate-500">No data yet.</p> : (
          <ul className="mt-2 space-y-1 text-sm">{logs.map((l, i) => (
            <li key={i} className="flex justify-between"><span>{l.username}</span><span className="badge bg-slate-100 text-slate-700">{l.event}</span></li>))}</ul>)}
      </div>
    </main>
  );
}
