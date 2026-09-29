// Read-only aggregates for the dashboard modules that do not need their own
// write path. One route, one round trip per module, so a module page does not
// fan out into five fetches on a phone.
import { NextResponse } from "next/server";
import { resolveIsp } from "@/lib/isp";

export async function GET(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const { searchParams } = new URL(req.url);
  const module = searchParams.get("module") ?? "all";
  const s = r.supabase;
  // PostgREST returns an embedded to-one relation as an ARRAY.
  const one = <T,>(v: unknown) =>
    (Array.isArray(v) ? (v[0] as T | undefined) : v as T | undefined) ?? null;

  // Activation queue: customers provisioned but not yet live, with whatever
  // their last payment and service account say about them.
  if (module === "activation") {
    const [{ data: pending }, { data: accounts }, { data: payments }] = await Promise.all([
      s.from("customers")
        .select("id,customer_no,full_name,phone,service_type,status,package_id,created_at,installation_date,packages(name,service_type)")
        .eq("isp_id", r.ispId).eq("status", "pending").order("created_at", { ascending: true }).limit(200),
      s.from("pppoe_accounts").select("customer_id,enabled,profile").eq("isp_id", r.ispId),
      s.from("payments")
        .select("id,customer_id,amount,status,method,created_at")
        .eq("isp_id", r.ispId).order("created_at", { ascending: false }).limit(500),
    ]);
    const acc = new Set((accounts ?? []).filter((a) => a.enabled).map((a) => a.customer_id));
    const paid = new Set(
      (payments ?? []).filter((p) => p.status === "success").map((p) => p.customer_id),
    );
    return NextResponse.json({
      queue: (pending ?? []).map((c) => ({
        ...c,
        has_service_account: acc.has(c.id),
        has_payment: paid.has(c.id),
        // What the operator still has to do, in order.
        next_step: paid.has(c.id)
          ? (acc.has(c.id) ? "Activate on the router" : "Push credentials to the router")
          : "Take payment",
      })),
    });
  }

  // Data usage: per-customer totals for the window, plus the daily series.
  if (module === "data-usage") {
    const days = Math.min(Math.max(Number(searchParams.get("days") ?? 30) || 30, 1), 180);
    const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
    const [{ data: usage }, { data: customers }] = await Promise.all([
      s.from("data_usage")
        .select("customer_id,day,upload_bytes,download_bytes,session_seconds,sessions,customers(customer_no,full_name,status)")
        .eq("isp_id", r.ispId).gte("day", since).order("day", { ascending: false }).limit(20000),
      s.from("customers").select("id,customer_no,full_name,status,packages(name,data_cap_mb)")
        .eq("isp_id", r.ispId).limit(1000),
    ]);
    const rows = usage ?? [];
    const byCustomer = new Map<string, { up: number; down: number; sec: number; sess: number; name: string }>();
    const byDay = new Map<string, number>();
    for (const u of rows) {
      if (!u.customer_id) continue;
      const c = one<{ customer_no: string; full_name: string }>(u.customers);
      const cur = byCustomer.get(u.customer_id)
        ?? { up: 0, down: 0, sec: 0, sess: 0, name: c ? `${c.customer_no} · ${c.full_name}` : "Unknown" };
      cur.up += u.upload_bytes; cur.down += u.download_bytes;
      cur.sec += u.session_seconds; cur.sess += u.sessions;
      byCustomer.set(u.customer_id, cur);
      byDay.set(u.day, (byDay.get(u.day) ?? 0) + u.upload_bytes + u.download_bytes);
    }
    const totalDown = rows.reduce((a, u) => a + u.download_bytes, 0);
    const totalUp = rows.reduce((a, u) => a + u.upload_bytes, 0);
    return NextResponse.json({
      days,
      totals: {
        down: totalDown, up: totalUp, total: totalDown + totalUp,
        seconds: rows.reduce((a, u) => a + u.session_seconds, 0),
        sessions: rows.reduce((a, u) => a + u.sessions, 0),
        customers_reported: byCustomer.size,
      },
      daily: [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, bytes]) => ({ day, bytes })),
      perCustomer: [...byCustomer.entries()]
        .map(([id, v]) => ({ id, ...v }))
        .sort((a, b) => (b.down + b.up) - (a.down + a.up)).slice(0, 100),
      // For the "over cap" column; null when the package is uncapped.
      caps: Object.fromEntries(
        (customers ?? []).map((c) => [c.id, one<{ data_cap_mb: number | null }>(c.packages)?.data_cap_mb ?? null]),
      ),
    });
  }

  // Loyalty: ledger plus the current balance per customer.
  if (module === "loyalty") {
    const [{ data: ledger }, { data: customers }] = await Promise.all([
      s.from("loyalty_ledger")
        .select("id,customer_id,points,reason,payment_id,created_at,customers(customer_no,full_name,status,loyalty_points)")
        .eq("isp_id", r.ispId).order("created_at", { ascending: false }).limit(200),
      s.from("customers")
        .select("id,customer_no,full_name,status,loyalty_points,balance")
        .eq("isp_id", r.ispId).order("loyalty_points", { ascending: false }).limit(200),
    ]);
    return NextResponse.json({ ledger: ledger ?? [], customers: customers ?? [] });
  }

  // Access points, with the router list so the UI can group and offer a picker.
  if (module === "access") {
    const [{ data: aps }, { data: routers }] = await Promise.all([
      s.from("access_points")
        .select("id,router_id,name,ip,mac,ssid,location,status,clients,uptime_seconds,last_seen_at")
        .eq("isp_id", r.ispId).order("name").limit(300),
      s.from("routers").select("id,name,site,status").eq("isp_id", r.ispId).order("name"),
    ]);
    return NextResponse.json({ aps: aps ?? [], routers: routers ?? [] });
  }

  return NextResponse.json({ error: "Unknown module" }, { status: 400 });
}
