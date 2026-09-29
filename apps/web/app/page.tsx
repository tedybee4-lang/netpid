import Link from "next/link";
import { RATES, TIERS, TRIAL_DAYS } from "@/lib/pricing";
import { kes } from "@/lib/format";

const plans = TIERS.filter((t) => !t.custom);

export default function Home() {
  return (
    <main>
      <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-5">
        <div className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-600 font-black text-white">N</div>
          <div><p className="font-extrabold tracking-tight">NETPID</p>
          <p className="text-xs text-slate-500">Manage. Connect. Bill.</p></div>
        </div>
        <nav className="flex gap-2">
          <Link className="btn-ghost" href="/login">Sign in</Link>
          <Link className="btn-primary" href="/signup">Start free trial</Link>
        </nav>
      </header>
      <section className="mx-auto max-w-6xl px-4 pb-10 pt-8 text-center">
        <h1 className="mx-auto max-w-3xl text-4xl font-black tracking-tight sm:text-5xl">
          Complete ISP Management Platform
        </h1>
        <p className="mx-auto mt-4 max-w-2xl text-slate-600">
          Customers, packages, M-Pesa billing, SMS, MikroTik, PPPoE, HotSpot and
          FreeRADIUS — one multi-tenant SaaS. Built for Kenyan ISPs, priced in KES.
        </p>
        <div className="mt-6 flex justify-center gap-2">
          <Link className="btn-primary" href="/signup">Create your ISP</Link>
          <Link className="btn-ghost" href="/login">Sign in</Link>
        </div>
      </section>
      <section className="mx-auto grid max-w-6xl gap-4 px-4 pb-16 sm:grid-cols-3">
        {plans.map((p) => (
          <div key={p.slug} className="card">
            <p className="text-xs font-bold uppercase tracking-wider text-indigo-600">{p.name}</p>
            <p className="mt-1 text-xl font-extrabold">
              {kes(p.priceMonthly)}<span className="text-sm font-semibold text-slate-500">/mo</span>
            </p>
            <p className="mt-2 text-sm text-slate-600">{p.tagline} — {p.blurb}</p>
          </div>
        ))}
      </section>
      <section className="mx-auto max-w-2xl px-4 pb-16 text-center text-sm text-slate-600">
        <p>
          KSh {RATES.perRouter / 100} per router each month (capped at KSh {RATES.routerFeeCap / 100}),
          plus KSh {RATES.perPppoeSub / 100} per PPPoE subscriber and KSh {RATES.perStaticSub / 100} per
          static subscriber. {TRIAL_DAYS}-day free trial to start.
        </p>
        <Link className="mt-3 inline-flex font-semibold text-indigo-600 hover:underline" href="/pricing">
          See full pricing and FAQs →
        </Link>
      </section>
    </main>
  );
}
