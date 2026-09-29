"use client";
import { useCallback, useEffect, useState } from "react";

export type Integration = {
  id: string; provider: string; enabled: boolean; base_url: string | null;
  has_key: boolean; last_status: string | null; last_checked_at: string | null;
};

const BLURB: Record<string, string> = {
  uisp: "Pull customers, plans and invoices from a UISP installation and keep NETPID in step with it.",
  social_spot: "Link a Social Spot account so prepaid HotSpot sales reconcile into the same ledger.",
  whatsapp_business: "Send ticket replies and expiry notices over WhatsApp Business instead of SMS.",
  sms_alt: "Add a second SMS provider as a fallback when the primary one is down.",
};

/**
 * Shared editor for one provider. Secrets are write-only: the key is never
 * fetched back from the server, only "a key is stored" is, so the field always
 * starts blank and saving without typing keeps the existing key.
 */
export default function IntegrationCard({
  provider, initial,
}: {
  provider: string;
  initial: Integration | null;
}) {
  const [enabled, setEnabled] = useState(initial?.enabled ?? false);
  const [baseUrl, setBaseUrl] = useState(initial?.base_url ?? "");
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Re-sync when the parent finishes a reload, without stomping typing.
  useEffect(() => {
    setEnabled(initial?.enabled ?? false);
    setBaseUrl(initial?.base_url ?? "");
  }, [initial?.id, initial?.enabled, initial?.base_url]);

  const hasKey = initial?.has_key ?? false;
  const label = provider.replace(/_/g, " ");

  async function save() {
    setBusy(true); setMsg(null);
    const r = await fetch("/api/integrations", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider, enabled, base_url: baseUrl,
        // An untouched field must not wipe a stored key.
        api_key: clearKey ? "" : apiKey || undefined,
      }),
    });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setMsg({ ok: false, text: j.error ?? "Save failed" }); return; }
    setMsg({ ok: true, text: "Saved." });
    setApiKey(""); setClearKey(false);
  }

  async function test() {
    setBusy(true); setMsg(null);
    const r = await fetch("/api/integrations", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider, action: "test" }),
    });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    setMsg({ ok: r.ok, text: r.ok ? `${j.status} — ${j.detail}` : (j.error ?? "Test failed") });
  }

  return (
    <div className="card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-black capitalize">{label}</h2>
          <p className="mt-1 max-w-xl text-sm text-slate-600">{BLURB[provider]}</p>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-sm font-semibold text-slate-700">
          <input type="checkbox" checked={enabled} className="h-4 w-4 accent-indigo-600"
            onChange={(e) => setEnabled(e.target.checked)} />
          {enabled ? "Enabled" : "Disabled"}
        </label>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor={`${provider}-url`}>Base URL</label>
          <input id={`${provider}-url`} className="input" type="url" value={baseUrl}
            placeholder="https://example.com" onChange={(e) => setBaseUrl(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor={`${provider}-key`}>
            API key {hasKey && <span className="badge badge-ok ml-1">stored</span>}
          </label>
          <input id={`${provider}-key`} className="input font-mono" type="password" value={apiKey}
            placeholder={hasKey ? "Leave blank to keep the stored key" : "Paste the API key"}
            onChange={(e) => { setApiKey(e.target.value); setClearKey(false); }} />
          {hasKey && (
            <label className="mt-1.5 flex items-center gap-2 text-xs text-slate-500">
              <input type="checkbox" checked={clearKey} className="h-3.5 w-3.5 accent-red-600"
                onChange={(e) => setClearKey(e.target.checked)} />
              Remove the stored key
            </label>
          )}
        </div>
      </div>

      <p className="hint">
        Keys are encrypted with AES-256-GCM before they are written and are never sent back to the browser.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button className="btn-primary" onClick={save} disabled={busy}>Save</button>
        <button className="btn-ghost" onClick={test} disabled={busy || !baseUrl}>Test connection</button>
        {initial?.last_checked_at && (
          <span className="text-xs text-slate-500">
            Last checked {new Date(initial.last_checked_at).toLocaleString("en-KE")}
            {initial.last_status ? ` — ${initial.last_status}` : ""}
          </span>
        )}
      </div>

      {msg && <p className={`mt-3 ${msg.ok ? "ok-box" : "err-box"}`}>{msg.text}</p>}
    </div>
  );
}

export function useIntegrations() {
  const [rows, setRows] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    const r = await fetch("/api/integrations");
    if (r.ok) setRows((await r.json()).integrations ?? []);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);
  return { rows, loading, reload: load };
}
