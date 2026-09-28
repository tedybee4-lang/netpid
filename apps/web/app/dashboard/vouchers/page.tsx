"use client";
import { useEffect, useState } from "react";

export default function VouchersPage() {
  const [batches, setBatches] = useState<{ id: string; name: string; quantity: number }[]>([]);
  const [packages, setPackages] = useState<{ id: string; name: string }[]>([]);
  const [codes, setCodes] = useState<{ code: string; status: string }[]>([]);
  const [form, setForm] = useState({ name: "", package_id: "", quantity: 50, code_length: 8 });
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    const [v, p] = await Promise.all([
      fetch("/api/vouchers").then((r) => r.json()),
      fetch("/api/packages").then((r) => r.json()),
    ]);
    setBatches(v.batches ?? []); setPackages(p.packages ?? []);
  }
  useEffect(() => { load(); }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault(); setMsg("Generating…");
    const res = await fetch("/api/vouchers", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...form, quantity: Number(form.quantity) }),
    });
    const j = await res.json();
    if (!res.ok) { setMsg(j.error ?? "Failed"); return; }
    setCodes(j.codes.map((c: string) => ({ code: c, status: "unused" })));
    setMsg(`Batch created: ${j.codes.length} codes. Print via browser (Ctrl/Cmd+P) or copy.`);
    load();
  }

  async function view(batch: string) {
    const j = await fetch(`/api/vouchers?batch=${batch}`).then((r) => r.json());
    setCodes(j.codes ?? []);
  }

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="text-2xl font-black">Vouchers</h1>
      <form onSubmit={create} className="card mt-4 grid gap-2 sm:grid-cols-2">
        <input className="input" required placeholder="Batch name (Kawangware Kiosk A)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <select className="input" required value={form.package_id} onChange={(e) => setForm({ ...form, package_id: e.target.value })}>
          <option value="">Package…</option>
          {packages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <input className="input" type="number" min={1} max={5000} value={form.quantity} onChange={(e) => setForm({ ...form, quantity: Number(e.target.value) })} />
        <button className="btn-primary">Generate batch</button>
      </form>
      {msg && <p className="mt-2 text-sm text-slate-600">{msg}</p>}
      <div className="card mt-4">
        <p className="font-semibold">Batches</p>
        {!batches.length ? <p className="mt-1 text-sm text-slate-500">No data yet.</p> : (
          <ul className="mt-2 space-y-1 text-sm">{batches.map((b) => (
            <li key={b.id} className="flex justify-between"><span>{b.name} · {b.quantity}</span>
            <button className="text-indigo-600 hover:underline" onClick={() => view(b.id)}>View codes</button></li>))}</ul>)}
      </div>
      {!!codes.length && (
        <div className="card mt-4">
          <p className="font-semibold">Codes ({codes.length})</p>
          <div className="mt-2 grid grid-cols-2 gap-1 font-mono text-sm sm:grid-cols-4">
            {codes.slice(0, 200).map((c) => <span key={c.code} className="rounded bg-slate-100 px-2 py-1">{c.code}</span>)}
          </div>
          {codes.length > 200 && <p className="mt-1 text-xs text-slate-500">Showing 200 of {codes.length} — export via API for full CSV.</p>}
        </div>
      )}
    </main>
  );
}
