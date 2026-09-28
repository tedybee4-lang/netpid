"use client";
import { useState } from "react";
import { useParams } from "next/navigation";

export default function PortalVoucherPage() {
  const { slug } = useParams<{ slug: string | string[] }>();
  const s = Array.isArray(slug) ? slug[0] : slug;
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [creds, setCreds] = useState<{ username: string; password: string } | null>(null);

  async function redeem(e: React.FormEvent) {
    e.preventDefault(); setMsg("Redeeming…"); setCreds(null);
    const res = await fetch("/api/vouchers/redeem", {
      method: "PUT", headers: { "content-type": "application/json", "x-isp-slug": s ?? "" },
      body: JSON.stringify({ code }),
    });
    const j = await res.json();
    if (!res.ok) { setMsg(j.error ?? "Failed"); return; }
    setCreds({ username: j.username, password: j.password });
    setMsg(`Active until ${new Date(j.expiry).toLocaleString()}. Log in with these credentials.`);
  }

  return (
    <main className="mx-auto max-w-md px-4 py-10">
      <a className="text-sm text-indigo-600 hover:underline" href={`/portal/${s}`}>← Packages</a>
      <div className="card mt-3">
        <h1 className="text-2xl font-black">Use voucher</h1>
        <form onSubmit={redeem} className="mt-4 space-y-2">
          <input className="input" placeholder="VOUCHER CODE" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
          <button className="btn-primary w-full">Redeem</button>
        </form>
        {msg && <p className="mt-2 text-sm text-slate-600">{msg}</p>}
        {creds && <code className="mt-2 block rounded bg-slate-900 p-3 text-sm text-green-300">login: {creds.username}&#10;password: {creds.password}</code>}
      </div>
    </main>
  );
}
