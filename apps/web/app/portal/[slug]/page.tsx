import { createClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import { kes } from "@/lib/isp";

// Tenant-branded captive portal: /portal/[slug] (public, no login).
// Login/voucher/pay handled via RADIUS + PayHero; NO direct RADIUS from browser.
export default async function PortalPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const supabase = await createClient();
  const { data: isp } = await supabase.from("isps").select("id,name,slug,phone,support_phone,support_whatsapp").eq("slug", slug).maybeSingle();
  if (!isp) notFound();
  // Public read: settings + enabled hotspot/voucher packages.
  // Both queries are independent, so issue them together — this public page is
  // loaded before login on a phone, and no session is required.
  const [settings, packages] = await Promise.all([
    supabase.from("isp_settings")
      .select("brand_color,portal_title,payment_instructions,coverage_info,portal_terms,portal_privacy")
      .eq("isp_id", isp.id).maybeSingle(),
    supabase.from("packages").select("id,name,price,duration_value,duration_unit,download_kbps")
      .eq("isp_id", isp.id).eq("enabled", true).in("service_type", ["hotspot", "voucher"]).limit(12),
  ]);
  const cfg = (settings?.data ?? {}) as {
    brand_color?: string; portal_title?: string;
    payment_instructions?: string | null; coverage_info?: string | null;
    portal_terms?: string | null; portal_privacy?: string | null;
  };
  const brand = cfg.brand_color ?? "#4F46E5";

  return (
    <main className="mx-auto max-w-md px-4 py-10">
      <div className="card text-center" style={{ borderTop: `6px solid ${brand}` }}>
        <p className="text-xs font-bold uppercase tracking-widest text-slate-500">Welcome to</p>
        <h1 className="mt-1 text-3xl font-black">{isp.name}</h1>
        <p className="mt-1 text-sm text-slate-500">{cfg.portal_title ?? "Fast, affordable internet. Pay with M-Pesa."}</p>
        {cfg.coverage_info && (
          <p className="mt-2 whitespace-pre-line text-xs text-slate-500">{cfg.coverage_info}</p>
        )}
        <div className="mt-5 space-y-3 text-left">
          {(packages?.data ?? []).map((p) => (
            <div key={p.id} className="flex items-center justify-between rounded-xl border border-slate-200 p-3">
              <div><p className="font-extrabold">{p.name}</p>
              <p className="text-xs text-slate-500">{p.duration_value} {p.duration_unit}{p.download_kbps ? ` · ${Math.round(p.download_kbps / 1000)} Mbps` : ""}</p></div>
              <a className="btn-primary" style={{ background: brand }} href={`/portal/${slug}/buy?package=${p.id}`}>{kes(p.price)} · Buy</a>
            </div>
          ))}
          {!(packages?.data ?? []).length && <p className="text-sm text-slate-500">No hotspot packages published yet.</p>}
        </div>
        <div className="mt-5 grid grid-cols-2 gap-2">
          <a className="btn-ghost" href={`/portal/${slug}/login`}>Login</a>
          <a className="btn-ghost" href={`/portal/${slug}/voucher`}>Use voucher</a>
        </div>
        {cfg.payment_instructions && (
          <div className="mt-5 rounded-xl border border-slate-200 bg-slate-50 p-3 text-left">
            <p className="text-xs font-bold uppercase tracking-wide text-slate-500">How to pay</p>
            <p className="mt-1 whitespace-pre-line text-sm text-slate-700">{cfg.payment_instructions}</p>
          </div>
        )}
        {(cfg.portal_terms || cfg.portal_privacy) && (
          <div className="mt-5 space-y-3 text-left text-xs text-slate-500">
            {cfg.portal_terms && (
              <details>
                <summary className="cursor-pointer font-semibold">Terms of service</summary>
                <p className="mt-1 whitespace-pre-line">{cfg.portal_terms}</p>
              </details>
            )}
            {cfg.portal_privacy && (
              <details>
                <summary className="cursor-pointer font-semibold">Privacy policy</summary>
                <p className="mt-1 whitespace-pre-line">{cfg.portal_privacy}</p>
              </details>
            )}
          </div>
        )}
        <p className="mt-4 text-xs text-slate-500">
          Support: {isp.support_phone ?? isp.phone ?? "—"}{isp.support_whatsapp ? ` · WhatsApp ${isp.support_whatsapp}` : ""}
        </p>
      </div>
    </main>
  );
}
