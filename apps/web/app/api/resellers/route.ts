import { resolveIsp } from "@/lib/isp";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const { supabase, ispId, error } = await resolveIsp(req);
  if (error) return error;

  const { data, error: dbErr } = await supabase
    .from("resellers")
    .select("*")
    .eq("isp_id", ispId)
    .order("created_at", { ascending: false });

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 400 });
  return NextResponse.json({ resellers: data ?? [] });
}

export async function POST(req: Request) {
  const { supabase, ispId, error } = await resolveIsp(req);
  if (error) return error;

  const body = await req.json().catch(() => ({}));
  const { name, phone, email, commission_percentage } = body;

  if (!name || !phone) {
    return NextResponse.json({ error: "Name and phone are required" }, { status: 400 });
  }

  const { data, error: dbErr } = await supabase
    .from("resellers")
    .insert({
      isp_id: ispId,
      name,
      phone,
      email: email || null,
      commission_percentage: commission_percentage ? Number(commission_percentage) : 10.0,
      status: "active",
    })
    .select()
    .single();

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 400 });
  return NextResponse.json({ reseller: data }, { status: 201 });
}
