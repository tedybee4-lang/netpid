"use client";
import { useEffect, useState } from "react";

export default function SmsPage() {
  const [data, setData] = useState<{ logs: { id: string; to_phone: string; event: string | null; status: string; created_at: string }[]; usage: { day: string; sent: number; failed: number }[] } | null>(null);
  const [form, setForm] = useState({ sender_id: "", daily_limit: 500, monthly_limit: 5000, enabled: true });
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/sms").then((r) => r.json()).then((j) => {
      setData(j);
      if (j.settings) setForm({
        sender_id: "", daily_limit: j.settings.daily_limit,
        monthly_limit: j.settings.monthly_limit, enabled: j.settings.enabled,
      });
    });
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault(); setMsg(null);
    const res = await fetch("/api/sms", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form),
    });
    setMsg(res.ok ? "Saved." : "Failed to save.");
  }

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-3xl font-black">SMS (TOPSPEED)</h1>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <form onSubmit={save} className="card space-y-3">
          <p className="font-semibold">Settings & limits</p>
          <div><label className="label">Sender ID</label>
          <input className="input" value={form.sender_id} onChange={(e) => setForm({ ...form, sender_id: e.target.value })} placeholder="LIPANET" /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">Daily limit</label>
            <input className="input" type="number" value={form.daily_limit} onChange={(e) => setForm({ ...form, daily_limit: Number(e.target.value) })} /></div>
            <div><label className="label">Monthly limit</label>
            <input className="input" type="number" value={form.monthly_limit} onChange={(e) => setForm({ ...form, monthly_limit: Number(e.target.value) })} /></div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> SMS enabled
          </label>
          <button className="btn-primary">Save</button>
          {msg && <p className="text-sm text-slate-600">{msg}</p>}
          <p className="text-xs text-slate-500">API keys are stored encrypted server-side and never shown here. Kenyan numbers auto-normalize to 254….</p>
        </form>
        <div className="card">
          <p className="font-semibold">Usage (7 days)</p>
          {!data?.usage?.length ? <p className="mt-2 text-sm text-slate-500">No data yet.</p> : (
            <ul className="mt-2 space-y-1 text-sm">{data.usage.map((u) => (
              <li key={u.day} className="flex justify-between"><span>{u.day}</span><span>sent {u.sent} · failed {u.failed}</span></li>))}</ul>)}
        </div>
      </div>
      <div className="card mt-4">
        <p className="font-semibold">Recent messages</p>
        {!data?.logs?.length ? <p className="mt-2 text-sm text-slate-500">No data yet. Welcome, payment, expiry and suspension messages queue automatically.</p> : (
          <ul className="mt-2 space-y-1 text-sm">{data.logs.map((l) => (
            <li key={l.id} className="flex justify-between"><span>{l.to_phone} · {l.event ?? "manual"}</span><span className="badge bg-slate-100 text-slate-700">{l.status}</span></li>))}</ul>)}
      </div>
    </main>
  );
}
