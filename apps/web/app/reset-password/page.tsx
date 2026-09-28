"use client";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export default function ResetPasswordPage() {
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const supabase = createClient();
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/login`,
    });
    setMsg(error ? error.message : "If an account exists, a reset link was sent.");
  }

  return (
    <main className="mx-auto max-w-md px-4 py-16">
      <div className="card">
        <h1 className="text-2xl font-extrabold">Reset password</h1>
        <form onSubmit={onSubmit} className="mt-5 space-y-3">
          <div><label className="label" htmlFor="email">Email</label>
          <input id="email" className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          <button className="btn-primary w-full">Send reset link</button>
          {msg && <p className="text-sm text-slate-600">{msg}</p>}
        </form>
      </div>
    </main>
  );
}
