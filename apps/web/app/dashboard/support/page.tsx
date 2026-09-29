"use client";
import { useCallback, useEffect, useState } from "react";
import PageShell, { Empty, StatGrid, fmtDateTime } from "@/components/PageShell";

type Ticket = {
  id: string; ticket_no: string; subject: string; status: string; priority: string;
  channel: string; created_at: string; body: string;
  customers: { customer_no: string; full_name: string; phone: string } | null;
};
type Customer = { id: string; customer_no: string; full_name: string; phone: string };

const FILTERS = ["all", "open", "pending", "resolved", "closed"] as const;
const PRIORITY: Record<string, string> = {
  urgent: "badge-bad", high: "badge-warn", normal: "badge-mute", low: "badge-mute",
};
const STATUS_BADGE: Record<string, string> = {
  open: "badge-info", pending: "badge-warn", resolved: "badge-ok", closed: "badge-mute",
};

export default function SupportPage() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [filter, setFilter] = useState<string>("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState({
    subject: "", body: "", customer_id: "", priority: "normal", channel: "email",
  });

  const load = useCallback(async () => {
    const [t, c] = await Promise.all([
      fetch(`/api/tickets?status=${filter}`).then((r) => r.json()).catch(() => ({ tickets: [] })),
      fetch("/api/customers?limit=500").then((r) => r.json()).catch(() => ({ customers: [] })),
    ]);
    setTickets(t.tickets ?? []);
    setCustomers(c.customers ?? []);
  }, [filter]);
  useEffect(() => { load(); }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    const r = await fetch("/api/tickets", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form),
    });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setErr(j.error ?? "Could not open the ticket"); return; }
    setForm({ subject: "", body: "", customer_id: "", priority: "normal", channel: "email" });
    setFilter("all");
    load();
  }

  async function patch(id: string, body: Record<string, unknown>) {
    setBusy(true); setErr(null);
    const r = await fetch("/api/tickets", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, ...body }),
    });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) setErr(j.error ?? "Update failed");
    if (body.reply) setReply("");
    load();
  }

  const current = tickets.find((t) => t.id === openId) ?? null;

  return (
    <PageShell
      title="Support tickets"
      description="Track every customer problem in one place — who raised it, which channel, and what is still open."
    >
      <StatGrid items={[
        { label: "Open", value: tickets.filter((t) => t.status === "open").length, sub: "Awaiting first reply" },
        { label: "Pending", value: tickets.filter((t) => t.status === "pending").length, sub: "Waiting on the customer" },
        { label: "Resolved", value: tickets.filter((t) => t.status === "resolved").length, sub: "In this view" },
        { label: "Urgent", value: tickets.filter((t) => t.priority === "urgent" && t.status !== "closed").length, sub: "Still open" },
      ]} />


      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <div>
          <div className="mb-3 flex flex-wrap gap-1 rounded-xl border border-slate-200 bg-white p-1 sm:w-fit">
            {FILTERS.map((f) => (
              <button key={f} onClick={() => setFilter(f)}
                className={`rounded-lg px-3 py-1.5 text-xs font-bold capitalize transition ${
                  filter === f ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-50"
                }`}>
                {f}
              </button>
            ))}
          </div>

          {err && <p className="err-box mb-3">{err}</p>}

          <div className="card-flush overflow-x-auto">
            {!tickets.length
              ? <Empty>No tickets in this view.</Empty>
              : (
                <table className="table" style={{ minWidth: 760 }}>
                  <thead>
                    <tr><th>Ticket</th><th>Customer</th><th>Channel</th><th>Priority</th><th>Status</th><th>Raised</th></tr>
                  </thead>
                  <tbody>
                    {tickets.map((t) => (
                      <tr key={t.id} className="cursor-pointer"
                        onClick={() => setOpenId(t.id === openId ? null : t.id)}>
                        <td>
                          <p className="font-mono text-xs text-slate-500">{t.ticket_no}</p>
                          <p className="font-semibold text-slate-900">{t.subject}</p>
                        </td>
                        <td>
                          {t.customers
                            ? <>{t.customers.full_name}<p className="text-xs text-slate-400">{t.customers.phone}</p></>
                            : <span className="text-slate-400">Walk-in</span>}
                        </td>
                        <td className="capitalize">{t.channel}</td>
                        <td><span className={`badge ${PRIORITY[t.priority]}`}>{t.priority}</span></td>
                        <td><span className={`badge ${STATUS_BADGE[t.status]}`}>{t.status}</span></td>
                        <td className="text-xs text-slate-500">{fmtDateTime(t.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </div>

          {current && (
            <div className="card mt-4">
              <p className="font-bold">{current.ticket_no} — {current.subject}</p>
              <pre className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-xl bg-slate-50 p-3 text-xs text-slate-700">
                {current.body || "No description recorded."}
              </pre>
              <textarea className="input mt-3" rows={3} placeholder="Add a reply to the thread…"
                value={reply} onChange={(e) => setReply(e.target.value)} />
              <div className="mt-3 flex flex-wrap gap-2">
                <button className="btn-primary btn-sm" disabled={busy || !reply.trim()}
                  onClick={() => patch(current.id, { reply })}>Send reply</button>
                {current.status !== "resolved" && (
                  <button className="btn-ghost btn-sm" disabled={busy}
                    onClick={() => patch(current.id, { status: "resolved" })}>Mark resolved</button>
                )}
                {current.status === "resolved" && (
                  <button className="btn-ghost btn-sm" disabled={busy}
                    onClick={() => patch(current.id, { status: "open" })}>Reopen</button>
                )}
              </div>
            </div>
          )}
        </div>

        <form onSubmit={create} className="card h-fit">
          <p className="panel-title mb-3">Open a ticket</p>
          <div className="space-y-3">
            <div>
              <label className="label" htmlFor="t-subject">Subject</label>
              <input id="t-subject" className="input" required minLength={3} maxLength={160}
                value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })}
                placeholder="Customer cannot connect after move" />
            </div>
            <div>
              <label className="label" htmlFor="t-customer">Customer</label>
              <select id="t-customer" className="input" value={form.customer_id}
                onChange={(e) => setForm({ ...form, customer_id: e.target.value })}>
                <option value="">Not linked (walk-in)</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>{c.customer_no} · {c.full_name}</option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="label" htmlFor="t-priority">Priority</label>
                <select id="t-priority" className="input" value={form.priority}
                  onChange={(e) => setForm({ ...form, priority: e.target.value })}>
                  {["low", "normal", "high", "urgent"].map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="t-channel">Channel</label>
                <select id="t-channel" className="input" value={form.channel}
                  onChange={(e) => setForm({ ...form, channel: e.target.value })}>
                  {["email", "whatsapp", "phone", "portal"].map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className="label" htmlFor="t-body">Details</label>
              <textarea id="t-body" className="input" rows={4} maxLength={4000}
                value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })}
                placeholder="What happened, what was tried, what the customer expects." />
            </div>
          </div>
          <button className="btn-primary mt-4 w-full" type="submit" disabled={busy}>
            {busy ? "Saving…" : "Open ticket"}
          </button>
        </form>
      </div>
    </PageShell>
  );
}
