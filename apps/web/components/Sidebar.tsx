"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Dashboard navigation. One ordered list so the sidebar and any future
// "quick links" surface can never fall out of sync.
type Item = { href: string; label: string; icon: string };

export const NAV: { group: string; items: Item[] }[] = [
  {
    group: "Overview",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: "grid" },
      { href: "/dashboard/reports", label: "Reports", icon: "chart" },
    ],
  },
  {
    group: "Customers",
    items: [
      { href: "/dashboard/customers", label: "Customers", icon: "users" },
      { href: "/dashboard/packages", label: "Packages & speeds", icon: "box" },
      { href: "/dashboard/payments", label: "Payments", icon: "card" },
      { href: "/dashboard/vouchers", label: "Vouchers", icon: "ticket" },
      { href: "/dashboard/resellers", label: "Resellers", icon: "share" },
    ],
  },
  {
    group: "Network",
    items: [
      { href: "/dashboard/network", label: "Routers & sessions", icon: "router" },
      { href: "/dashboard/radius", label: "RADIUS", icon: "shield" },
      { href: "/dashboard/topology", label: "Topology", icon: "map" },
      { href: "/dashboard/tr069", label: "TR-069", icon: "device" },
      { href: "/dashboard/diagnostics", label: "Diagnostics", icon: "activity" },
    ],
  },
  {
    group: "Business",
    items: [
      { href: "/dashboard/sms", label: "SMS", icon: "message" },
      { href: "/dashboard/inventory", label: "Inventory", icon: "box" },
      { href: "/dashboard/expenses", label: "Expenses", icon: "receipt" },
    ],
  },
  {
    group: "Account",
    items: [{ href: "/dashboard/settings", label: "Settings", icon: "cog" }],
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
  return (
    <nav className="flex-1 space-y-1 overflow-y-auto px-3 pb-6">
      {NAV.map((section) => (
        <div key={section.group}>
          <p className="shell-heading">{section.group}</p>
          {section.items.map((item) => {
            // "/dashboard" must not stay lit while on "/dashboard/customers".
            const active = pathname === item.href
              || (item.href !== "/dashboard" && pathname.startsWith(`${item.href}/`));
            return (
              <Link key={item.href} href={item.href}
                className={`shell-link ${active ? "shell-link-active" : ""}`}
                aria-current={active ? "page" : undefined}>
                <Icon name={item.icon} />
                {item.label}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
