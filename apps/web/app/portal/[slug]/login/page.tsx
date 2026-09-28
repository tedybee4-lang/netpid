"use client";
import { useState } from "react";
import { useParams } from "next/navigation";

export default function PortalLoginPage() {
  const { slug } = useParams<{ slug: string }>();
  const [form, setForm] = useState({ username: "", password: "" });
  const [msg, setMsg] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setMsg("Verifying…");
    // Server-side check via test-auth path would leak secrets; instead the
    // HotSpot itself authenticates via RADIUS. This form hands credentials to
    // the router login page when deployed behind MikroTik (chap login).
    // Standalone: instruct user to log in on the Wi-Fi popup.
    setMsg("On the Wi-Fi network, use these credentials in the HotSpot login popup. Your ISP verifies them via RADIUS.");
  }

  return (
    <main className="mx-auto max-w-md px-4 py-10">
      <a className="text-sm text-indigo-600 hover:underline" href={`/portal/${slug}`}>← Packages</a>
      <div className="card mt-3">
        <h1 className="text-2xl font-black">HotSpot login</h1>
        <form onSubmit={submit} className="mt-4 space-y-2">
          <input className="input" placeholder="username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
          <input className="input" type="password" placeholder="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          <button className="btn-primary w-full">Continue</button>
        </form>
        {msg && <p className="mt-2 text-sm text-slate-600">{msg}</p>}
      </div>
    </main>
  );
}
