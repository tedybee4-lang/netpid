import Link from "next/link";
import { RATES, TIERS, TRIAL_DAYS, routerFee } from "@/lib/pricing";
import { kes } from "@/lib/format";
import PricingCalculator from "@/components/PricingCalculator";

const FAQ = [
  {
    q: "How is the monthly bill worked out?",
    a: `You pay KSh ${RATES.perRouter / 100} per MikroTik router each month, but that router fee never goes above KSh ${RATES.routerFeeCap / 100}. On top of that, PPPoE subscribers are KSh ${RATES.perPppoeSub / 100} each and static subscribers KSh ${RATES.perStaticSub / 100} each. SMS are billed at KSh ${(RATES.perSms / 100).toFixed(2)} per message.`,
  },
  {
    q: `What happens after the ${TRIAL_DAYS}-day free trial?`,
    a: "Pick any plan and keep going. If you don't, your routers and customer-facing portal stay live, but admin features pause until you reactivate. Nothing is auto-charged — we ask before billing.",
  },
  {
    q: "Which MikroTik routers are supported?",
    a: "Anything running RouterOS v6.45+ with API access enabled. We've tested across the RB750, RB951, hAP and CCR series.",
  },
  {
    q: "What are the M-Pesa transaction fees?",
    a: "Safaricom Daraja charges its standard transaction rate, billed directly to you by Safaricom. NETPID takes no cut of customer payments — your monthly subscription is the only thing you pay us.",
  },
  {
    q: "Is customer payment data secure?",
    a: "All Daraja API credentials are encrypted at rest. Customer phone numbers are stored only as long as needed to issue receipts and reconcile sessions. We never sell or share data with third parties.",
  },
  {
    q: "Can I import existing voucher batches?",
    a: "Yes. The Vouchers page supports CSV bulk-import for existing codes, and you can generate new print-ready batches from inside the dashboard.",
  },
  {
    q: "Do you offer setup help?",
    a: `Every plan includes guided onboarding documentation. Growth ISP and Scaled ISP also include free router-config calls so we can walk you through your first hotspot setup live. If you'd rather we did it all, the optional ${kes(RATES.installFee)} installation covers device configuration, hotspot setup, M-Pesa integration and testing.`,
  },
  {
    q: "Can I cancel anytime?",
    a: "Yes — cancel from the Billing page in one click. No long-term contracts, no early-termination fees.",
  },
];

