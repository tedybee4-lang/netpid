import { createClient } from "@/lib/supabase/server";
import Link from "next/link";

// Announcements an ISP operator can read.
//
// RLS already does the important half: `ann_read` serves a row only when
// `published = true` (or the caller is a platform admin), so drafts cannot leak
// into this page by accident. The `audience` filter is applied here because the
// policy does not encode it — an ISP operator is shown `isps` and `all`, never
// `platform`-only notices aimed at the NETPID console itself.

export const dynamic = "force-dynamic";

export default async function AnnouncementsPage() {
  const supabase = await createClient();

  const { data, error } = await supabase.from("announcements")
    .select("id, title, body, audience, published_at, created_at")
    .eq("published", true)
    .in("audience", ["isps", "all"])
    .order("published_at", { ascending: false })
    .limit(100);

  const rows = data ?? [];

  return (
    <main className="mx-auto max-w-4xl px-4 py-6 sm:px-6 lg:px-8">
      <header>
        <h1 className="text-2xl font-black tracking-tight sm:text-3xl">Announcements</h1>
        <p className="mt-1 text-sm text-slate-500">
          Service notices and product updates from NETPID.
        </p>
      </header>

      {error && (
        <div className="card mt-6 border-red-200 bg-red-50" role="alert">
          <p className="font-semibold text-red-800">Could not load announcements</p>
          <p className="mt-1 text-sm text-red-700">{error.message}</p>
          <Link href="/dashboard/announcements" className="btn-ghost mt-3">Try again</Link>
        </div>
      )}

      {!error && rows.length === 0 ? (
        <div className="card mt-6 text-sm text-slate-500">
          <p className="font-semibold text-slate-700">Nothing to read right now.</p>
          <p className="mt-1">
            Announcements appear here as soon as NETPID publishes one — no email needed,
            just check back after a maintenance window.
          </p>
        </div>
      ) : (
        <ul className="mt-6 space-y-3">
          {rows.map((a) => (
            <li key={a.id} className="card">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-bold text-slate-900">{a.title}</h2>
                {a.audience === "all" && (
                  <span className="badge bg-indigo-50 text-indigo-700">everyone</span>
                )}
              </div>
              <p className="mt-1 text-xs text-slate-500">
                {a.published_at ? new Date(a.published_at).toLocaleString() : "—"}
              </p>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{a.body}</p>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
