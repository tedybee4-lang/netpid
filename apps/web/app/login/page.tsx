"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setLoading(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      router.push("/dashboard");
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Router connection failed. Please retry.");
    } finally { setLoading(false); }
  }

  return (
    <main className="mx-auto max-w-md px-4 py-16">
      <div className="card">
        <h1 className="text-2xl font-extrabold">Sign in to NETPID</h1>
        <p className="mt-1 text-sm text-slate-500">ISP staff, resellers and platform admins.</p>
        <form onSubmit={onSubmit} className="mt-5 space-y-3">
          <div><label className="label" htmlFor="email">Email</label>
          <input id="email" className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          <div><label className="label" htmlFor="password">Password</label>
          <input id="password" className="input" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} /></div>
          {err && <p className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{err}</p>}
          <button className="btn-primary w-full" disabled={loading}>{loading ? "Signing in…" : "Sign in"}</button>
        </form>
        <div className="mt-4 flex justify-between text-sm">
          <Link className="text-indigo-600 hover:underline" href="/signup">Create account</Link>
          <Link className="text-indigo-600 hover:underline" href="/reset-password">Forgot password?</Link>
        </div>
        {/* Deliberately unobtrusive: the platform console is not part of the
            ISP product, so it gets a quiet link rather than a competing form.
            Operators are told about it; customers never go looking for it. */}
        <p className="mt-6 border-t border-slate-100 pt-4 text-center text-xs text-slate-400">
          <Link href="/admin-login" className="hover:text-slate-600">Platform administration</Link>
        </p>
      </div>
    </main>
  );
}
