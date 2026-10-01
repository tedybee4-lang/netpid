"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

// Super Admin console navigation. One list, so the shell and any future
// shortcut surface cannot drift apart.
const NAV: { href: string; label: string; icon: string }[] = [
  { href: "/admin", label: "Overview", icon: "grid" },
  { href: "/admin/servers", label: "VPS / Servers", icon: "server" },
  { href: "/admin/workers", label: "Network Workers", icon: "activity" },
  { href: "/admin/system-health", label: "System Health", icon: "pulse" },
  { href: "/admin/audit", label: "Audit Logs", icon: "clock" },
  { href: "/admin/announcements", label: "Announcements", icon: "megaphone" },
  { href: "/admin/billing", label: "Monthly Collections", icon: "receipt" },
  { href: "/admin/settings", label: "Settings", icon: "cog" },
];

const ICONS: Record<string, string> = {
  grid: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
  server: "M3 4h18v6H3zM3 14h18v6H3zM7 7h.01M7 17h.01M11 7h4M11 17h4",
  activity: "M3 12h4l3-7 4 14 3-7h4",
  pulse: "M2 12h4l3-8 6 16 3-8h4",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3.5 2",
  megaphone: "M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1zM16.5 9.5a4 4 0 0 1 0 5",
  receipt: "M6 2h12v20l-3-2-3 2-3-2-3 2V2zM9 7h6M9 11h6M9 15h3",
  cog: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M19.4 13.5l1.7 1-1.9 3.2-1.9-.7a7.6 7.6 0 0 1-2 .8l-.4 2h-3.8l-.4-2a7.6 7.6 0 0 1-2-.8l-1.9.7-1.9-3.2 1.7-1a7.7 7.7 0 0 1 0-2.3l-1.7-1 1.9-3.2 1.9.7a7.6 7.6 0 0 1 2-.8l.4-2h3.8l.4 2a7.6 7.6 0 0 1 2 .8l1.9-.7 1.9-3.2-1.7-1a7.7 7.7 0 0 1 0 2.3z",
};

function Icon({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}
      strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 shrink-0" aria-hidden="true">
      <path d={ICONS[name] ?? ICONS.grid} />
    </svg>
  );
}

/** The console rail. Desktop-only; on a phone the pages stack and the shell
 *  renders a wrapping row of the same links underneath the header. */
export default function AdminNav() {
  const pathname = usePathname() ?? "/admin";
  return (
    <nav className="flex flex-wrap gap-1" aria-label="Administration">
      {NAV.map((item) => {
        // "/admin" must not stay lit while on "/admin/servers".
        const active = pathname === item.href
          || (item.href !== "/admin" && pathname.startsWith(`${item.href}/`));
        return (
          <Link key={item.href} href={item.href}
            aria-current={active ? "page" : undefined}
            className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition ${
              active
                ? "bg-rose-600 text-white"
                : "text-slate-400 hover:bg-white/5 hover:text-slate-100"
            }`}>
            <Icon name={item.icon} />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