export default function PricingPage() {
  return (
    <main className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-5">
          <Link href="/" className="flex items-center gap-2">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-indigo-600 font-black text-white">N</span>
            <span>
              <span className="block text-sm font-extrabold tracking-tight">NETPID</span>
              <span className="block text-xs text-slate-500">Manage. Connect. Bill.</span>
            </span>
          </Link>
          <nav className="flex items-center gap-2">
            <Link className="btn-ghost" href="/login">Sign in</Link>
            <Link className="btn-primary" href="/signup">Start free trial</Link>
          </nav>
        </div>
      </header>

      <section className="mx-auto max-w-3xl px-4 pb-8 pt-14 text-center">
        <p className="text-xs font-bold uppercase tracking-widest text-indigo-600">Pricing</p>
        <h1 className="mt-2 text-4xl font-black tracking-tight sm:text-5xl">
          Pay for the routers you run
        </h1>
        <p className="mx-auto mt-4 max-w-2xl text-slate-600">
          KSh {RATES.perRouter / 100} per MikroTik router each month, capped at KSh{" "}
          {RATES.routerFeeCap / 100}. Add subscribers only as you grow. Every plan
          starts with a {TRIAL_DAYS}-day free trial.
        </p>
      </section>

      <section className="mx-auto grid max-w-6xl gap-4 px-4 pb-12 md:grid-cols-2 xl:grid-cols-4">
        {TIERS.map((t) => (
          <div key={t.slug}
            className={`card relative flex flex-col ${t.popular ? "border-indigo-500 ring-2 ring-indigo-200" : ""}`}>
            {t.popular && (
              <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-indigo-600 px-3 py-1 text-xs font-bold text-white">
                Most popular
              </span>
            )}
            <p className="text-xs font-bold uppercase tracking-wider text-indigo-600">{t.name}</p>
            <p className="mt-1 text-3xl font-black tracking-tight">
              {t.custom ? "Custom" : kes(t.priceMonthly)}
              {!t.custom && <span className="text-sm font-semibold text-slate-500">/mo</span>}
            </p>
            <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{t.tagline}</p>
            <p className="mt-2 text-sm text-slate-600">{t.blurb}</p>
            {!t.custom && (
              <p className="mt-2 text-xs text-slate-500">
                or {kes(t.priceYearly)}/year · save 2 months
              </p>
            )}
            <ul className="mt-4 flex-1 space-y-2 text-sm text-slate-700">
              {t.features.map((f) => (
                <li key={f} className="flex gap-2">
                  <span className="mt-0.5 text-emerald-600">✓</span>
                  <span>{f}</span>
                </li>
              ))}
            </ul>
            <Link className={`${t.popular ? "btn-primary" : "btn-ghost"} mt-5 w-full`}
              href={t.custom ? "/signup?plan=custom" : `/signup?plan=${t.slug}`}>
              {t.custom ? "Talk to us" : `Start ${TRIAL_DAYS}-day trial`}
            </Link>
          </div>
        ))}
      </section>

      <section className="mx-auto max-w-4xl px-4 pb-12">
        <PricingCalculator />
      </section>

      <section className="mx-auto max-w-4xl px-4 pb-12">
        <div className="card">
          <h2 className="panel-title">How your bill is calculated</h2>
          <p className="mt-2 text-sm text-slate-600">
            Every month: the router fee (capped), plus each active subscriber. No
            per-GB charges and no cut of your customer payments — your subscription
            is the only thing you pay NETPID.
          </p>
          <div className="mt-4 overflow-x-auto">
            <table className="table min-w-[420px]">
            <tbody>
              <tr>
                <td className="font-semibold">MikroTik router</td>
                <td className="text-right tnum">KSh {RATES.perRouter / 100} / router / month</td>
              </tr>
              <tr>
                <td className="font-semibold">Router fee ceiling</td>
                <td className="text-right tnum">KSh {RATES.routerFeeCap / 100} / month</td>
              </tr>
              <tr>
                <td className="font-semibold">PPPoE subscriber</td>
                <td className="text-right tnum">KSh {RATES.perPppoeSub / 100} / month</td>
              </tr>
              <tr>
                <td className="font-semibold">Static-IP subscriber</td>
                <td className="text-right tnum">KSh {RATES.perStaticSub / 100} / month</td>
              </tr>
              <tr>
                <td className="font-semibold">SMS (expiry, reminders, receipts)</td>
                <td className="text-right tnum">KSh {(RATES.perSms / 100).toFixed(2)} / message</td>
              </tr>
              <tr className="bg-slate-50">
                <td className="font-semibold">One-time installation (optional)</td>
                <td className="text-right tnum">{kes(RATES.installFee)}</td>
              </tr>
            </tbody>
            </table>
          </div>
          <p className="hint mt-3">
            Worked example — 3 routers and 40 PPPoE subscribers costs{" "}
            {kes(routerFee(3) + 40 * RATES.perPppoeSub)} a month. The router fee is
            already capped, so routers past {RATES.routerFeeCap / RATES.perRouter} add
            nothing extra.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-4 pb-16">
        <h2 className="text-center text-2xl font-black tracking-tight">Questions</h2>
        <div className="mt-6 space-y-3">
          {FAQ.map((f) => (
            <details key={f.q} className="card">
              <summary className="cursor-pointer font-semibold">{f.q}</summary>
              <p className="mt-2 text-sm text-slate-600">{f.a}</p>
            </details>
          ))}
        </div>
        <p className="mt-8 text-center text-sm text-slate-600">
          Still deciding?{" "}
          <Link className="font-semibold text-indigo-600 hover:underline" href="/signup">
            Start your {TRIAL_DAYS}-day free trial
          </Link>{" "}
          — no card needed.
        </p>
      </section>
    </main>
  );
}
