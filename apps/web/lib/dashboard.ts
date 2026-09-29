import { createClient } from "@/lib/supabase/server";

// One place that turns raw tables into the numbers the dashboard shows.
//
// Everything goes through the session client, so RLS is what scopes these
// queries to the caller's ISP — there is no hand-written tenant filter here
// that could drift from the policies.
//
// Conventions:
//  * money is KES minor units (integer cents) until the last possible moment
//  * speeds are kilobits per second
//  * "online" comes only from radius_sessions, never inferred from customer
//    status — a customer can be active and not currently connected.

export type Router = {
  id: string; name: string; host: string; status: string;
  site: string | null; model: string | null; ros_version: string | null;
  last_seen_at: string | null; uptime_seconds: number | null;
  cpu_load: number | null; mem_used_pct: number | null;
};

export type DashboardData = {
  isp: { id: string; name: string; slug: string; status: string | null } | null;
  kpi: {
    revenueToday: number; revenueMonth: number; revenueLastMonth: number;
    activeCustomers: number; totalCustomers: number; expiredCustomers: number;
    onlineNow: number; routersOnline: number; routersTotal: number;
    expiringSoon: number; pendingPayments: number; smsSent: number; smsFailed: number;
  };
  statusMix: { label: string; value: number }[];
  monthlyRevenue: { label: string; value: number }[];
  monthlySignups: { label: string; value: number }[];
  topDownloaders: { label: string; value: number; upload: number; download: number }[];
  topPackages: { label: string; value: number; sales: number }[];
  routers: Router[];
  recentSessions: {
    username: string; framed_ip: string | null; start_time: string | null; down: number; up: number;
  }[];
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthKeys(count: number): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = [];
  const now = new Date();
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push({
      key: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`,
      label: MONTHS[d.getUTCMonth()],
    });
  }
  return out;
}

const EMPTY: DashboardData = {
  isp: null,
  kpi: {
    revenueToday: 0, revenueMonth: 0, revenueLastMonth: 0, activeCustomers: 0,
    totalCustomers: 0, expiredCustomers: 0, onlineNow: 0, routersOnline: 0,
    routersTotal: 0, expiringSoon: 0, pendingPayments: 0, smsSent: 0, smsFailed: 0,
  },
  statusMix: [], monthlyRevenue: [], monthlySignups: [],
  topDownloaders: [], topPackages: [], routers: [], recentSessions: [],
};

export async function loadDashboard(): Promise<DashboardData> {
  const supabase = await createClient();

  const { data: memberships } = await supabase
    .from("isp_users").select("isp_id, isps(id,name,slug,status)").eq("is_active", true);
  const membership = memberships?.[0];
  const ispId = membership?.isp_id as string | undefined;
  if (!ispId) return EMPTY;
  const isp = (membership?.isps as unknown as DashboardData["isp"]) ?? null;

  const now = new Date();
  const months = monthKeys(12);
  const since12 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1)).toISOString();
  const since30 = new Date(now.getTime() - 30 * 86400_000).toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);
  const in7days = new Date(now.getTime() + 7 * 86400_000).toISOString();

  const [
    { data: customers }, { data: payments }, { data: routers },
    { data: sessions }, { data: usage }, { data: sales }, { data: packages }, { data: sms },
  ] = await Promise.all([
    supabase.from("customers")
      .select("id,status,created_at,expiry_date,package_id,download_kbps,upload_kbps,full_name,username")
      .order("created_at", { ascending: false }).limit(5000),
    supabase.from("payments").select("amount,status,paid_at,created_at,package_id")
      .gte("created_at", since12).order("created_at", { ascending: false }).limit(5000),
    supabase.from("routers")
      .select("id,name,host,status,site,model,ros_version,last_seen_at,uptime_seconds,cpu_load,mem_used_pct")
      .order("name").limit(200),
    supabase.from("radius_sessions")
      .select("username,framed_ip,start_time,input_octets,output_octets")
      .eq("is_open", true).order("last_update", { ascending: false }).limit(200),
    supabase.from("data_usage")
      .select("customer_id,upload_bytes,download_bytes,customers(full_name,username)")
      .gte("day", since30).limit(5000),
    supabase.from("package_sales_daily")
      .select("package_id,count,revenue").gte("day", since30).limit(2000),
    supabase.from("packages").select("id,name,price").limit(500),
    supabase.from("sms_usage").select("sent,failed").eq("day", today).maybeSingle(),
  ]);

  const cust = customers ?? [];
  const byStatus = cust.reduce<Record<string, number>>((a, c) => {
    a[c.status] = (a[c.status] ?? 0) + 1; return a;
  }, {});

  // Revenue buckets. paid_at is authoritative; fall back to created_at so a
  // payment confirmed later still lands in the month the customer actually paid.
  const revByMonth = new Map<string, number>();
  let revenueToday = 0;
  let revenueMonth = 0;
  let revenueLastMonth = 0;
  const thisKey = months[months.length - 1].key;
  const prevKey = months[months.length - 2].key;
  for (const p of payments ?? []) {
    if (p.status !== "completed") continue;
    const at = p.paid_at ?? p.created_at;
    if (!at) continue;
    const d = new Date(at);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const amount = Number(p.amount ?? 0);
    revByMonth.set(key, (revByMonth.get(key) ?? 0) + amount);
    if (at.slice(0, 10) === today) revenueToday += amount;
    if (key === thisKey) revenueMonth += amount;
    if (key === prevKey) revenueLastMonth += amount;
  }

  const signupsByMonth = new Map<string, number>();
  for (const c of cust) {
    if (!c.created_at) continue;
    const d = new Date(c.created_at);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    signupsByMonth.set(key, (signupsByMonth.get(key) ?? 0) + 1);
  }

  // Top downloaders over 30 days. Download and upload stay separate columns:
  // an ISP capping a shared uplink cares about the sum, but a customer
  // complaining about "speed" almost always means their download.
  const byCustomer = new Map<string, { name: string; down: number; up: number }>();
  for (const u of usage ?? []) {
    const joined = u.customers as unknown as
      { full_name?: string; username?: string } | { full_name?: string; username?: string }[] | null;
    const c = Array.isArray(joined) ? joined[0] : joined;
    const key = (u.customer_id as string | null) ?? "unattributed";
    const cur = byCustomer.get(key) ?? { name: c?.full_name ?? c?.username ?? "Unattributed", down: 0, up: 0 };
    cur.down += Number(u.download_bytes ?? 0);
    cur.up += Number(u.upload_bytes ?? 0);
    byCustomer.set(key, cur);
  }
  const topDownloaders = [...byCustomer.entries()]
    .map(([id, v]) => ({ label: v.name, value: v.down, upload: v.up, download: v.down, id }))
    .sort((a, b) => b.value - a.value).slice(0, 5);

  const pkgName = new Map((packages ?? []).map((p) => [p.id as string, p.name as string]));
  const pkgAgg = new Map<string, { sales: number; revenue: number }>();
  for (const s of sales ?? []) {
    if (!s.package_id) continue;
    const cur = pkgAgg.get(s.package_id) ?? { sales: 0, revenue: 0 };
    cur.sales += Number(s.count ?? 0);
    cur.revenue += Number(s.revenue ?? 0);
    pkgAgg.set(s.package_id, cur);
  }
  const topPackages = [...pkgAgg.entries()]
    .map(([id, v]) => ({ label: pkgName.get(id) ?? "Unknown package", value: v.sales, sales: v.sales, id }))
    .sort((a, b) => b.value - a.value).slice(0, 5);

  const list = routers ?? [];

  return {
    isp,
    kpi: {
      revenueToday,
      revenueMonth,
      revenueLastMonth,
      activeCustomers: byStatus.active ?? 0,
      totalCustomers: cust.length,
      expiredCustomers: byStatus.expired ?? 0,
      onlineNow: (sessions ?? []).length,
      routersOnline: list.filter((r) => r.status === "online").length,
      routersTotal: list.length,
      expiringSoon: cust.filter(
        (c) => c.status === "active" && c.expiry_date && c.expiry_date <= in7days,
      ).length,
      pendingPayments: (payments ?? []).filter((p) => p.status === "pending").length,
      smsSent: sms?.sent ?? 0,
      smsFailed: sms?.failed ?? 0,
    },
    statusMix: ["active", "pending", "expired", "suspended", "blocked", "terminated"]
      .map((s) => ({ label: s, value: byStatus[s] ?? 0 })),
    monthlyRevenue: months.map((m) => ({ label: m.label, value: revByMonth.get(m.key) ?? 0 })),
    monthlySignups: months.map((m) => ({ label: m.label, value: signupsByMonth.get(m.key) ?? 0 })),
    topDownloaders,
    topPackages,
    routers: list,
    recentSessions: (sessions ?? []).slice(0, 8).map((s) => ({
      username: s.username,
      framed_ip: s.framed_ip ? String(s.framed_ip) : null,
      start_time: s.start_time,
      down: Number(s.output_octets ?? 0),
      up: Number(s.input_octets ?? 0),
    })),
  };
}

