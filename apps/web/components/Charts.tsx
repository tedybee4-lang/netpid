// Charts are hand-rolled SVG on purpose.
//
// The dashboard needs four shapes and nothing more; pulling in a charting
// library would add ~100kB to a server-rendered page and a client bundle that
// is otherwise static. These are server components: zero JS shipped, and every
// mark keeps a <title> so a screen reader gets the number.

export type Point = { label: string; value: number };

const AXIS = "#cbd5e1";
const GRID = "#e2e8f0";

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  const n = v / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

function Empty({ height, message }: { height: number; message: string }) {
  return (
    <div
      className="flex items-center justify-center rounded-xl border border-dashed border-slate-200 text-sm text-slate-400"
      style={{ height }}
    >
      {message}
    </div>
  );
}

/** Vertical bars — monthly revenue, monthly signups. */
export function BarChart({
  data,
  height = 200,
  color = "#4f46e5",
  format = (v: number) => String(v),
  empty = "No data yet.",
}: {
  data: Point[];
  height?: number;
  color?: string;
  format?: (v: number) => string;
  empty?: string;
}) {
  if (!data.length || data.every((d) => !d.value)) return <Empty height={height} message={empty} />;

  const W = 640;
  const padL = 8;
  const padB = 26;
  const padT = 12;
  const plotH = height - padB - padT;
  const max = niceMax(Math.max(...data.map((d) => d.value)));
  const slot = (W - padL * 2) / data.length;
  const barW = Math.max(6, Math.min(38, slot * 0.6));

  return (
    <svg viewBox={`0 0 ${W} ${height}`} className="w-full" role="img"
      aria-label={`Bar chart of ${data.length} periods, peak ${format(max)}`}>
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <line key={f} x1={padL} x2={W - padL} y1={padT + plotH * (1 - f)} y2={padT + plotH * (1 - f)}
          stroke={GRID} strokeWidth={1} />
      ))}
      <line x1={padL} x2={W - padL} y1={padT + plotH} y2={padT + plotH} stroke={AXIS} strokeWidth={1} />
      {data.map((d, i) => {
        const h = max ? (d.value / max) * plotH : 0;
        const x = padL + slot * i + (slot - barW) / 2;
        return (
          <g key={d.label + i}>
            <rect x={x} y={padT + plotH - h} width={barW} height={Math.max(h, d.value > 0 ? 2 : 0)}
              rx={4} fill={color} opacity={d.value ? 1 : 0.25}>
              <title>{`${d.label}: ${format(d.value)}`}</title>
            </rect>
            <text x={x + barW / 2} y={height - 8} textAnchor="middle" fontSize={11} fill={AXIS}>
              {d.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** Smoothed area + line — growth trends. */
export function AreaChart({
  data,
  height = 200,
  color = "#0ea5e9",
  format = (v: number) => String(v),
  empty = "No data yet.",
}: {
  data: Point[];
  height?: number;
  color?: string;
  format?: (v: number) => string;
  empty?: string;
}) {
  if (!data.length || data.every((d) => !d.value)) return <Empty height={height} message={empty} />;

  const W = 640;
  const padB = 26;
  const padT = 14;
  const padX = 10;
  const plotH = height - padB - padT;
  const max = niceMax(Math.max(...data.map((d) => d.value)));
  const step = (W - padX * 2) / Math.max(1, data.length - 1);
  const pts = data.map((d, i) => {
    const x = padX + step * i;
    const y = padT + plotH - (max ? (d.value / max) * plotH : 0);
    return [x, y] as const;
  });
  // Horizontal-tangent cubics: smooth without the overshoot a naive
  // Catmull-Rom spline produces when two adjacent points are both near zero.
  const path = pts.reduce((acc, [x, y], i) => {
    if (i === 0) return `M ${x} ${y}`;
    const [px, py] = pts[i - 1];
    const cx = (px + x) / 2;
    return `${acc} C ${cx} ${py} ${cx} ${y} ${x} ${y}`;
  }, "");
  const area = `${path} L ${pts[pts.length - 1][0]} ${padT + plotH} L ${pts[0][0]} ${padT + plotH} Z`;
  const gid = `netpid-grad-${color.replace(/[^a-z0-9]/gi, "")}`;

  return (
    <svg viewBox={`0 0 ${W} ${height}`} className="w-full" role="img"
      aria-label={`Trend over ${data.length} periods, peak ${format(max)}`}>
      <defs>
        <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.28} />
          <stop offset="100%" stopColor={color} stopOpacity={0.02} />
        </linearGradient>
      </defs>
      <line x1={padX} x2={W - padX} y1={padT + plotH} y2={padT + plotH} stroke={AXIS} strokeWidth={1} />
      <path d={area} fill={`url(#${gid})`} />
      <path d={path} fill="none" stroke={color} strokeWidth={2.5} strokeLinecap="round" />
      {pts.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={3.5} fill="#fff" stroke={color} strokeWidth={2}>
          <title>{`${data[i].label}: ${format(data[i].value)}`}</title>
        </circle>
      ))}
      {data.map((d, i) => (
        <text key={d.label + i} x={padX + step * i} y={height - 8} textAnchor="middle"
          fontSize={11} fill={AXIS}>
          {d.label}
        </text>
      ))}
    </svg>
  );
}

/** Donut — customer status split, upload vs download share. */
export function Donut({
  data,
  size = 180,
  centerLabel,
  centerValue,
  empty = "No data yet.",
}: {
  data: Point[];
  size?: number;
  centerLabel?: string;
  centerValue?: string;
  empty?: string;
}) {
  const total = data.reduce((a, d) => a + Math.max(0, d.value), 0);
  if (!total) return <Empty height={size} message={empty} />;

  const R = 70;
  const C = 2 * Math.PI * R;
  const palette = ["#4f46e5", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#64748b"];
  const shown = data.filter((d) => d.value > 0);
  let offset = 0;
  const segments = shown.map((d, i) => {
    const frac = d.value / total;
    const el = { d, color: palette[i % palette.length],
      dash: `${frac * C} ${C}`, offset: -offset };
    offset += frac * C;
    return el;
  });

  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row sm:gap-6">
      <svg viewBox="0 0 180 180" style={{ width: size, height: size }} role="img"
        aria-label={segments.map((s) => `${s.d.label}: ${s.d.value}`).join(", ")}>
        <g transform="translate(90,90) rotate(-90)">
          <circle r={R} fill="none" stroke="#f1f5f9" strokeWidth={26} />
          {segments.map((s) => (
            <circle key={s.d.label} r={R} fill="none" stroke={s.color} strokeWidth={26}
              strokeDasharray={s.dash} strokeDashoffset={s.offset}>
              <title>{`${s.d.label}: ${s.d.value}`}</title>
            </circle>
          ))}
        </g>
        {centerValue && (
          <>
            <text x={90} y={86} textAnchor="middle" fontSize={26} fontWeight={800} fill="#0f172a">
              {centerValue}
            </text>
            <text x={90} y={106} textAnchor="middle" fontSize={11} fill="#64748b">
              {centerLabel}
            </text>
          </>
        )}
      </svg>
      <ul className="w-full space-y-1.5 text-sm">
        {segments.map((s) => (
          <li key={s.d.label} className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: s.color }} />
            <span className="flex-1 capitalize text-slate-600">{s.d.label}</span>
            <span className="font-semibold tnum">{s.d.value}</span>
            <span className="w-10 text-right text-xs text-slate-400 tnum">
              {Math.round((s.d.value / total) * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Ranked horizontal bars — top data users, best-selling packages.
 * Divs rather than SVG so the labels wrap and stay selectable/copyable.
 */
export function RankedBars({
  data,
  format = (v: number) => String(v),
  color = "bg-indigo-500",
  empty = "No data yet.",
  secondary,
}: {
  data: Point[];
  format?: (v: number) => string;
  color?: string;
  empty?: string;
  /** Optional second line per row, e.g. the download/upload split. */
  secondary?: (d: Point, index: number) => string | null;
}) {
  if (!data.length) return <p className="py-6 text-center text-sm text-slate-400">{empty}</p>;
  const max = Math.max(...data.map((d) => d.value), 1);
  return (
    <ul className="space-y-2.5">
      {data.map((d, i) => (
        <li key={d.label + i}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
            <span className="truncate font-medium text-slate-700">{d.label}</span>
            <span className="shrink-0 font-semibold tnum">{format(d.value)}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-slate-100">
            <div className={`h-full rounded-full ${color}`}
              style={{ width: `${Math.max(2, (d.value / max) * 100)}%` }} />
          </div>
          {secondary?.(d, i) && <p className="mt-0.5 text-xs text-slate-500">{secondary(d, i)}</p>}
        </li>
      ))}
    </ul>
  );
}
