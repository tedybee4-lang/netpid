"use client";
import { useMemo, useState } from "react";
import { RATES, TIERS, estimate } from "@/lib/pricing";
import { kes } from "@/lib/format";

// NETPID cost estimator.
//
// EVERY number here is derived from RATES in lib/pricing.ts — the same
// constants the pricing table, the FAQ and the plan picker use. There is no
// hardcoded total, no sample dataset and no "average customer" figure: enter
// your own numbers and the breakdown reacts. The result is labelled an
// estimate because that is exactly what it is — nobody has seen your ISP yet.

type Key = "routers" | "pppoe" | "statics" | "sms";

const FIELDS: { key: Key; label: string; hint: string; max: number; step: number; placeholder: string }[] = [
  {
    key: "routers", label: "MikroTik routers", max: 5_000, step: 1, placeholder: "3",
    hint: `KSh ${RATES.perRouter / 100} each per month, capped at KSh ${RATES.routerFeeCap / 100}.`,
  },
  {
    key: "pppoe", label: "PPPoE subscribers", max: 200_000, step: 10, placeholder: "40",
    hint: `KSh ${RATES.perPppoeSub / 100} each per month.`,
  },
  {
    key: "statics", label: "Static-IP subscribers", max: 20_000, step: 1, placeholder: "0",
    hint: `KSh ${RATES.perStaticSub / 100} each per month.`,
  },
  {
    key: "sms", label: "SMS per month", max: 2_000_000, step: 50, placeholder: "200",
    hint: `KSh ${(RATES.perSms / 100).toFixed(2)} each — expiry notices, reminders, receipts.`,
  },
];

const DEFAULTS: Record<Key, string> = { routers: "3", pppoe: "40", statics: "0", sms: "200" };

/** Whole, non-negative, within range. A blank field counts as zero. */
function parse(raw: string, max: number): { ok: boolean; value: number; error?: string } {
  const t = raw.trim();
  if (t === "") return { ok: true, value: 0 };
  if (!/^\d+$/.test(t)) return { ok: false, value: 0, error: "Use whole numbers only — no decimals or dashes." };
  const n = Number(t);
  if (n > max) {
    return { ok: false, value: 0, error: `That is more than ${max.toLocaleString()} — check the figure.` };
  }
  return { ok: true, value: n };
}

