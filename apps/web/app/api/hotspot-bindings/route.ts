// HotSpot MAC binding. Binds a device MAC to a customer or a voucher so the
// worker can push a RADIUS/HostAPD attribute when the device connects.
import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { resolveIsp } from "@/lib/isp";
import { z } from "zod";

const createSchema = z.object({
  mac: z.string().min(11).max(32).regex(/^[0-9a-fA-F:.-]+$/, "MAC address, e.g. A4:83:E7:1B:22:09"),
  customer_id: z.string().uuid().optional().or(z.literal("")),
  voucher_id: z.string().uuid().optional().or(z.literal("")),
  ssid: z.string().max(64).optional().or(z.literal("")),
  note: z.string().max(300).optional().or(z.literal("")),
});

export async function GET(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const [{ data: bindings }, { data: customers }, { data: vouchers }] = await Promise.all([
    r.supabase.from("hotspot_bindings")
      .select("id,mac,ssid,note,created_at,customer_id,voucher_id,customers(customer_no,full_name),vouchers(code,status)")
      .eq("isp_id", r.ispId).order("created_at", { ascending: false }).limit(300),
    r.supabase.from("customers")
      .select("id,customer_no,full_name,status").eq("isp_id", r.ispId)
      .eq("service_type", "hotspot").order("full_name").limit(500),
    r.supabase.from("vouchers")
      .select("id,code,status").eq("isp_id", r.ispId).eq("status", "unused")
      .order("created_at", { ascending: false }).limit(200),
  ]);
  return NextResponse.json({
    bindings: bindings ?? [], customers: customers ?? [], vouchers: vouchers ?? [],
  });
}

export async function POST(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const parsed = createSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }
  if (!parsed.data.customer_id && !parsed.data.voucher_id) {
    return NextResponse.json({ error: "Bind to a customer or a voucher" }, { status: 400 });
  }
  // Normalise the MAC so A4-83-E7-1B and a4:83:e7:1b do not become two rows.
  const mac = parsed.data.mac.replace(/-/g, ":").replace(/\./g, ":").toLowerCase();
  const svc = createServiceClient();

  // Confirm the referenced customer/voucher belongs to this ISP before writing.
  if (parsed.data.customer_id) {
    const { data } = await svc.from("customers").select("id")
      .eq("id", parsed.data.customer_id).eq("isp_id", r.ispId).maybeSingle();
    if (!data) return NextResponse.json({ error: "Customer not in your ISP" }, { status: 400 });
  }
  if (parsed.data.voucher_id) {
    const { data } = await svc.from("vouchers").select("id")
      .eq("id", parsed.data.voucher_id).eq("isp_id", r.ispId).maybeSingle();
    if (!data) return NextResponse.json({ error: "Voucher not in your ISP" }, { status: 400 });
  }

  const { data, error } = await svc.from("hotspot_bindings").upsert({
    isp_id: r.ispId, mac,
    customer_id: parsed.data.customer_id || null,
    voucher_id: parsed.data.voucher_id || null,
    ssid: parsed.data.ssid || null, note: parsed.data.note || null,
  }, { onConflict: "isp_id,mac" })
    .select("id,mac,customer_id,voucher_id,ssid").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ binding: data }, { status: 201 });
}

export async function DELETE(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const svc = createServiceClient();
  const { error } = await svc.from("hotspot_bindings").delete().eq("id", id).eq("isp_id", r.ispId);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
