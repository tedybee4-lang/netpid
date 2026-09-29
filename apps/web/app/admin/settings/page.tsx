import { redirect } from "next/navigation";
import { isAdmin } from "@/lib/admin-auth";
import { createServiceClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// Super Admin → Settings. Reports which server-side secrets are CONFIGURED,
// never their values. This exists so a missing env var is diagnosable from the
// console instead of only from a stack trace.
function Flag({ name, configured, hint }: { name: string; configured: boolean; hint: string }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-white/10 bg-white/5 p-4">
      <div className="min-w-0">
        <p className="font-mono text-sm font-semibold text-slate-200">{name}</p>
        <p className="mt-1 text-xs text-slate-500">{hint}</p>
      </div>
      <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold uppercase ${
        configured ? "bg-emerald-500/15 text-emerald-300" : "bg-rose-500/15 text-rose-300"}`}>
        {configured ? "configured" : "missing"}
      </span>
    </div>
  );
}

export default async function AdminSettingsPage() {
  if (!(await isAdmin())) redirect("/admin-login");
  const svc = createServiceClient();

  const [{ count: serverCount }, { count: ispCount }] = await Promise.all([
    svc.from("vps_servers").select("id", { count: "exact", head: true }),
    svc.from("isps").select("id", { count: "exact", head: true }),
  ]);

  // Presence only. The value is never read into the response, so it cannot be
  // leaked by this page even by accident.
  const flags = [
    {
      name: "APP_ENCRYPTION_KEY",
      configured: Boolean(process.env.APP_ENCRYPTION_KEY)
        && Buffer.from(process.env.APP_ENCRYPTION_KEY ?? "", "base64").length === 32,
      hint: "AES-256-GCM key for router and server credentials. Must decode to exactly 32 bytes and must be byte-identical to the value on the worker.",
    },
    {
      name: "WORKER_HEARTBEAT_SECRET",
      configured: Boolean(process.env.WORKER_HEARTBEAT_SECRET),
      hint: "Shared secret the worker presents in x-netpid-heartbeat. Without it the heartbeat endpoint returns 503 and no server is ever marked online.",
    },
    {
      name: "ADMIN_SESSION_SECRET",
      configured: Boolean(process.env.ADMIN_SESSION_SECRET),
      hint: "Signs the console session cookie. Falling back to a built-in dev value is acceptable for local work only.",
    },
    {
      name: "SUPABASE_SERVICE_ROLE_KEY",
      configured: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
      hint: "Server-only. Bypasses RLS, which is why every admin route checks isAdmin() itself.",
    },
  ];

  return (
    <>
      <h1 className="text-2xl font-black tracking-tight sm:text-3xl">Settings</h1>
      <p className="mt-1 max-w-2xl text-sm text-slate-400">
        Platform configuration. Environment values are shown as present or missing — never printed.
      </p>

      <section className="mt-6 rounded-2xl border border-white/10 bg-slate-900 p-5">
        <h2 className="text-sm font-bold uppercase tracking-wide text-slate-400">Server environment</h2>
        <div className="mt-4 space-y-3">
          {flags.map((f) => <Flag key={f.name} {...f} />)}
        </div>
      </section>

      <section className="mt-6 rounded-2xl border border-white/10 bg-slate-900 p-5">
        <h2 className="text-sm font-bold uppercase tracking-wide text-slate-400">Platform</h2>
        <dl className="mt-4 grid gap-4 sm:grid-cols-3">
          {[
            ["ISPs on the platform", serverCount === null ? "—" : (ispCount ?? 0)],
            ["Servers registered", serverCount ?? 0],
            ["Super Admins", "1 (fixed credential)"],
          ].map(([k, v]) => (
            <div key={k} className="rounded-xl border border-white/5 bg-white/5 p-4">
              <dt className="text-xs font-bold uppercase tracking-wide text-slate-500">{k}</dt>
              <dd className="mt-1 text-2xl font-extrabold">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 text-xs text-slate-500">
          The console authenticates against one fixed credential rather than an invited admin
          account, so it remains reachable when Supabase is not. Each sign-in is written to the
          audit log.
        </p>
      </section>
    </>
  );
}
