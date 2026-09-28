import { NextResponse } from "next/server";
import { createCustomerSchema } from "@/lib/validation";
import { resolveIsp } from "@/lib/isp";

function customerNo(): string {
  return `C-${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 90 + 10)}`;
}

// GET /api/customers?isp=&q=&status= — search/filter, RLS scoped
export async function GET(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";
  const status = url.searchParams.get("status");
  let query = r.supabase.from("customers").select("*, packages(id,name,price)")
    .eq("isp_id", r.ispId).order("created_at", { ascending: false }).limit(100);
  if (status) query = query.eq("status", status);
  if (q) query = query.or(`full_name.ilike.%${q}%,phone.ilike.%${q}%,username.ilike.%${q}%,customer_no.ilike.%${q}%`);
  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ customers: data });
}

// POST /api/customers — cashier/support+ (RLS enforced)
export async function POST(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const parsed = createCustomerSchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const d = parsed.data;
  const { data, error } = await r.supabase.from("customers").insert({
    isp_id: r.ispId, customer_no: customerNo(),
    full_name: d.full_name, phone: d.phone, email: d.email || null,
    address: d.address || null, service_type: d.service_type,
    package_id: d.package_id ?? null, username: d.username ?? null,
    notes: d.notes || null, status: "pending",
  }).select("*").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 403 });
  return NextResponse.json({ customer: data }, { status: 201 });
}
