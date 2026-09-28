import { resolveIsp } from "@/lib/isp";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const { supabase, ispId, error } = await resolveIsp(req);
  if (error) return error;

  const { data, error: dbErr } = await supabase
    .from("inventory_items")
    .select("*, customers(full_name, account_number)")
    .eq("isp_id", ispId)
    .order("created_at", { ascending: false });

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 400 });
  return NextResponse.json({ items: data ?? [] });
}

export async function POST(req: Request) {
  const { supabase, ispId, error } = await resolveIsp(req);
  if (error) return error;

  const body = await req.json().catch(() => ({}));
  const { item_type, model, serial_number, mac_address, status, purchase_cost_minor, purchase_date } = body;

  if (!item_type || !model) {
    return NextResponse.json({ error: "Item type and model are required" }, { status: 400 });
  }

  const { data, error: dbErr } = await supabase
    .from("inventory_items")
    .insert({
      isp_id: ispId,
      item_type,
      model,
      serial_number: serial_number || null,
      mac_address: mac_address || null,
      status: status || "in_stock",
      purchase_cost_minor: purchase_cost_minor ? Number(purchase_cost_minor) : 0,
      purchase_date: purchase_date || new Date().toISOString().slice(0, 10),
    })
    .select()
    .single();

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 400 });
  return NextResponse.json({ item: data }, { status: 201 });
}
