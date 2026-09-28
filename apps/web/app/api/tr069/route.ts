import { resolveIsp } from "@/lib/isp";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const { supabase, ispId, error } = await resolveIsp(req);
  if (error) return error;

  const { data, error: dbErr } = await supabase
    .from("tr069_devices")
    .select("*, customers(full_name, account_number)")
    .eq("isp_id", ispId)
    .order("last_inform_at", { ascending: false, nullsFirst: false });

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 400 });
  return NextResponse.json({ devices: data ?? [] });
}

export async function POST(req: Request) {
  const { supabase, ispId, error } = await resolveIsp(req);
  if (error) return error;

  const body = await req.json().catch(() => ({}));
  const { serial_number, manufacturer, product_class, oui, customer_id } = body;

  if (!serial_number) {
    return NextResponse.json({ error: "Serial number is required" }, { status: 400 });
  }

  const { data, error: dbErr } = await supabase
    .from("tr069_devices")
    .insert({
      isp_id: ispId,
      serial_number,
      manufacturer: manufacturer || "Unknown",
      product_class: product_class || "",
      oui: oui || "",
      customer_id: customer_id || null,
      status: "provisioning",
    })
    .select()
    .single();

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 400 });
  return NextResponse.json({ device: data }, { status: 201 });
}
