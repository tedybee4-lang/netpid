import Link from "next/link";
import { RATES, TIERS, TRIAL_DAYS } from "@/lib/pricing";
import { kes } from "@/lib/format";

const plans = TIERS.filter((t) => !t.custom);

const MODULES = [
  {
    group: "Run the network",
    items: [
      ["Routers & provisioning", "Type a router name — NETPID assigns the management IP, generates a strong API password and hands you a RouterOS 6 or 7 script."],
      ["PPPoE & HotSpot", "Provision both services, set speed caps and idle timeouts, and disconnect a user from the dashboard instantly over CoA."],
      ["FreeRADIUS", "NAS clients, users, groups, session accounting and live session control without touching a terminal."],
      ["Topology & TR-069", "Map your fibre and wireless tree, and auto-configure CPE from a built-in ACS."],
      ["AI assistant", "Paste a symptom and get the RouterOS commands to run, ranked by how often that cause is actually seen."],
    ],
  },
  {
    group: "Run the business",
    items: [
      ["Customers & packages", "Full customer records, packages with per-direction speed caps, data caps and expiry dates."],
      ["M-Pesa billing", "STK push to any number, callback tracking, automated expiry and renewal reminders over SMS."],
      ["HotSpot vouchers", "Generate printable batches, redeem by code or MAC, and reconcile prepaid sales at month end."],
      ["Resellers & agents", "Give field agents their own login with a wallet, a price list and a sales ledger."],
      ["Reports & exports", "Revenue, subscriber growth, churn and arrears, as CSV or straight into your accounts."],
    ],
  },
];

const DIFFERENTIATORS = [
  {
    title: "Built for Kenya, not adapted for it",
    body: "Prices in shillings, M-Pesa as the default payment rail, SMS through local aggregators, and a country code your MikroTik actually respects. Nothing is translated after the fact.",
  },
  {
    title: "RouterOS 6 and 7, correctly",
    body: "7.14 moved the radio to /interface/wifi and the DHCP lease to a new path. Getting that wrong fails silently, so NETPID detects the version and emits the right script for the box in front of you.",
  },
  {
    title: "One tenant, one data set",
    body: "Every table is scoped by ISP and enforced again in Postgres row-level security. A query that forgets its filter returns nothing rather than another operator's customers.",
  },
  {
    title: "No per-seat surprises",
    body: "Pay for the routers and subscribers you actually run. Staff accounts are included in your tier, not billed individually.",
  },
];

