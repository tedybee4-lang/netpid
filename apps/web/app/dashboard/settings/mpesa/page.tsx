"use client";
import { useCallback, useEffect, useState } from "react";

// ISP admin: declare the Till/PayBill customers pay into. That is the whole
// form. NETPID runs the Daraja app and pushes the M-Pesa request; the ISP
// never sees a consumer key, a passkey or a shortcode, and does not need to
// apply to Safaricom for anything.
export default function MpesaPage() {
  const [form, setForm] = useState({
    payment_method: "", till_number: "", paybill: "",
  });
  const [status, setStatus] = useState<{
    daraja_configured: boolean;
    platform_app_configured: boolean;
    environment: string | null;
  } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/payments/daraja-config");
    if (!r.ok) return;
    const j = await r.json();
    setStatus({
      daraja_configured: Boolean(j.daraja_configured),
      platform_app_configured: Boolean(j.platform_app_configured),
      environment: j.environment ?? null,
    });
    // The server is the source of truth for which number is live, so the form
    // never shows a number the server would refuse to collect into.
    setForm((f) => ({
      ...f,
      payment_method: j.payment_method ?? "",
      till_number: j.till_number ?? "",
      paybill: j.paybill ?? "",
    }));
  }, []);
  useEffect(() => { load(); }, [load]);

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setMsg(null);
    if (!form.payment_method) {
      setErr("Choose Till or PayBill, then enter the number customers pay to.");
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
      setMsg(j.warning ?? `Saved. Customers will be charged straight to your `
        + `${form.payment_method === "paybill" ? "PayBill" : "Till"} `
        + `${j.collects_into ?? ""} when they buy a package.`.trim());
      load();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-6 sm:px-6">
      <h1 className="text-2xl font-black tracking-tight">M-Pesa payments</h1>
      <p className="mt-1 text-sm text-slate-500">
        Enter the Till or PayBill number you want your customers to pay into.
        NETPID sends the M-Pesa request to their phone and the money goes
        straight to that number &mdash; you do not need a Safaricom account or
        any API credentials.
      </p>

      <form onSubmit={submit} className="card mt-4 space-y-3">
        <div>
          <label className="label" htmlFor="d-method">How customers pay</label>
          <select id="d-method" className="input" value={form.payment_method}
            onChange={(e) => set("payment_method", e.target.value)}>
            <option value="">Not set yet</option>
            <option value="till">M-Pesa Till (Buy Goods)</option>
            <option value="paybill">M-Pesa PayBill</option>
          </select>
        </div>

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
          {status?.platform_app_configured
            ? (status.environment === "production"
              ? "Payments are live. When a customer buys a package they get an M-Pesa "
                + "prompt naming your Till, and approving it pays you directly."
              : "NETPID's M-Pesa app is still in testing, so customers approving a "
                + "payment will not move real money yet. Your number is saved and will "
                + "start working as soon as it goes live.")
            : "NETPID is still setting up M-Pesa. Your number will be saved now and will "
              + "start collecting as soon as it is ready."}
        </p>

        {err && <p className="err-box">{err}</p>}
        {msg && <p className="ok-box">{msg}</p>}
        <button className="btn-primary" disabled={busy}>
          {busy ? "Saving…" : "Save payment number"}
        </button>
      </form>
    </main>
  );
}