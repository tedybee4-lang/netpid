"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import PageShell from "@/components/PageShell";

/**
 * Small utilities that do not warrant a table of their own but that an ISP
 * asks for constantly. Each one works entirely in the browser — no server data,
 * no side effects — so they are safe to hand to a cashier.
 */
export default function ExtrasPage() {
  const [mac, setMac] = useState("");
  const [octets, setOctets] = useState("1024");
  const [voucher, setVoucher] = useState("");

  // 6 random bytes in the locally-administered range, formatted the way
  // MikroTik prints them.
  function randomMac() {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    bytes[0] = (bytes[0] | 0x02) & 0xfe; // unicast, locally administered
    setMac([...bytes].map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(":"));
  }

  function normaliseMac() {
    const hex = mac.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
    if (hex.length !== 12) return "A MAC address needs exactly 12 hex digits.";
    return hex.match(/.{2}/g)!.join(":");
  }

  const speed = (() => {
    const n = Number(octets);
    if (!Number.isFinite(n) || n < 0) return "—";
    // 1 octet/s = 8 bits/s. Mbps with 1000 vs 1024 is the marketing number
    // ISPs actually sell, which is what the operator wants to see here.
    return `${((n * 8) / 1_000_000).toLocaleString("en-KE", { maximumFractionDigits: 2 })} Mbps`;
  })();

  return (
    <PageShell
      title="Extras"
      description="Everyday calculators for the counter and the installer. These run entirely in your browser — nothing is sent or stored."
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card">
          <h2 className="text-lg font-black">MAC address helper</h2>
          <p className="mt-1 text-sm text-slate-600">
            Generate a locally-administered MAC, or tidy up one read off a device label.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <input
              className="input font-mono uppercase" placeholder="A4:83:E7:1B:22:09" value={mac}
              onChange={(e) => setMac(e.target.value)} aria-label="MAC address"
            />
            <button className="btn-ghost" onClick={randomMac}>Generate</button>
          </div>
          {mac && (
            <p className="mt-3 rounded-xl bg-slate-50 p-3 font-mono text-sm">
              {normaliseMac()}
            </p>
          )}
          <p className="hint">
            A locally-administered address starts with bit 2 of the first octet set, so it can never
            collide with real vendor hardware.
          </p>
        </section>

        <section className="card">
          <h2 className="text-lg font-black">Speed converter</h2>
          <p className="mt-1 text-sm text-slate-600">
            Convert an octet/second figure — what MikroTik and RADIUS report — into the Mbps an ISP
            advertises.
          </p>
          <div className="mt-3">
            <label className="label" htmlFor="octets">Octets per second</label>
            <input
              id="octets" className="input tnum" type="number" min={0} value={octets}
              onChange={(e) => setOctets(e.target.value)}
            />
          </div>
          <p className="mt-3 rounded-xl bg-slate-50 p-3 text-sm font-semibold tnum">{speed}</p>
          <p className="hint">8 bits to the octet; 1,000,000 to the megabit — the decimal convention used on price lists.</p>
        </section>

        <section className="card">
          <h2 className="text-lg font-black">Voucher code check</h2>
          <p className="mt-1 text-sm text-slate-600">
            Look a code up before handing a customer a top-up. Reads the same ledger the portal uses.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <input
              className="input font-mono uppercase" placeholder="X7K2M9QD" value={voucher}
              onChange={(e) => setVoucher(e.target.value)} aria-label="Voucher code"
            />
            <Link
              className={`btn-ghost ${voucher.trim() ? "" : "pointer-events-none opacity-50"}`}
              href={`/portal/voucher?code=${encodeURIComponent(voucher.trim())}`}
            >
              Check code
            </Link>
          </div>
          <p className="hint">
            Codes are case-insensitive. The portal page shows the package, price and expiry.
          </p>
        </section>

        <section className="card">
          <h2 className="text-lg font-black">Keyboard shortcuts</h2>
          <dl className="mt-3 space-y-2 text-sm">
            {[
              ["/", "Focus the menu search box"],
              ["?", "Show this list"],
              ["Esc", "Close the mobile menu"],
            ].map(([k, v]) => (
              <div key={k} className="flex items-center gap-3">
                <dt><kbd className="rounded-lg border border-slate-300 bg-slate-50 px-2 py-0.5 font-mono text-xs">{k}</kbd></dt>
                <dd className="text-slate-600">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="hint">Press <kbd className="rounded border border-slate-300 px-1 font-mono text-xs">?</kbd> anywhere in the dashboard for this list.</p>
        </section>
      </div>
    </PageShell>
  );
}
