"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

export default function SignupPage() {
  const router = useRouter();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setLoading(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signUp({
        email, password, options: { data: { full_name: fullName } },
      });
      if (error) throw error;
      router.push("/onboarding");
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Signup failed. Please retry.");
    } finally { setLoading(false); }
  }

  return (
    <main className="mx-auto max-w-md px-4 py-16">
      <div className="card">
        <h1 className="text-2xl font-extrabold">Create your NETPID account</h1>
        <p className="mt-1 text-sm text-slate-500">Start a free trial, then create your ISP.</p>
        <form onSubmit={onSubmit} className="mt-5 space-y-3">
          <div><label className="label" htmlFor="name">Full name</label>
          <input id="name" className="input" required value={fullName} onChange={(e) => setFullName(e.target.value)} /></div>
          <div><label className="label" htmlFor="email">Email</label>
          <input id="email" className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          <div><label className="label" htmlFor="password">Password</label>
          <input id="password" className="input" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} /></div>
          {err && <p className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{err}</p>}
          <button className="btn-primary w-full" disabled={loading}>{loading ? "Creating…" : "Create account"}</button>
        </form>
        <p className="mt-4 text-sm">Have an account? <Link className="text-indigo-600 hover:underline" href="/login">Sign in</Link></p>
      </div>
    </main>
  );
}
