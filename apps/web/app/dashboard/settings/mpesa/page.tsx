"use client";

import { useEffect, useState } from "react";

// ISP admin: Daraja credentials + Till/PayBill. Secrets are write-only: the
// API only ever returns configured flags, never values.
export default function MpesaSettingsPage() {
  const [status, setStatus] = useState<{
    daraja_configured: boolean;
    providers?: { provider: string; payment_method: string | null; till_number: string | null; paybill: string | null }[];
  } | null>(null);
  const [form, setForm] = useState({
    consumer_key: "", consumer_secret: "", passkey: "", shortcode: "",
    environment: "sandbox" as "sandbox" | "production",
    // "" = not declared yet. The API infers from whichever number is present,
    // so an ISP who only ever typed a till number never sees an error.
    payment_method: "" as "" | "till" | "paybill",
    till_number: "", paybill: "",
  });
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const r = await fetch("/api/payments/daraja-config");
    if (!r.ok) return;
    const j = await r.json();
    setStatus(j);
    // Prefill the declared method and its number so the form shows what is
    // actually live rather than blank boxes the operator has to guess about.
    const p = (j.providers ?? []).find((x: { provider: string }) => x.provider === "daraja");
    if (p) {
      setForm((f) => ({
        ...f,
        payment_method: (p.payment_method as "till" | "paybill" | null) ?? "",
        till_number: p.till_number ?? f.till_number,
        paybill: p.paybill ?? f.paybill,
      }));
    }
  }
  useEffect(() => { load(); }, []);

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setMsg(null);
    // The only thing an operator genuinely has to supply is the number their
    // customers pay to. The Daraja credential set is optional and only used to
    // switch on STK Push, so it is validated here as all-or-nothing rather than
    // blocking the save — the server enforces the same rule.
    const creds = [form.consumer_key, form.consumer_secret, form.passkey, form.shortcode]
      .map((x) => x.trim()).filter(Boolean);
    if (creds.length > 0 && creds.length < 4) {
      setErr("Fill in all four Daraja fields or leave them all blank.");
      return;
    }
    if (!form.payment_method) {
      setErr("Choose how your customers pay, then enter the Till or PayBill number.");
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
      // Branch on the warning, not on `verified`. `verified:false` used to mean
      // both "Safaricom refused these" and "you never sent any", so saving a
      // Till number on its own showed a Daraja rejection error.
      if (j.warning) {
        setErr(j.warning);
      } else if (j.stk_push === "on") {
        setMsg(`STK Push connected (${j.environment}). Credentials are encrypted at rest and never shown again.`);
        setForm((f) => ({ ...f, consumer_key: "", consumer_secret: "", passkey: "" }));
      } else {
        setMsg("Saved. Customers can now pay to this number and enter their receipt code.");
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
        Enter the Till or PayBill number your customers pay to. That is all you need
        to start taking payments.
        {status && (
          <> STK Push: <b>{status.daraja_configured ? "connected" : "not connected"}</b>.</>
        )}
      </p>

      <form onSubmit={submit} className="mt-4 space-y-4">
        {/* The one thing every operator has. Deliberately first, and the save
            button sits with it, so paying at a till never requires opening a
            section about API credentials they do not have. */}
        <section className="card space-y-3">
          <div>
            <label className="label" htmlFor="d-method">How customers pay</label>
            <select id="d-method" className="input" value={form.payment_method}
              onChange={(e) => set("payment_method", e.target.value)}>
              <option value="">Not set yet</option>
              <option value="till">M-Pesa Till (Buy Goods)</option>
              <option value="paybill">M-Pesa PayBill</option>
            </select>
          </div>

          {/* One number, chosen by the method above. Showing both boxes at once is
              how an operator ends up with two live numbers and a portal that cannot
              say which one is real. */}
          {form.payment_method === "till" && (
            <div>
              <label className="label" htmlFor="d-till">Till number customers pay to</label>
              <input id="d-till" className="input" inputMode="numeric" value={form.till_number}
                onChange={(e) => set("till_number", e.target.value)} placeholder="e.g. 5441898" />
            </div>
          )}
          {form.payment_method === "paybill" && (
            <div>
              <label className="label" htmlFor="d-pb">PayBill number customers pay to</label>
              <input id="d-pb" className="input" inputMode="numeric" value={form.paybill}
                onChange={(e) => set("paybill", e.target.value)} placeholder="e.g. 174379" />
            </div>
          )}
          <p className="hint">
            This is the number your captive portal prints to customers paying
            manually, and the number the receipt code is checked against.
          </p>
          {err && <p className="err-box">{err}</p>}
          {msg && <p className="ok-box">{msg}</p>}
          <button className="btn-primary" disabled={busy}>
            {busy ? "Saving…" : "Save payment number"}
          </button>
        </section>

        {/* STK Push is a different, optional product: Safaricom pushes the
            request to the customer's phone. It needs a Daraja app, which takes
            days to get and most ISPs at this stage do not have one. */}
        <details className="card">
          <summary className="cursor-pointer text-sm font-semibold">
            Optional: turn on STK Push (M-Pesa request to the customer&rsquo;s phone)
          </summary>
          <div className="mt-3 space-y-3">
            <p className="hint">
              Skip this entirely if your customers pay at a till or PayBill and type
              the receipt code in. Only add your Safaricom Daraja app if Safaricom
              has issued you one. They are encrypted with APP_ENCRYPTION_KEY before
              storage and are never displayed back. Test in sandbox first with
              254700000000 before going live.
            </p>
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
            <div>
              <label className="label" htmlFor="d-env">Environment</label>
              <select id="d-env" className="input" value={form.environment}
                onChange={(e) => set("environment", e.target.value)}>
                <option value="sandbox">sandbox</option>
                <option value="production">production</option>
              </select>
            </div>
          </div>
        </details>
      </form>
    </main>
  );
}
