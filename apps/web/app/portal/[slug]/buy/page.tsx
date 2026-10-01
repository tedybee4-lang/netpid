import { createClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import { kes } from "@/lib/isp";
import BuyForm from "./BuyForm";

// Captive-portal checkout: /portal/[slug]/buy?package=<id> — public, no login.
//
// Every "Buy" button on the portal links here. Until this page existed that
// link was a 404, which meant the one flow the product actually sells — pay
// from the portal, get connected — was unreachable from the UI.
export default async function PortalBuyPage({
  params, searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ package?: string }>;
}) {
  const { slug } = await params;
  const { package: packageId } = await searchParams;

  const supabase = await createClient();
  const { data: isp } = await supabase.from("isps")
    .select("id,name,slug,phone,support_phone,support_whatsapp")
    .eq("slug", slug).maybeSingle();
  if (!isp) notFound();

  const { data: settings } = await supabase.from("isp_settings")
    .select("brand_color,portal_title")
    .eq("isp_id", isp.id).maybeSingle();

  // STK Push is offered only when this ISP has an ACTIVE, verified Daraja app.
  // Anything else (no app, credentials rejected, turned off) means the buyer
  // pays at the till and submits a receipt instead of pressing a button that
  // can only fail.
  const { data: provider } = await supabase.from("payment_providers")
    .select("status").eq("isp_id", isp.id).eq("provider", "daraja").maybeSingle();
  const stkAvailable = (provider?.status ?? null) === "active";

  // Same public read scope the portal itself uses: enabled hotspot/voucher only
  // (see 0026_portal_public.sql). A PPPoE package can never be bought here.
  const { data: pkg } = packageId
    ? await supabase.from("packages")
      .select("id,name,price,duration_value,duration_unit,download_kbps,upload_kbps")
      .eq("id", packageId).eq("isp_id", isp.id).eq("enabled", true)
      .in("service_type", ["hotspot", "voucher"]).maybeSingle()
    : { data: null };
  if (!pkg) notFound();

  const cfg = (settings ?? {}) as { brand_color?: string };
  const brand = cfg.brand_color ?? "#4F46E5";
  const support = isp.support_phone ?? isp.phone ?? "—";
  // The till number is deliberately NOT rendered here. The portal is STK-only,
  // so there is no manual payment to give instructions for: the number the
  // customer needs is the one in the M-Pesa prompt Safaricom sends them, which
  // is this ISP's own Till. Printing it on the page would suggest a manual
  // payment that the page can no longer accept.

  return (
    <main className="mx-auto max-w-md px-4 py-10">
      <a className="text-sm text-indigo-600 hover:underline" href={`/portal/${slug}`}>
        ← Packages
      </a>

      <div className="card mt-3" style={{ borderTop: `6px solid ${brand}` }}>
        <p className="text-xs font-bold uppercase tracking-widest text-slate-500">
          {isp.name}
        </p>
        <h1 className="mt-1 text-2xl font-black">{pkg.name}</h1>
        <p className="mt-1 text-3xl font-black tracking-tight tnum">{kes(pkg.price)}</p>
        <p className="mt-1 text-xs text-slate-500">
          {pkg.duration_value} {pkg.duration_unit}
          {pkg.download_kbps ? ` · ${Math.round(pkg.download_kbps / 1000)} Mbps down` : ""}
          {pkg.upload_kbps ? ` · ${Math.round(pkg.upload_kbps / 1000)} Mbps up` : ""}
        </p>

        <BuyForm
          slug={slug}
          packageId={pkg.id}
          price={pkg.price}
          support={support}
          stkAvailable={stkAvailable}
        />
      </div>

      <p className="mt-4 text-center text-xs text-slate-500">
        Support: {support}
        {isp.support_whatsapp ? ` · WhatsApp ${isp.support_whatsapp}` : ""}
      </p>
    </main>
  );
}
