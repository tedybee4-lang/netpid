"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

// Dashboard navigation. One ordered list so the sidebar and any future
// "quick links" surface can never fall out of sync.
type Item = { href: string; label: string; icon: string };

export const NAV: { group: string; items: Item[] }[] = [
  {
    group: "Overview",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: "grid" },
      { href: "/dashboard/favorites", label: "Favorites", icon: "star" },
      { href: "/dashboard/notifications", label: "Notifications", icon: "bell" },
    ],
  },
  {
    group: "Customers",
    items: [
      { href: "/dashboard/customers", label: "Customers", icon: "users" },
      { href: "/dashboard/activation", label: "Activation", icon: "zap" },
      { href: "/dashboard/data-usage", label: "Data usage", icon: "chart" },
      { href: "/dashboard/vouchers", label: "HotSpot vouchers", icon: "ticket" },
      { href: "/dashboard/hotspot-binding", label: "HotSpot binding", icon: "link" },
      { href: "/dashboard/packages", label: "Packages / plans", icon: "box" },
      { href: "/dashboard/payments", label: "Transactions", icon: "card" },
      { href: "/dashboard/loyalty", label: "Loyalty points", icon: "gift" },
    ],
  },
  {
    group: "Network",
    items: [
      { href: "/dashboard/network", label: "Network", icon: "router" },
      { href: "/dashboard/topology", label: "Topology", icon: "map" },
      { href: "/dashboard/tr069", label: "TR-069 ACS", icon: "device" },
      { href: "/dashboard/access-points", label: "Access points", icon: "wifi" },
      { href: "/dashboard/access/pppoe", label: "Access PPPoE routers", icon: "cog" },
      { href: "/dashboard/access/hotspot", label: "Access HotSpot APs", icon: "wifi" },
      { href: "/dashboard/radius", label: "RADIUS", icon: "shield" },
      { href: "/dashboard/diagnostics", label: "AI assistant", icon: "activity" },
    ],
  },
  {
    group: "Operations",
    items: [
      { href: "/dashboard/bulk-actions", label: "Bulk actions", icon: "list" },
      { href: "/dashboard/page-builder", label: "Static pages", icon: "page" },
      { href: "/dashboard/inventory", label: "Inventory & expenses", icon: "box" },
      { href: "/dashboard/resellers", label: "Resellers", icon: "share" },
      { href: "/dashboard/sms", label: "SMS", icon: "message" },
      { href: "/dashboard/support", label: "Support tickets", icon: "mail" },
      { href: "/dashboard/logs", label: "Logs", icon: "clock" },
      { href: "/dashboard/reports", label: "Reports", icon: "chart" },
    ],
  },
  {
    group: "Tools",
    items: [
      { href: "/dashboard/health/hotspot", label: "Fix HotSpot", icon: "wrench" },
      { href: "/dashboard/health/pppoe", label: "Fix PPPoE", icon: "wrench" },
      { href: "/dashboard/extras", label: "Extras", icon: "sparkle" },
      { href: "/dashboard/integrations/uisp", label: "UISP", icon: "plug" },
      { href: "/dashboard/social-spot", label: "Social Spot / support", icon: "chat" },
      { href: "/dashboard/escalate", label: "Escalate", icon: "alert" },
      { href: "/dashboard/recycle-bin", label: "Recycle bin", icon: "trash" },
    ],
  },
  {
    group: "Settings",
    items: [
      { href: "/dashboard/settings", label: "Settings", icon: "cog" },
      { href: "/dashboard/settings/pppoe", label: "PPPoE settings", icon: "cog" },
      { href: "/dashboard/settings/hotspot", label: "HotSpot settings", icon: "cog" },
      { href: "/dashboard/page-builder", label: "Page builder", icon: "page" },
      { href: "/dashboard/users", label: "Users & roles", icon: "team" },
    ],
  },
];

