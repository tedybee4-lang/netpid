"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  TEMPLATE_EVENTS, TEMPLATE_VARIABLES, varsFor, renderTemplate, unknownVars,
} from "@/lib/sms-templates";

// Template management: create / edit / disable / delete with a live preview.
//
// The preview renders through the SAME renderTemplate() the worker uses, with
// the catalogue's sample values, so what is on screen is what a subscriber gets.
// Delivery status is never shown here — a template only decides wording; whether
// a message actually went out is decided later by the provider response.

type Template = {
  id: string;
  event: string;
  locale: string;
  body: string;
  enabled: boolean;
  created_at: string;
};

const SAMPLE = Object.fromEntries(TEMPLATE_VARIABLES.map((v) => [v.key, v.example])) as Record<string, string>;

const EMPTY = { event: "payment_received", locale: "en", body: "", enabled: true };

export default function TemplatesPanel() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const res = await fetch("/api/sms/templates");
    const j = await res.json().catch(() => ({}));
    setLoading(false);
    if (!res.ok) { setError(j.error ?? `Could not load templates (${res.status})`); return; }
    setTemplates(j.templates ?? []);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Existing rows offer the events that are not taken yet for this locale.
  const availableEvents = useMemo(() => {
    const taken = new Set(
      templates.filter((t) => t.locale === form.locale && t.id !== editingId).map((t) => t.event),
    );
    return TEMPLATE_EVENTS.filter((e) => !taken.has(e.event));
  }, [templates, form.locale, editingId]);

  function startCreate() {
    setEditingId(null);
    setForm({ ...EMPTY, event: availableEvents[0]?.event ?? "payment_received" });
    setFormError(null);
    setNotice(null);
  }

  function startEdit(t: Template) {
    setEditingId(t.id);
    setForm({ event: t.event, locale: t.locale, body: t.body, enabled: t.enabled });
    setFormError(null);
    setNotice(null);
  }

  function insertVar(key: string) {
    setForm((f) => ({ ...f, body: `${f.body}{{${key}}}` }));
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!form.body.trim()) { setFormError("Write the message first."); return; }
    setSaving(true);
    try {
      const res = await fetch(editingId ? `/api/sms/templates/${editingId}` : "/api/sms/templates", {
        method: editingId ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(editingId ? { body: form.body, enabled: form.enabled } : form),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setFormError(j.error ?? "Could not save"); return; }
      setNotice(editingId ? "Template updated." : "Template created.");
      setEditingId(null);
      setForm(EMPTY);
      load();
    } finally {
      setSaving(false);
    }
  }

  async function toggle(t: Template) {
    setNotice(null);
    const res = await fetch(`/api/sms/templates/${t.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: !t.enabled }),
    });
    const j = await res.json().catch(() => ({}));
    setNotice(res.ok
      ? (t.enabled ? `“${t.event}” is now off — this message will not be sent.` : `“${t.event}” is back on.`)
      : (j.error ?? "Could not update"));
    if (res.ok) load();
  }

  async function remove(t: Template) {
    if (!confirm(`Delete the “${t.event}” template? The event falls back to built-in wording.`)) return;
    setNotice(null);
    const res = await fetch(`/api/sms/templates/${t.id}`, { method: "DELETE" });
    const j = await res.json().catch(() => ({}));
    setNotice(res.ok ? (j.message ?? "Deleted.") : (j.error ?? "Could not delete"));
    if (res.ok) {
      if (editingId === t.id) { setEditingId(null); setForm(EMPTY); }
      load();
    }
  }

  const preview = renderTemplate(form.body || "(your message appears here)", SAMPLE);
  const unknown = unknownVars(form.body, form.event);
  const eventHint = TEMPLATE_EVENTS.find((e) => e.event === form.event)?.hint ?? "";

  return (
    <section className="card mt-4" aria-busy={loading}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="panel-title">Message templates</h2>
          <p className="mt-1 text-sm text-slate-500">
            These are the words subscribers actually receive for each event.
          </p>
        </div>
        <button className="btn-primary" onClick={startCreate}>New template</button>
      </div>

      {notice && <p className="mt-3 rounded-xl bg-slate-100 p-3 text-sm text-slate-700">{notice}</p>}
      {error && (
        <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <p className="font-semibold">Could not load templates</p>
          <p className="mt-1">{error}</p>
          <button className="btn-ghost mt-2" onClick={() => { setLoading(true); load(); }}>Retry</button>
        </div>
      )}

      {/* Editor */}
      <form onSubmit={save} className="mt-4 rounded-xl border border-slate-200 p-4">
        <p className="font-semibold">{editingId ? "Edit template" : "New template"}</p>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="tpl-event">Event</label>
            <select
              id="tpl-event"
              className="input"
              value={form.event}
              disabled={Boolean(editingId)}
              onChange={(e) => setForm({ ...form, event: e.target.value })}
            >
              {(editingId
                ? TEMPLATE_EVENTS.filter((x) => x.event === form.event)
                : availableEvents
              ).map((e) => <option key={e.event} value={e.event}>{e.label} — {e.event}</option>)}
              {editingId && !TEMPLATE_EVENTS.some((x) => x.event === form.event) && (
                <option value={form.event}>{form.event}</option>
              )}
            </select>
            <p className="mt-1 text-xs text-slate-500">
              {eventHint || "Custom event — only sends if something in the product fires it."}
            </p>
          </div>
          <div>
            <label className="label" htmlFor="tpl-locale">Locale</label>
            <input
              id="tpl-locale"
              className="input"
              value={form.locale}
              disabled={Boolean(editingId)}
              onChange={(e) => setForm({ ...form, locale: e.target.value })}
            />
            <p className="mt-1 text-xs text-slate-500">One template per event and locale.</p>
          </div>
        </div>

        <div className="mt-3">
          <label className="label" htmlFor="tpl-body">Message</label>
          <textarea
            id="tpl-body"
            className="input min-h-28 font-mono"
            value={form.body}
            onChange={(e) => setForm({ ...form, body: e.target.value })}
            placeholder="Hi {{name}}, your package expires {{expiry}}."
            maxLength={480}
          />
          <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-slate-500">{form.body.length}/480</span>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
              />
              Send this message
            </label>
          </div>
        </div>

        {/* Variable palette — only the keys the worker can actually resolve here. */}
        <div className="mt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Insert variable</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {varsFor(form.event).map((v) => (
              <button
                key={v.key}
                type="button"
                className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 font-mono text-xs hover:bg-slate-100"
                onClick={() => insertVar(v.key)}
                title={`${v.label} — e.g. ${v.example}`}
              >
                {`{{${v.key}}}`}
              </button>
            ))}
          </div>
          {unknown.length > 0 && (
            <p className="mt-1.5 text-xs text-amber-700">
              {unknown.length === 1 ? "Not a known variable" : "Not known variables"}: {unknown.join(", ")} — these render as blank.
            </p>
          )}
        </div>

        <div className="mt-3 rounded-xl bg-slate-50 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Preview (sample data)</p>
          <p className="mt-1.5 whitespace-pre-wrap text-sm text-slate-800">{preview}</p>
          <p className="mt-1.5 text-xs text-slate-500">
            {preview.length} characters · {preview.length > 160 ? `${Math.ceil(preview.length / 160)} SMS parts` : "1 SMS part"}
          </p>
        </div>

        {formError && <p className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{formError}</p>}

        <div className="mt-3 flex flex-wrap gap-2">
          <button className="btn-primary" disabled={saving}>{saving ? "Saving…" : "Save template"}</button>
          {editingId && (
            <button
              type="button"
              className="btn-ghost"
              onClick={() => { setEditingId(null); setForm(EMPTY); setFormError(null); }}
            >
              Cancel
            </button>
          )}
        </div>
      </form>

      {/* List */}
      <div className="mt-4">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Existing templates ({templates.length})
        </h3>

        {loading ? (
          <div className="mt-3 space-y-2" aria-live="polite">
            <div className="h-4 w-1/3 animate-pulse rounded bg-slate-200" />
            <div className="h-4 w-2/3 animate-pulse rounded bg-slate-200" />
          </div>
        ) : !error && templates.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">
            No templates yet. Without one each event falls back to built-in wording — create one to control what subscribers read.
          </p>
        ) : !error && (
          <ul className="mt-3 divide-y divide-slate-100">
            {templates.map((t) => (
              <li key={t.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-800">
                    {t.event}
                    <span className="badge bg-slate-100 text-slate-600">{t.locale}</span>
                    <span className={`badge ${t.enabled ? "badge-ok" : "bg-slate-200 text-slate-600"}`}>
                      {t.enabled ? "sending" : "off"}
                    </span>
                  </p>
                  <p className="mt-1 line-clamp-2 text-sm text-slate-600">{t.body}</p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button className="btn-ghost" onClick={() => startEdit(t)}>Edit</button>
                  <button className="btn-ghost" onClick={() => toggle(t)}>
                    {t.enabled ? "Disable" : "Enable"}
                  </button>
                  <button className="btn-ghost" onClick={() => remove(t)}>Delete</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="mt-4 text-xs text-slate-500">
        Disabling a template stops that message entirely — it does not fall back to the default text.
        Delete one and the built-in wording returns. Delivery results come from the provider&apos;s real
        response and are shown under recent messages.
      </p>
    </section>
  );
}
