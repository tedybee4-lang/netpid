import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SidebarNav, MobileNav, Icon } from "@/components/Sidebar";

// Auth is enforced here as well as in middleware: middleware keeps the session
// cookie fresh, but this server component is what guarantees an unauthenticated
// request never reaches a page body.
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: memberships } = await supabase
    .from("isp_users").select("isp_id, isps(name, slug)").eq("is_active", true).limit(1);
  const isp = (memberships?.[0]?.isps ?? null) as unknown as
    { name: string; slug: string } | null;

  return (
    <div className="flex min-h-screen">
      {/* Desktop sidebar. Hidden on small screens — the pages below are still
          fully usable without it, and a 240px rail on a phone costs too much. */}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col bg-slate-900 lg:flex">
        <div className="flex items-center gap-2.5 px-6 py-5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-indigo-600 text-sm font-black text-white">
            NP
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-bold text-white">NETPID</p>
            <p className="truncate text-xs text-slate-400">{isp?.name ?? "ISP Console"}</p>
          </div>
        </div>
        <SidebarNav />
        <div className="border-t border-white/10 px-6 py-4">
          <p className="truncate text-xs text-slate-400" title={user.email ?? ""}>
            {user.email}
          </p>
          <Link href="/dashboard/settings" className="mt-2 inline-flex items-center gap-2 text-xs
            font-semibold text-slate-300 hover:text-white">
            <Icon name="cog" className="h-4 w-4" /> Settings
          </Link>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile bar. The full nav is the same SidebarNav as the desktop rail,
            opened as a drawer — without it a phone could never reach Settings,
            Reports, Users, etc.

            Deliberately NOT backdrop-blur. A filter/backdrop-filter element
            becomes the containing block for position:fixed descendants, so a
            blurred header traps the `fixed inset-0` drawer inside its own 56px
            box and the hamburger appears dead. Solid costs nothing here: the
            drawer overlays this bar anyway. See MobileNav in components/Sidebar. */}
        <header className="sticky top-0 z-20 flex items-center justify-between gap-3
          border-b border-slate-200 bg-white px-4 py-3 lg:hidden">
          <span className="flex items-center gap-2 text-sm font-bold">
            <MobileNav />
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-indigo-600 text-xs
              font-black text-white">NP</span>
            {isp?.name ?? "NETPID"}
          </span>
          <Link href="/" className="text-xs font-semibold text-indigo-600">Home</Link>
        </header>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