// Single-path icons keep the sidebar tiny; anything more decorative is not
// worth a 2kB inline sprite on every page.
const ICONS: Record<string, string> = {
  grid: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
  chart: "M4 20V5M4 20h16M8 16l3.5-5 3 3L20 7",
  users: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M2.5 20a6.5 6.5 0 0 1 13 0M17 11a3 3 0 1 0 0-6M18 20a6 6 0 0 0-2-4.5",
  box: "M12 3l8 4v10l-8 4-8-4V7zM4 7l8 4 8-4M12 11v10",
  card: "M3 6h18v12H3zM3 10h18M6.5 14.5h3",
  ticket: "M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4zM14 6v12",
  share: "M18 5.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0M7 12a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0M18 21a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0M9.5 10.5l4-2.5M9.5 13.5l4 2.5",
  router: "M3 14h18v6H3zM6.5 17h.01M10 17h.01M13.5 17h.01M12 14V9M8 6.2a5.5 5.5 0 0 1 8 0M10.4 8.8a2.8 2.8 0 0 1 3.2 0",
  shield: "M12 3l7.5 3v5.5c0 4.6-3.1 8.4-7.5 9.5-4.4-1.1-7.5-4.9-7.5-9.5V6zM9 12l2 2 4-4",
  map: "M9 4L3 6.5v13L9 17l6 2.5 6-2.5v-13L15 6.5zM9 4v13M15 6.5v13",
  device: "M4 4h16v12H4zM9 20h6M12 16v4",
  activity: "M3 12h4l3-7 4 14 3-7h4",
  message: "M20 15a2 2 0 0 1-2 2H8l-4 3V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z",
  receipt: "M6 3h12v18l-3-2-3 2-3-2-3 2zM9.5 8h5M9.5 12h5",
  cog: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M19.4 13.5l1.7 1-1.9 3.2-1.9-.7a7.6 7.6 0 0 1-2 .8l-.4 2h-3.8l-.4-2a7.6 7.6 0 0 1-2-.8l-1.9.7-1.9-3.2 1.7-1a7.7 7.7 0 0 1 0-2.3l-1.7-1 1.9-3.2 1.9.7a7.6 7.6 0 0 1 2-.8l.4-2h3.8l.4 2a7.6 7.6 0 0 1 2 .8l1.9-.7 1.9 3.2-1.7 1a7.7 7.7 0 0 1 0 2.3z",
  team: "M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  page: "M6 3h9l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM14 3v6h5M8 13h8M8 17h6",
  star: "M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8L3.5 9.7l5.9-.9z",
  bell: "M18 15V10a6 6 0 1 0-12 0v5l-2 3h16zM10.5 21a1.8 1.8 0 0 0 3 0",
  zap: "M13 2L4.5 13.5H11L10 22l8.5-11.5H12z",
  link: "M9.5 14.5l5-5M8 11l-2 2a3.5 3.5 0 0 0 5 5l2-2M16 13l2-2a3.5 3.5 0 0 0-5-5l-2 2",
  gift: "M3 11h18v9H3zM3 8h18v3H3zM12 8v12M12 8S9.5 3 7.5 4.5 9 8 12 8zM12 8s2.5-5 4.5-3.5S15 8 12 8z",
  wifi: "M2.5 9a15 15 0 0 1 19 0M5.5 12.5a10.5 10.5 0 0 1 13 0M8.5 16a6 6 0 0 1 7 0M12 19.5h.01",
  list: "M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01",
  wrench: "M20 6.5a5 5 0 0 1-6.6 4.7L6 18.6a2 2 0 0 1-2.8-2.8l7.4-7.4A5 5 0 0 1 17.5 3z",
  sparkle: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z",
  plug: "M9 3v6M15 3v6M6 9h12v3a6 6 0 0 1-12 0zM12 18v3",
  chat: "M4 5h16v11H9l-5 4zM8 9h8M8 12h5",
  alert: "M12 4l9 16H3zM12 10v4M12 17h.01",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3.5 2",
  mail: "M3 6h18v12H3zM3 7l9 6 9-6",
};

