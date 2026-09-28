import Link from "next/link";

const plans = [
  { name: "Starter", price: "KSh 1,500/mo", blurb: "Up to 200 customers, 2 routers, 500 SMS." },
  { name: "Professional", price: "KSh 3,500/mo", blurb: "1,000 customers, HotSpot + PPPoE, API." },
  { name: "Business", price: "KSh 7,500/mo", blurb: "5,000 customers, resellers, inventory." },
  { name: "Enterprise", price: "KSh 15,000/mo", blurb: "Unlimited scale, SLA, dedicated support." },
];

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
      <section className="mx-auto grid max-w-6xl gap-4 px-4 pb-16 sm:grid-cols-2 lg:grid-cols-4">
        {plans.map((p) => (
          <div key={p.name} className="card">
            <p className="text-xs font-bold uppercase tracking-wider text-indigo-600">{p.name}</p>
            <p className="mt-1 text-xl font-extrabold">{p.price}</p>
            <p className="mt-2 text-sm text-slate-600">{p.blurb}</p>
          </div>
        ))}
      </section>
    </main>
  );
}
