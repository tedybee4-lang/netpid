// IP pool range parsing + validation.
//
// A pool's `ranges` column is free text (e.g. "10.10.0.10-10.10.0.254"), so the
// only thing standing between an operator and an unusable pool is this parser.
// It accepts three shapes per entry, split on commas or newlines:
//
//   10.10.0.10-10.10.0.254   explicit start and end
//   10.10.0.0/24             CIDR block (expanded to its full range)
//   10.10.0.7                a single address
//
// Every rejection names the offending entry rather than failing wholesale, so a
// long list can be fixed in one pass.

export type ParsedRange = { start: number; end: number; label: string };

/** Dotted-quad → unsigned 32-bit, or null when it is not a real IPv4. */
export function ipToInt(ip: string): number | null {
  const parts = String(ip ?? "").trim().split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

export function intToIp(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

export function parseIpPoolRanges(input: string): { ranges: ParsedRange[]; errors: string[] } {
  const errors: string[] = [];
  const ranges: ParsedRange[] = [];

  const entries = String(input ?? "").split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  if (entries.length === 0) {
    errors.push("Enter at least one range, e.g. 10.10.0.10-10.10.0.254");
    return { ranges, errors };
  }

  for (const [i, raw] of entries.entries()) {
    const n = i + 1;

    if (raw.includes("-")) {
      const [a, b] = raw.split("-");
      const s = ipToInt(a ?? "");
      const e = ipToInt(b ?? "");
      if (s === null || e === null) {
        errors.push(`Entry ${n} "${raw}" is not a valid start-end pair.`);
        continue;
      }
      if (e < s) {
        errors.push(`Entry ${n} "${raw}" ends before it starts.`);
        continue;
      }
      ranges.push({ start: s, end: e, label: `${intToIp(s)}-${intToIp(e)}` });
      continue;
    }

    if (raw.includes("/")) {
      const [addr, bitsRaw] = raw.split("/");
      const base = ipToInt(addr ?? "");
      const bits = Number(bitsRaw);
      if (base === null) {
        errors.push(`Entry ${n} "${raw}" is not a valid CIDR block.`);
        continue;
      }
      if (!Number.isInteger(bits) || bits < 0 || bits > 32) {
        errors.push(`Entry ${n} "${raw}" has a prefix length outside 0-32.`);
        continue;
      }
      const size = 2 ** (32 - bits);
      const start = Math.floor(base / size) * size;
      ranges.push({ start, end: start + size - 1, label: `${intToIp(start)}/${bits}` });
      continue;
    }

    const single = ipToInt(raw);
    if (single === null) {
      errors.push(`Entry ${n} "${raw}" is not a valid IPv4 address.`);
      continue;
    }
    ranges.push({ start: single, end: single, label: intToIp(single) });
  }

  // Overlapping entries inside one pool would double-count capacity and confuse
  // any later allocation maths, so they are an error rather than a warning.
  const sorted = [...ranges].sort((x, y) => x.start - y.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start <= sorted[i - 1].end) {
      errors.push(`Entries "${sorted[i - 1].label}" and "${sorted[i].label}" overlap.`);
    }
  }

  return { ranges, errors };
}

/** Total addresses covered, for the capacity column. */
export function addressCount(ranges: ParsedRange[]): number {
  return ranges.reduce((sum, r) => sum + (r.end - r.start + 1), 0);
}

/** True when `candidate` shares any address with an already-parsed pool. */
export function overlapsAny(candidate: ParsedRange[], other: ParsedRange[]): ParsedRange | null {
  for (const c of candidate) {
    for (const o of other) {
      if (c.start <= o.end && o.start <= c.end) return o;
    }
  }
  return null;
}
