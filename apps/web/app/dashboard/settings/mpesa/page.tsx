"use client";

import { useEffect, useState } from "react";

// ISP admin: Daraja credentials + Till/PayBill. Secrets are write-only: the
// API only ever returns configured flags, never values.
export default function MpesaSettingsPage() {
  const [status, setStatus] = useState<{ daraja_configured: boolean } | null>(null);
  const [form, setForm] = useState({
    consumer_key: "", consumer_secret: "", passkey: "", shortcode: "",
    environment: "sandbox" as "sandbox" | "production",
    till_number: "", paybill: "",
  });
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const r = await fetch("/api/payments/daraja-config");
    if (r.ok) setStatus(await r.json());
  }
  useEffect(() => { load(); }, []);

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setMsg(null);
    if (!form.consumer_key || !form.consumer_secret || !form.passkey || !form.shortcode) {
      setErr("Consumer key, consumer secret, passkey and shortcode are all required.");
      return;
    }
    setBusy(true);
    try {
      const r = await fetch("/api/payments/daraja-config", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Could not save");
      // A 200 with verified:false means it was stored but Safaricom refused it,
      // so the provider stays 'disabled' and STK Push will not be offered.
      if (j.verified === false) {
        setErr(j.warning ?? "Daraja rejected the credentials.");
      } else {
        setMsg(`Daraja connected (${j.environment}). Credentials are encrypted at rest and never shown again.`);
        setForm((f) => ({ ...f, consumer_key: "", consumer_secret: "", passkey: "" }));
      }
      load();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-6 sm:px-6">
      <h1 className="text-2xl font-black tracking-tight">M-Pesa / Daraja</h1>
      <p className="mt-1 text-sm text-slate-500">
        Direct Safaricom Daraja for STK Push, plus your Till/PayBill for manual payments.
        {status && (
          <> Status: <b>{status.daraja_configured ? "connected" : "not connected"}</b>.</>
        )}
      </p>

      <form onSubmit={submit} className="card mt-4 space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="d-key">Consumer key</label>
            <input id="d-key" className="input" type="password" autoComplete="new-password"
              value={form.consumer_key} onChange={(e) => set("consumer_key", e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="d-secret">Consumer secret</label>
            <input id="d-secret" className="input" type="password" autoComplete="new-password"
              value={form.consumer_secret} onChange={(e) => set("consumer_secret", e.target.value)} />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="d-pass">Passkey</label>
            <input id="d-pass" className="input" type="password" autoComplete="new-password"
              value={form.passkey} onChange={(e) => set("passkey", e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="d-short">Business shortcode</label>
            <input id="d-short" className="input" inputMode="numeric"
              value={form.shortcode} onChange={(e) => set("shortcode", e.target.value)}
              placeholder="174379" />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="label" htmlFor="d-env">Environment</label>
            <select id="d-env" className="input" value={form.environment}
              onChange={(e) => set("environment", e.target.value)}>
              <option value="sandbox">sandbox</option>
              <option value="production">production</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="d-till">Till number</label>
            <input id="d-till" className="input" value={form.till_number}
              onChange={(e) => set("till_number", e.target.value)} placeholder="Buy Goods till" />
          </div>
          <div>
            <label className="label" htmlFor="d-pb">PayBill</label>
            <input id="d-pb" className="input" value={form.paybill}
              onChange={(e) => set("paybill", e.target.value)} placeholder="PayBill number" />
          </div>
        </div>
        <p className="hint">
          Get these from the Safaricom Daraja portal. They are encrypted with
          APP_ENCRYPTION_KEY before storage and are never displayed back.
          Test in sandbox first with 254700000000 before going live.
        </p>
        {err && <p className="err-box">{err}</p>}
        {msg && <p className="ok-box">{msg}</p>}
        <button className="btn-primary" disabled={busy}>
          {busy ? "Saving…" : "Save Daraja credentials"}
        </button>
      </form>
    </main>
  );
}
