"use client";
import { useEffect, useState } from "react";

export default function RadiusUsersPage() {
  const [users, setUsers] = useState<{ id: string; username: string; enabled: boolean; sync_status: string }[]>([]);
  const [customers, setCustomers] = useState<{ id: string; full_name: string }[]>([]);
  const [form, setForm] = useState({ customer_id: "", username: "", password: "", service_type: "pppoe" });
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    const [u, c] = await Promise.all([
      fetch("/api/radius/users").then((r) => r.json()),
      fetch("/api/customers").then((r) => r.json()),
    ]);
    setUsers(u.users ?? []); setCustomers(c.customers ?? []);
  }
  useEffect(() => { load(); }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault(); setMsg(null);
    const res = await fetch("/api/radius/users", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form),
    });
    const j = await res.json();
    setMsg(res.ok ? `Saved ${j.user.username} (${j.user.enabled ? "enabled" : "disabled — activate customer first"}).` : (j.error ?? "Failed"));
    if (res.ok) { setForm({ customer_id: "", username: "", password: "", service_type: "pppoe" }); load(); }
  }

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <a className="text-sm text-indigo-600 hover:underline" href="/dashboard/radius">← RADIUS</a>
      <h1 className="mt-2 text-2xl font-black">RADIUS users</h1>
      <form onSubmit={save} className="card mt-4 grid gap-2 sm:grid-cols-2">
        <select className="input" required value={form.customer_id} onChange={(e) => setForm({ ...form, customer_id: e.target.value })}>
          <option value="">Select customer…</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.full_name}</option>)}
        </select>
        <select className="input" value={form.service_type} onChange={(e) => setForm({ ...form, service_type: e.target.value })}>
          <option value="pppoe">PPPoE</option><option value="hotspot">HotSpot</option>
          <option value="voucher">Voucher</option><option value="static">Static</option>
        </select>
        <input className="input" required placeholder="username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
        <input className="input" required type="password" placeholder="password (stored encrypted)" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        <button className="btn-primary sm:col-span-2">Save login</button>
      </form>
      {msg && <p className="mt-2 text-sm text-slate-600">{msg}</p>}
      <div className="card mt-4">
        {!users.length ? <p className="text-sm text-slate-500">No data yet.</p> : (
          <ul className="space-y-1 text-sm">{users.map((u) => (
            <li key={u.id} className="flex justify-between"><span>{u.username}</span>
            <span className="badge bg-slate-100 text-slate-700">{u.enabled ? u.sync_status : "disabled"}</span></li>))}</ul>)}
      </div>
    </main>
  );
}