export function Icon({ name, className = "h-5 w-5" }: { name: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d={ICONS[name] ?? ICONS.grid} />
    </svg>
  );
}

export function SidebarNav() {
  const pathname = usePathname() ?? "/dashboard";
  const [q, setQ] = useState("");
  const term = q.trim().toLowerCase();
  // A flat, de-duplicated list: the same page appears under two groups
  // (Page builder is both "Static pages" and "Page builder"), and searching
  // must not offer it twice.
  const flat = Array.from(
    NAV.reduce((acc, section) => {
      for (const item of section.items) if (!acc.has(item.href)) acc.set(item.href, item);
      return acc;
    }, new Map<string, Item>()).values(),
  );
  const results = term ? flat.filter((i) => i.label.toLowerCase().includes(term)) : [];

  return (
    <nav className="flex-1 space-y-1 overflow-y-auto px-3 pb-6">
      <div className="relative pb-2 pt-3">
        <Icon name="grid" className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search menu…"
          aria-label="Search menu"
          className="w-full rounded-lg border border-white/10 bg-white/5 py-2 pl-8 pr-2 text-sm text-slate-200 placeholder:text-slate-500 outline-none transition focus:border-indigo-500 focus:bg-white/10"
        />
      </div>
      {term ? (
        <div className="space-y-1">
          <p className="shell-heading pt-2">{results.length} result{results.length === 1 ? "" : "s"}</p>
          {results.map((item) => (
            <Link key={item.href} href={item.href} onClick={() => setQ("")}
              className="shell-link" aria-current={pathname === item.href ? "page" : undefined}>
              <Icon name={item.icon} className="h-4 w-4" />
              {item.label}
            </Link>
          ))}
          {!results.length && (
            <p className="px-3 py-2 text-xs text-slate-500">No menu item matches “{q}”.</p>
          )}
        </div>
      ) : (
        <>
      {NAV.map((section) => (
        <div key={section.group}>
          <p className="shell-heading">{section.group}</p>
          {section.items.map((item) => {
            // "/dashboard" must not stay lit while on "/dashboard/customers".
            const active = pathname === item.href
              || (item.href !== "/dashboard" && pathname.startsWith(`${item.href}/`));
            return (
              <Link key={`${section.group}-${item.href}`} href={item.href}
                className={`shell-link ${active ? "shell-link-active" : ""}`}
                aria-current={active ? "page" : undefined}>
                <Icon name={item.icon} className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </div>
      ))}
        </>
      )}
    </nav>
  );
}

// Small-screen navigation. The desktop sidebar is hidden below `lg`, so without
// this drawer a phone would only ever see whatever page it landed on. One
// toggle button in the mobile header opens the same SidebarNav as an overlay.
export function MobileNav() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname() ?? "/dashboard";

  // Follow the user to the target page, then close — the drawer is navigation,
  // not a persistent panel.
  useEffect(() => { setOpen(false); }, [pathname]);
  // Don't let the page scroll behind the overlay.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}
        aria-label="Open navigation" aria-expanded={open}
        className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-50">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
          strokeLinecap="round" className="h-5 w-5" aria-hidden="true">
          <path d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-slate-950/50"
            onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-slate-900 shadow-2xl">
            <div className="flex items-center justify-between px-6 py-5">
              <span className="flex items-center gap-2.5">
                <span className="grid h-9 w-9 place-items-center rounded-xl bg-indigo-600 text-sm font-black text-white">
                  NP
                </span>
                <span className="text-sm font-bold text-white">NETPID</span>
              </span>
              <button type="button" onClick={() => setOpen(false)}
                aria-label="Close navigation"
                className="grid h-9 w-9 place-items-center rounded-lg text-slate-300 transition hover:bg-white/10 hover:text-white">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
                  strokeLinecap="round" className="h-5 w-5" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
            <SidebarNav />
          </div>
        </div>
      )}
    </>
  );
}
