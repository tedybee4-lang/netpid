import Link from "next/link";

/**
 * Shared page frame for the dashboard modules. Keeps every module on the same
 * spacing/title/description rhythm so a new group looks native without
 * re-inventing the header.
 */
export default function PageShell({
  title, description, children, action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight sm:text-3xl">{title}</h1>
          {description && <p className="mt-1 max-w-3xl text-sm text-slate-500">{description}</p>}
        </div>
        {action}
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

export function StatGrid({ items }: {
  items: { label: string; value: React.ReactNode; sub?: string }[];
}) {
  return (
    <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
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
