import { resolveIsp } from "@/lib/isp";
import { NextResponse } from "next/server";

// GET /api/reports?kind=revenue|usage|expiry&range=7|30|90
export async function GET(req: Request) {
  const { supabase, ispId, error } = await resolveIsp(req);
  if (error) return error;

  const url = new URL(req.url);
  const kind = url.searchParams.get("kind") ?? "revenue";
  const days = Math.min(Math.max(Number(url.searchParams.get("range") ?? "30"), 1), 90);
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const sinceDay = since.slice(0, 10);

  if (kind === "usage") {
    const { data: usage } = await supabase.from("data_usage")
      .select("day, upload_bytes, download_bytes, session_seconds, sessions")
      .eq("isp_id", ispId).gte("day", sinceDay).order("day", { ascending: true });
    // Aggregate by day across users
    const daily = new Map<string, { day: string; upload: number; download: number; total: number; sessions: number }>();
    for (const r of usage ?? []) {
      const a = daily.get(r.day) ?? { day: r.day, upload: 0, download: 0, total: 0, sessions: 0 };
      const up = Number(r.upload_bytes ?? 0);
      const dn = Number(r.download_bytes ?? 0);
      a.upload += up; a.download += dn; a.total += (up + dn);
      a.sessions += Number(r.sessions ?? 0);
      daily.set(r.day, a);
    }
    return NextResponse.json({ kind: "usage", days, data: Array.from(daily.values()) });
  }

  if (kind === "expiry") {
    const { data: expiring } = await supabase.from("customers")
      .select("id, full_name, phone, username, expiry_date, status")
      .eq("isp_id", ispId)
      .gte("expiry_date", new Date().toISOString())
      .lte("expiry_date", new Date(Date.now() + 7 * 86400_000).toISOString())
      .order("expiry_date", { ascending: true });
    const { data: expired } = await supabase.from("customers")
      .select("id, full_name, phone, username, expiry_date, status")
      .eq("isp_id", ispId).eq("status", "expired")
      .gte("expiry_date", since)
      .order("expiry_date", { ascending: false });
    return NextResponse.json({ kind: "expiry", expiring_soon: expiring ?? [], recently_expired: expired ?? [] });
  }

  // kind === "revenue" (default): payments grouped by day + by package
  const { data: payments } = await supabase.from("payments")
    .select("amount, paid_at, package_id")
    .eq("isp_id", ispId).eq("status", "completed").gte("paid_at", since);
  const daily = new Map<string, { day: string; count: number; total_minor: number }>();
  let totalMinor = 0;
  for (const p of payments ?? []) {
    const day = (p.paid_at ?? "").slice(0, 10);
    const amt = Number(p.amount ?? 0);
    totalMinor += amt;
    const a = daily.get(day) ?? { day, count: 0, total_minor: 0 };
    a.count++; a.total_minor += amt;
    daily.set(day, a);
  }
  return NextResponse.json({
    kind: "revenue", days,
    total_minor: totalMinor,
    daily: Array.from(daily.values()).sort((a, b) => a.day.localeCompare(b.day)),
  });
}
