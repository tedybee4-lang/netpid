"use client";
import { useCallback, useEffect, useState } from "react";
import PageShell, { Empty, fmtDateTime } from "@/components/PageShell";

type Note = {
  id: string; type: string; title: string; message: string;
  read: boolean; created_at: string;
  customer_id: string | null;
  customers: { customer_no: string; full_name: string } | null;
};

const TYPE_STYLE: Record<string, string> = {
  payment: "badge-ok", support: "badge-info", router: "badge-warn",
  system: "badge-mute", escalation: "badge-bad", customer: "badge-info",
};

export default function NotificationsPage() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [unread, setUnread] = useState(0);
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/notifications");
    if (!r.ok) return;
    const j = await r.json();
    setNotes(j.notifications ?? []);
    setUnread(j.unread ?? 0);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function mark(id: string, read: boolean) {
    setBusy(true);
    await fetch("/api/notifications", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, read }),
    });
    setBusy(false); load();
  }
  async function markAll() {
    setBusy(true);
    await fetch("/api/notifications", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ all: true, read: true }),
    });
    setBusy(false); load();
  }

  const shown = onlyUnread ? notes.filter((n) => !n.read) : notes;

  return (
    <PageShell
      title="Notifications"
      description="Payments, support tickets, router events and escalations raised for your ISP."
      action={
        <div className="flex gap-2">
          {unread > 0 && (
            <button className="btn-ghost" onClick={markAll} disabled={busy}>
              Mark all read ({unread})
            </button>
          )}
        </div>
      }
    >
      <div className="mb-4 flex items-center gap-2">
        <button
          className={`btn-sm rounded-xl border px-3 py-1.5 text-xs font-semibold transition ${
            !onlyUnread ? "border-indigo-600 bg-indigo-600 text-white" : "border-slate-200 bg-white text-slate-600"
          }`}
          onClick={() => setOnlyUnread(false)}
        >
          All ({notes.length})
        </button>
        <button
          className={`btn-sm rounded-xl border px-3 py-1.5 text-xs font-semibold transition ${
            onlyUnread ? "border-indigo-600 bg-indigo-600 text-white" : "border-slate-200 bg-white text-slate-600"
          }`}
          onClick={() => setOnlyUnread(true)}
        >
          Unread ({unread})
        </button>
      </div>

      <div className="card-flush">
        {!shown.length
          ? <Empty>{onlyUnread ? "Nothing unread." : "No notifications yet."}</Empty>
          : (
            <ul className="divide-y divide-slate-100">
              {shown.map((n) => (
                <li key={n.id} className={`flex items-start gap-3 px-4 py-3 ${n.read ? "bg-white" : "bg-indigo-50/40"}`}>
                  <span className={`badge ${TYPE_STYLE[n.type] ?? "badge-mute"} mt-0.5 shrink-0`}>{n.type}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold text-slate-900">{n.title}</p>
                    <p className="text-sm text-slate-600">{n.message}</p>
                    <p className="mt-0.5 text-xs text-slate-400">
                      {fmtDateTime(n.created_at)}
                      {n.customers && <> · {n.customers.customer_no} {n.customers.full_name}</>}
                    </p>
                  </div>
                  <button
                    className="btn-ghost btn-sm shrink-0"
                    onClick={() => mark(n.id, !n.read)}
                    disabled={busy}
                  >
                    {n.read ? "Mark unread" : "Mark read"}
                  </button>
                </li>
              ))}
            </ul>
          )}
      </div>
    </PageShell>
  );
}
