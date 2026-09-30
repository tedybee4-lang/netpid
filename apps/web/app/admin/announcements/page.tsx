"use client";
import { useCallback, useEffect, useState } from "react";

// Super Admin → Announcements.
//
// Create / edit / publish / unpublish / delete. Unpublishing IS the archive
// action: the `ann_read` policy stops serving an unpublished row to ISPs, so
// an unpublish hides it everywhere while keeping the text on record. The copy
// below says so rather than inventing a separate archived state.

type Row = {
  id: string;
  title: string;
  body: string;
  audience: "isps" | "platform" | "all";
  published: boolean;
  published_at: string | null;
  created_at: string;
};

const AUDIENCE: { value: Row["audience"]; label: string; hint: string }[] = [
  { value: "isps", label: "ISPs", hint: "Only ISP operators see this in their dashboard." },
  { value: "all", label: "ISPs + platform", hint: "Shows for everyone, including the platform console." },
  { value: "platform", label: "Platform only", hint: "Never shown in the ISP dashboard." },
];

const EMPTY = { title: "", body: "", audience: "isps" as Row["audience"], published: false };

export default function AdminAnnouncementsPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    const res = await fetch("/api/admin/announcements");
    const j = await res.json().catch(() => ({}));
    setLoading(false);
    if (!res.ok) { setError(j.error ?? `Could not load (${res.status})`); return; }
    setRows(j.announcements ?? []);
  }, []);

  useEffect(() => { load(); }, [load]);

  function reset() {
    setEditingId(null); setForm(EMPTY); setFormError(null); setNotice(null);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!form.title.trim()) { setFormError("Give it a title."); return; }
    if (!form.body.trim()) { setFormError("Write the message."); return; }

    setSaving(true);
    try {
      const res = await fetch(editingId ? `/api/admin/announcements/${editingId}` : "/api/admin/announcements", {
        method: editingId ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setFormError(j.error ?? "Could not save"); return; }
      setNotice(editingId ? "Announcement updated." : "Announcement created.");
      reset();
      load();
    } finally {
      setSaving(false);
    }
  }

  async function setPublished(row: Row, published: boolean) {
    setNotice(null);
    const res = await fetch(`/api/admin/announcements/${row.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ published }),
    });
    const j = await res.json().catch(() => ({}));
    setNotice(res.ok
      ? (published ? `“${row.title}” is now live.` : `“${row.title}” was unpublished and is now hidden from ISPs.`)
      : (j.error ?? "Could not update"));
    if (res.ok) load();
  }

  async function remove(row: Row) {
    if (!confirm(`Delete “${row.title}” permanently?`)) return;
    setNotice(null);
    const res = await fetch(`/api/admin/announcements/${row.id}`, { method: "DELETE" });
    const j = await res.json().catch(() => ({}));
    setNotice(res.ok ? (j.message ?? "Deleted.") : (j.error ?? "Could not delete"));
    if (res.ok) { if (editingId === row.id) reset(); load(); }
  }

  const audienceHint = AUDIENCE.find((a) => a.value === form.audience)?.hint ?? "";

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight">Announcements</h1>
          <p className="mt-1 text-sm text-slate-500">
            Notices pushed to ISP dashboards. Unpublishing hides a notice everywhere while keeping the text.
          </p>
        </div>
        <button className="btn-primary" onClick={reset}>New announcement</button>
      </header>

      {notice && <p className="rounded-xl bg-slate-100 p-3 text-sm text-slate-700">{notice}</p>}
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800" role="alert">
          <p className="font-semibold">Could not load announcements</p>
          <p className="mt-1">{error}</p>
          <button className="btn-ghost mt-2" onClick={() => { setLoading(true); load(); }}>Retry</button>
        </div>
      )}

      <form onSubmit={save} className="card">
        <h2 className="panel-title">{editingId ? "Edit announcement" : "New announcement"}</h2>
        <div className="mt-3 space-y-3">
          <div>
            <label className="label" htmlFor="ann-title">Title</label>
            <input
              id="ann-title"
              className="input"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="Scheduled maintenance on 12 Nov"
              maxLength={160}
            />
          </div>
          <div>
            <label className="label" htmlFor="ann-body">Message</label>
            <textarea
              id="ann-body"
              className="input min-h-32"
              value={form.body}
              onChange={(e) => setForm({ ...form, body: e.target.value })}
              maxLength={5000}
            />
            <p className="mt-1 text-xs text-slate-500">{form.body.length}/5000</p>
          </div>
          <div>
            <label className="label" htmlFor="ann-audience">Audience</label>
            <select
              id="ann-audience"
              className="input"
              value={form.audience}
              onChange={(e) => setForm({ ...form, audience: e.target.value as Row["audience"] })}
            >
              {AUDIENCE.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
            </select>
            <p className="mt-1 text-xs text-slate-500">{audienceHint}</p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.published}
              onChange={(e) => setForm({ ...form, published: e.target.checked })}
            />
            Publish now (leave off to save as a draft)
          </label>
        </div>

        {formError && (
          <p className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
            {formError}
          </p>
        )}

        <div className="mt-3 flex flex-wrap gap-2">
          <button className="btn-primary" disabled={saving}>{saving ? "Saving…" : "Save"}</button>
          {editingId && <button type="button" className="btn-ghost" onClick={reset}>Cancel</button>}
        </div>
      </form>

      {/* List */}
      <section className="card" aria-busy={loading}>
        <h2 className="panel-title">All announcements ({rows.length})</h2>

        {loading ? (
          <div className="mt-3 space-y-2">
            <div className="h-16 animate-pulse rounded-xl bg-slate-100" />
            <div className="h-16 animate-pulse rounded-xl bg-slate-100" />
          </div>
        ) : !error && rows.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">
            Nothing written yet. Create one above — save as a draft first if you want to review the wording.
          </p>
        ) : !error && (
          <ul className="mt-3 divide-y divide-slate-100">
            {rows.map((r) => (
              <li key={r.id} className="py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 font-semibold text-slate-900">
                      <span className="break-all">{r.title}</span>
                      <span className={`badge ${r.published ? "badge-ok" : "bg-slate-200 text-slate-600"}`}>
                        {r.published ? "live" : "draft"}
                      </span>
                      <span className="badge bg-indigo-50 text-indigo-700">
                        {AUDIENCE.find((a) => a.value === r.audience)?.label ?? r.audience}
                      </span>
                    </p>
                    <p className="mt-1 line-clamp-2 text-sm text-slate-600">{r.body}</p>
                    <p className="mt-1 text-xs text-slate-500">
                      {r.published && r.published_at
                        ? `Live since ${new Date(r.published_at).toLocaleString()}`
                        : `Created ${new Date(r.created_at).toLocaleString()}`}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <button
                      className="btn-ghost"
                      onClick={() => {
                        setEditingId(r.id);
                        setForm({ title: r.title, body: r.body, audience: r.audience, published: r.published });
                        setFormError(null); setNotice(null);
                      }}
                    >
                      Edit
                    </button>
                    <button className="btn-ghost" onClick={() => setPublished(r, !r.published)}>
                      {r.published ? "Unpublish" : "Publish"}
                    </button>
                    <button className="btn-ghost" onClick={() => remove(r)}>Delete</button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