export default function Home() {
  return (
    <main>
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-600 font-black text-white">N</div>
            <div>
              <p className="font-extrabold tracking-tight">NETPID</p>
              <p className="text-xs text-slate-500">Manage. Connect. Bill.</p>
            </div>
          </div>
          <nav className="flex items-center gap-2">
            <Link className="hidden text-sm font-semibold text-slate-600 hover:text-slate-900 sm:inline" href="/pricing">
              Pricing
            </Link>
            <Link className="btn-ghost" href="/login">Sign in</Link>
            <Link className="btn-primary" href="/signup">Start free trial</Link>
          </nav>
        </div>
      </header>

      <section className="relative overflow-hidden border-b border-slate-200 bg-gradient-to-b from-indigo-50/70 to-white">
        <div className="mx-auto max-w-6xl px-4 py-16 text-center sm:py-24">
          <p className="badge badge-info mb-5">{TRIAL_DAYS}-day free trial · no card needed</p>
          <h1 className="mx-auto max-w-4xl text-4xl font-black tracking-tight sm:text-6xl">
            The ISP platform that runs
            <span className="block text-indigo-600">your routers and your books</span>
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg text-slate-600">
            Customers, packages, M-Pesa billing, SMS, MikroTik, PPPoE, HotSpot and FreeRADIUS — in
            one multi-tenant dashboard. Built for Kenyan ISPs, priced in shillings, invoiced per
            router and per subscriber.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link className="btn-primary px-6 py-3" href="/signup">Create your ISP</Link>
            <Link className="btn-ghost px-6 py-3" href="/pricing">See pricing</Link>
          </div>
          <p className="mt-4 text-sm text-slate-500">
            Works with RouterOS 6 and 7 · FreeRADIUS · M-Pesa · Local SMS aggregators
          </p>

          <dl className="mx-auto mt-14 grid max-w-3xl grid-cols-2 gap-4 sm:grid-cols-4">
            {[
              ["Free trial", `${TRIAL_DAYS} days`],
              ["Setup", "Self-serve"],
              ["Install fee", `KSh ${RATES.installFee / 100} once`],
              ["Router cost", `KSh ${RATES.perRouter / 100}/mo`],
            ].map(([label, value]) => (
              <div key={label} className="card">
                <dt className="stat-label">{label}</dt>
                <dd className="stat-value text-xl">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-16 sm:py-20">
        <h2 className="text-3xl font-black tracking-tight sm:text-4xl">Everything in one place</h2>
        <p className="mt-3 max-w-2xl text-slate-600">
          Twenty modules behind one login. The sidebar is the whole product — nothing is hidden
          behind a sales call.
        </p>
        <div className="mt-8 grid gap-4 md:grid-cols-2">
          {MODULES.map((col) => (
            <div key={col.group} className="card">
              <h3 className="text-sm font-bold uppercase tracking-wide text-indigo-600">{col.group}</h3>
              <ul className="mt-4 space-y-4">
                {col.items.map(([name, body]) => (
                  <li key={name}>
                    <p className="font-bold text-slate-900">{name}</p>
                    <p className="mt-0.5 text-sm text-slate-600">{body}</p>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section className="border-y border-slate-200 bg-slate-900 py-16 text-white sm:py-20">
        <div className="mx-auto max-w-6xl px-4">
          <h2 className="text-3xl font-black tracking-tight sm:text-4xl">
            Why operators switch to NETPID
          </h2>
          <div className="mt-10 grid gap-8 md:grid-cols-2">
            {DIFFERENTIATORS.map((d) => (
              <div key={d.title}>
                <h3 className="text-lg font-bold">{d.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-300">{d.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-16 sm:py-20">
        <h2 className="text-3xl font-black tracking-tight sm:text-4xl">
          Pricing that follows your network
        </h2>
        <p className="mt-3 max-w-2xl text-slate-600">
          You are not billed per seat or per feature flag. You are billed for the routers you run
          and the subscribers you serve.
        </p>
        <div className="mt-8 grid gap-4 md:grid-cols-3">
          {plans.map((p) => (
            <div
              key={p.slug}
              className={`card flex flex-col ${p.popular ? "border-indigo-500 ring-2 ring-indigo-100" : ""}`}
            >
              {p.popular && <span className="badge badge-info mb-2 self-start">Most popular</span>}
              <p className="text-xs font-bold uppercase tracking-wider text-indigo-600">{p.name}</p>
              <p className="mt-1 text-3xl font-extrabold tracking-tight">
                {kes(p.priceMonthly)}
                <span className="text-sm font-semibold text-slate-500">/mo</span>
              </p>
              <p className="mt-2 text-sm text-slate-600">{p.tagline}</p>
              <p className="mt-2 text-xs text-slate-400">{p.blurb}</p>
              <Link
                className={`mt-5 ${p.popular ? "btn-primary" : "btn-ghost"}`}
                href="/signup"
              >
                Start with {p.name.split(" ")[0]}
              </Link>
            </div>
          ))}
        </div>

        <div className="card mt-6">
          <h3 className="text-sm font-bold uppercase tracking-wide text-slate-500">
            How your bill is actually calculated
          </h3>
          <dl className="mt-4 grid gap-x-8 gap-y-3 sm:grid-cols-2">
            {[
              ["Routers", `KSh ${RATES.perRouter / 100} each per month, capped at KSh ${RATES.routerFeeCap / 100}`],
              ["PPPoE subscribers", `KSh ${RATES.perPppoeSub / 100} each per month`],
              ["Static subscribers", `KSh ${RATES.perStaticSub / 100} each per month`],
              ["SMS", `KSh ${(RATES.perSms / 100).toFixed(2)} per message, at cost`],
              ["Installation", `KSh ${RATES.installFee / 100} once, optional`],
              ["Staff accounts", "Included in your tier"],
            ].map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between gap-4 border-b border-slate-100 pb-2">
                <dt className="text-sm text-slate-600">{k}</dt>
                <dd className="text-sm font-semibold text-slate-900">{v}</dd>
              </div>
            ))}
          </dl>
          <Link className="mt-5 inline-flex font-semibold text-indigo-600 hover:underline" href="/pricing">
            Worked examples, the full tier list and FAQs →
          </Link>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-16">
        <div className="card flex flex-wrap items-center justify-between gap-4 bg-indigo-600 text-white">
          <div>
            <h2 className="text-2xl font-black tracking-tight">Start with {TRIAL_DAYS} days on us</h2>
            <p className="mt-1 text-sm text-indigo-100">
              Add a router, paste one script, take your first payment. If it does not fit, walk away
              and owe nothing.
            </p>
          </div>
          <Link className="btn-ghost bg-white text-indigo-700 hover:bg-indigo-50" href="/signup">
            Create your ISP
          </Link>
        </div>
      </section>

      <footer className="border-t border-slate-200 bg-slate-50">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-8 text-sm text-slate-500">
          <p>© {new Date().getFullYear()} NETPID. Manage. Connect. Bill.</p>
          <nav className="flex gap-5">
            <Link className="hover:text-slate-900" href="/pricing">Pricing</Link>
            <Link className="hover:text-slate-900" href="/login">Sign in</Link>
            <Link className="hover:text-slate-900" href="/signup">Create an ISP</Link>
          </nav>
        </div>
      </footer>
    </main>
  );
}