export default function PricingCalculator() {
  const [raw, setRaw] = useState<Record<Key, string>>(DEFAULTS);
  const [install, setInstall] = useState(false);

  const parsed = useMemo(() => {
    const out = {} as Record<Key, { ok: boolean; value: number; error?: string }>;
    for (const f of FIELDS) out[f.key] = parse(raw[f.key], f.max);
    return out;
  }, [raw]);

  const invalid = FIELDS.filter((f) => !parsed[f.key].ok);
  const est = useMemo(() => (
    invalid.length
      ? null
      : estimate(parsed.routers.value, parsed.pppoe.value, parsed.statics.value, parsed.sms.value, install)
  ), [invalid.length, parsed, install]);

  function set(key: Key, value: string) {
    setRaw((r) => ({ ...r, [key]: value }));
  }

  const rows: { label: string; sub: string; value: number }[] = est ? [
    {
      label: "Router fee",
      sub: est.routerCapReached
        ? `Capped — all ${est.capInRouters} billable routers, extra routers cost nothing`
        : `${parsed.routers.value} router${parsed.routers.value === 1 ? "" : "s"} × KSh ${RATES.perRouter / 100}`,
      value: est.routerFee,
    },
    { label: "PPPoE subscribers", sub: `${parsed.pppoe.value.toLocaleString()} × KSh ${RATES.perPppoeSub / 100}`, value: est.pppoe },
    { label: "Static-IP subscribers", sub: `${parsed.statics.value.toLocaleString()} × KSh ${RATES.perStaticSub / 100}`, value: est.statics },
    { label: "SMS", sub: `${parsed.sms.value.toLocaleString()} × KSh ${(RATES.perSms / 100).toFixed(2)}`, value: est.sms },
  ] : [];

  return (
    <section className="card" aria-labelledby="calc-heading">
      <h2 id="calc-heading" className="panel-title">Work out your monthly cost</h2>
      <p className="mt-1 text-sm text-slate-500">
        Enter your own numbers. Nothing here is a sample or an average — it is the same price list
        shown above, applied to what you type.
      </p>

      <div className="mt-4 grid gap-4 lg:grid-cols-5">
        {/* Inputs */}
        <div className="lg:col-span-3">
          <div className="grid gap-4 sm:grid-cols-2">
            {FIELDS.map((f) => {
              const p = parsed[f.key];
              return (
                <div key={f.key}>
                  <label className="label" htmlFor={`calc-${f.key}`}>{f.label}</label>
                  <input
                    id={`calc-${f.key}`}
                    className="input tnum"
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    step={f.step}
                    value={raw[f.key]}
                    placeholder={f.placeholder}
                    aria-invalid={!p.ok}
                    aria-describedby={p.ok ? `calc-${f.key}-hint` : `calc-${f.key}-err`}
                    onChange={(e) => set(f.key, e.target.value)}
                  />
                  {p.ok ? (
                    <p id={`calc-${f.key}-hint`} className="mt-1 text-xs text-slate-500">{f.hint}</p>
                  ) : (
                    <p id={`calc-${f.key}-err`} role="alert" className="mt-1 text-xs text-red-700">
                      {p.error}
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          <label className="mt-4 flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={install}
              onChange={(e) => setInstall(e.target.checked)}
            />
            <span>
              Add the optional one-time installation ({kes(RATES.installFee)})
              <span className="block text-xs text-slate-500">
                Device configuration, HotSpot setup, M-Pesa integration and testing.
              </span>
            </span>
          </label>

          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" className="btn-ghost" onClick={() => setRaw(DEFAULTS)}>Reset</button>
            {TIERS.filter((t) => t.routers > 0 && t.routers <= 50).map((t) => (
              <button
                key={t.slug}
                type="button"
                className="btn-ghost"
                onClick={() => setRaw({ ...raw, routers: String(t.routers) })}
              >
                {t.routers} router{t.routers === 1 ? "" : "s"}
              </button>
            ))}
          </div>
        </div>

        {/* Result */}
        <div className="lg:col-span-2">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Estimated monthly cost
            </p>

            {est ? (
              <>
                <p className="mt-1 text-3xl font-black tracking-tight tnum">{kes(est.monthly)}</p>
                <p className="mt-1 text-xs text-slate-500">
                  per month{install ? `, plus ${kes(est.install)} once` : ""}
                </p>

                <dl className="mt-4 space-y-2 text-sm">
                  {rows.map((r) => (
                    <div key={r.label} className="flex items-start justify-between gap-3 border-b border-slate-200 pb-2 last:border-0">
                      <div className="min-w-0">
                        <dt className="font-semibold text-slate-800">{r.label}</dt>
                        <dd className="text-xs text-slate-500">{r.sub}</dd>
                      </div>
                      <dd className="shrink-0 font-semibold tnum">{kes(r.value)}</dd>
                    </div>
                  ))}
                  {est.install > 0 && (
                    <div className="flex items-center justify-between gap-3">
                      <dt className="font-semibold text-slate-800">Installation (one-time)</dt>
                      <dd className="shrink-0 font-semibold tnum">{kes(est.install)}</dd>
                    </div>
                  )}
                </dl>

                {est.routerCapReached && (
                  <p className="mt-3 rounded-lg bg-white p-2.5 text-xs text-slate-600">
                    The router fee stops at {kes(RATES.routerFeeCap)} a month, so every router past{" "}
                    {est.capInRouters} is free. Extra subscribers still add to the bill.
                  </p>
                )}

                {est.install > 0 && (
                  <p className="mt-3 border-t border-slate-200 pt-3 text-sm">
                    <span className="text-slate-600">First invoice: </span>
                    <span className="font-bold tnum">{kes(est.firstInvoice)}</span>
                  </p>
                )}
              </>
            ) : (
              <p className="mt-2 text-sm text-slate-600">
                Fix the highlighted field{invalid.length > 1 ? "s" : ""} to see the breakdown. The
                total stays blank rather than showing a number built on a figure that will not parse.
              </p>
            )}
          </div>

          <p className="mt-3 text-xs text-slate-500">
            This is an estimate from our published price list, not a quote — we have not seen your
            network yet. It excludes Safaricom&apos;s own M-Pesa transaction charges, which Safaricom
            bills to you directly; NETPID takes no cut of your customers&apos; payments.
          </p>
        </div>
      </div>
    </section>
  );
}
