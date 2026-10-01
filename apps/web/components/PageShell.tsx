import Link from "next/link";

/**
 * Shared page frame for the dashboard modules. Keeps every module on the same
 * spacing/title/description rhythm so a new group looks native without
 * re-inventing the header.
 *
 * Breadcrumbs are optional but part of the frame: a phone user arriving deep on
 * /dashboard/settings/mpesa otherwise has no idea where they are, because the
 * sidebar is a hidden drawer at that width.
 */
export default function PageShell({
  title, description, children, action, breadcrumb,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  breadcrumb?: { href: string; label: string }[];
  children: React.ReactNode;
}) {
  return (
    <main className="mx-auto max-w-[1400px] px-4 py-5 sm:px-6 lg:px-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {breadcrumb && breadcrumb.length > 0 && (
            <nav aria-label="Breadcrumb" className="mb-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
              {breadcrumb.map((c, i) => (
                <span key={c.href} className="flex items-center gap-1.5">
                  {i > 0 && <span aria-hidden="true" className="text-slate-300">/</span>}
                  <Link href={c.href} className="font-medium hover:text-indigo-600 hover:underline">
                    {c.label}
                  </Link>
                </span>
              ))}
            </nav>
          )}
          <h1 className="text-xl font-extrabold tracking-tight text-slate-900 sm:text-2xl">{title}</h1>
          {description && <p className="mt-1 max-w-3xl text-sm text-slate-500">{description}</p>}
        </div>
        {action && <div className="flex shrink-0 flex-wrap gap-2">{action}</div>}
      </header>
      <div className="mt-4">{children}</div>
    </main>
  );
}

/** Table wrapper that scrolls instead of overflowing on a phone. */
export function Table({ head, children, minWidth = 720 }: {
  head: string[]; children: React.ReactNode; minWidth?: number;
}) {
  return (
    <div className="card-flush overflow-x-auto">
      <table className="table" style={{ minWidth }}>
        <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-5 py-8 text-center text-sm text-slate-400">{children}</p>;
}

/**
 * Metric tile.
 *
 * Promoted out of app/dashboard/page.tsx, which had its own private copy of this
 * exact component. Two implementations of "a number with a label" is how the
 * dashboard and the rest of the product drift apart visually.
 *
 * The `tone` accent is a 4px top rule rather than a coloured fill: a row of
 * eight of these reads as a status board at a glance, while a tinted background
 * turns the page into a wall of colour.
 */
export function Metric({
  label, value, sub, tone = "default", href,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: "default" | "ok" | "warn" | "bad" | "brand";
  href?: string;
}) {
  const accents: Record<string, string> = {
    default: "before:bg-slate-300", ok: "before:bg-emerald-500",
    warn: "before:bg-amber-500", bad: "before:bg-red-500", brand: "before:bg-indigo-500",
  };
  const body = (
    <div className={`stat before:absolute before:inset-x-4 before:top-0 before:h-1 before:rounded-full ${accents[tone]}`}>
      <p className="stat-label">{label}</p>
      <p className="stat-value">{value}</p>
      {sub && <p className="stat-sub">{sub}</p>}
    </div>
  );
  return href
    ? <Link href={href} className="block transition hover:-translate-y-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded-xl">{body}</Link>
    : body;
}

/** Stat grid used across the dashboard modules. */
export function StatGrid({ items, columns = 4 }: {
  items: { label: string; value: React.ReactNode; sub?: React.ReactNode }[];
  columns?: 2 | 3 | 4;
}) {
  const cols = { 2: "sm:grid-cols-2", 3: "sm:grid-cols-3", 4: "sm:grid-cols-2 xl:grid-cols-4" }[columns];
  return (
    <div className={`mb-4 grid gap-3 ${cols}`}>
      {items.map((s) => (
        <div key={s.label} className="stat">
          <p className="stat-label">{s.label}</p>
          <p className="stat-value">{s.value}</p>
          {s.sub && <p className="stat-sub">{s.sub}</p>}
        </div>
      ))}
    </div>
  );
}

/** Back link used by the sub-pages so a thumb can always get out. */
export function Back({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="text-sm font-semibold text-indigo-600 hover:underline">
      ← {label}
    </Link>
  );
}

export function fmtDate(v: string | null | undefined): string {
  if (!v) return "—";
  return new Date(v).toLocaleDateString("en-KE", { day: "2-digit", month: "short", year: "numeric" });
}
export function fmtDateTime(v: string | null | undefined): string {
  if (!v) return "—";
  return new Date(v).toLocaleString("en-KE", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
  });
}
export function mb(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  const mbv = bytes / 1048576;
  if (mbv >= 1024) return `${(mbv / 1024).toFixed(2)} GB`;
  return `${mbv.toFixed(1)} MB`;
}
