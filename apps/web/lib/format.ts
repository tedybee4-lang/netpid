// Presentation-only formatting. Nothing here decides a number's meaning —
// speeds and money are converted in exactly one place each so a package card,
// a customer page and a RADIUS attribute can never disagree.

/** Bytes -> human string. Upload and download are always labelled separately. */
export function bytes(n: number | null | undefined, digits = 1): string {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v) || v <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(v) / Math.log(1024)));
  return `${(v / 1024 ** i).toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}

/** Kilobits per second -> "20 Mbps". Pass 0/null for "unlimited". */
export function mbps(kbps: number | null | undefined): string {
  const v = Number(kbps ?? 0);
  if (!Number.isFinite(v) || v <= 0) return "Unlimited";
  if (v >= 1000) {
    const g = v / 1000;
    return `${Number.isInteger(g) ? g : g.toFixed(1)} Gbps`;
  }
  return `${v % 1 === 0 ? v : v.toFixed(1)} Mbps`;
}

/**
 * Speed pair for display. Download is always listed FIRST because that is the
 * number customers care about, but the values themselves are never swapped —
 * that ordering is a display choice, not a data one.
 */
export function speedPair(
  downloadKbps: number | null | undefined,
  uploadKbps: number | null | undefined,
): string {
  return `${mbps(downloadKbps)} ↓ · ${mbps(uploadKbps)} ↑`;
}

export function kes(minor: number | null | undefined): string {
  if (minor == null) return "—";
  return `KSh ${(minor / 100).toLocaleString("en-KE", { maximumFractionDigits: 2 })}`;
}

export function num(n: number | null | undefined): string {
  return Number(n ?? 0).toLocaleString("en-KE");
}

export function pct(part: number, total: number): string {
  if (!total) return "0%";
  return `${Math.round((part / total) * 100)}%`;
}

export function duration(seconds: number | null | undefined): string {
  const s = Math.max(0, Math.floor(Number(seconds ?? 0)));
  if (!s) return "—";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "never";
  const diff = Date.now() - t;
  if (diff < 0) return "just now";
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function dateOnly(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString() : "—";
}

const STATUS_TONE: Record<string, string> = {
  online: "badge-ok", synced: "badge-ok", active: "badge-ok", completed: "badge-ok",
  paid: "badge-ok", matched: "badge-ok",
  offline: "badge-bad", failed: "badge-bad", error: "badge-bad", suspended: "badge-bad",
  blocked: "badge-bad", terminated: "badge-bad", overdue: "badge-bad", mismatch: "badge-bad",
  degraded: "badge-warn", pending: "badge-warn", retrying: "badge-warn", expiring: "badge-warn",
  open: "badge-warn", refunded: "badge-warn",
  unknown: "badge-mute", disabled: "badge-mute", draft: "badge-mute",
  void: "badge-mute", cancelled: "badge-mute",
};

export function statusTone(status: string | null | undefined): string {
  return STATUS_TONE[String(status ?? "unknown").toLowerCase()] ?? "badge-mute";
}
