"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

// Deliberately NOT the /login page. This is a separate credential path with a
// separate session, so it is styled apart as well: dark, no sign-up links, and
// no "forgot password" — there is no email on this account to reset.
export default function AdminLoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setLoading(true);
    try {
      const r = await fetch("/api/admin-auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? "Sign-in failed");
      router.push("/admin");
      router.refresh();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Sign-in failed. Please retry.");
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-rose-600 text-lg font-black text-white">
            NA
          </div>
          <h1 className="mt-4 text-2xl font-black tracking-tight text-white">
            NETPID Administration
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Restricted. All access is logged.
          </p>
        </div>

        <div className="rounded-2xl border border-white/10 bg-slate-900 p-6 shadow-2xl">
          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400" htmlFor="u">
                Username
              </label>
              <input
                id="u" className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2.5
                  text-sm text-white outline-none transition placeholder:text-slate-600
                  focus:border-rose-500 focus:ring-4 focus:ring-rose-500/20"
                autoComplete="username" autoCapitalize="characters" spellCheck={false}
                value={username} onChange={(e) => setUsername(e.target.value)}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400" htmlFor="p">
                Password
              </label>
              <input
                id="p" type="password" className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2.5
                  text-sm text-white outline-none transition placeholder:text-slate-600
                  focus:border-rose-500 focus:ring-4 focus:ring-rose-500/20"
                autoComplete="current-password" value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {err && (
              <p className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">
                {err}
              </p>
            )}
            <button
              type="submit" disabled={loading}
              className="w-full rounded-xl bg-rose-600 px-4 py-2.5 text-sm font-semibold text-white
                shadow-sm transition hover:bg-rose-700 focus:outline-none focus-visible:ring-2
                focus-visible:ring-rose-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900
                disabled:opacity-50"
            >
              {loading ? "Verifying…" : "Enter console"}
            </button>
          </form>
        </div>

        <p className="mt-6 text-center text-xs text-slate-500">
          <Link href="/login" className="hover:text-slate-300">← Back to ISP sign-in</Link>
        </p>
      </div>
    </main>
  );
}
