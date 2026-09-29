import Link from "next/link";
import { redirect } from "next/navigation";
import { isAdmin, clearAdminSession } from "@/lib/admin-auth";
import AdminNav from "@/app/admin/AdminNav";

export const dynamic = "force-dynamic";

// Shared shell for every Super Admin page. The auth check lives here so a new
// page is protected by default — forgetting a guard is then not possible.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  if (!(await isAdmin())) redirect("/admin-login");

  async function signOut() {
    "use server";
    await clearAdminSession();
    redirect("/admin-login");
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      {/* Solid, not backdrop-blur. A filter/backdrop-filter element becomes the
          containing block for position:fixed descendants, which silently breaks
          any overlay rendered inside it. Nothing scrolls under this bar. */}
      <header className="sticky top-0 z-20 border-b border-white/10 bg-slate-950">
        <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2.5">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-rose-600 text-sm font-black text-white">
              NA
            </span>
            <div>
              <p className="text-sm font-bold">NETPID Administration</p>
              <p className="text-xs text-slate-400">Platform console · every action is logged</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/dashboard" className="hidden text-xs font-semibold text-slate-400 hover:text-slate-200 sm:inline">
              ISP dashboard
            </Link>
            <form action={signOut}>
              <button type="submit" className="rounded-lg border border-white/15 px-3 py-1.5 text-xs font-semibold text-slate-300 transition hover:bg-white/5">
                Sign out
              </button>
            </form>
          </div>
        </div>
        <div className="mx-auto max-w-[1400px] border-t border-white/5 px-4 py-2 sm:px-6">
          <AdminNav />
        </div>
      </header>

      <div className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6">{children}</div>
    </div>
  );
}
