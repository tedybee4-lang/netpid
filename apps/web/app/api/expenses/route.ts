import { resolveIsp } from "@/lib/isp";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const { supabase, ispId, error } = await resolveIsp(req);
  if (error) return error;

  const { data, error: dbErr } = await supabase
    .from("expenses")
    .select("*")
    .eq("isp_id", ispId)
    .order("expense_date", { ascending: false });

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 400 });
  return NextResponse.json({ expenses: data ?? [] });
}

export async function POST(req: Request) {
  const { supabase, ispId, user, error } = await resolveIsp(req);
  if (error) return error;

  const body = await req.json().catch(() => ({}));
  const { category, title, amount_minor, expense_date, notes } = body;

  if (!category || !title || !amount_minor) {
    return NextResponse.json({ error: "Category, title, and amount are required" }, { status: 400 });
  }

  const { data, error: dbErr } = await supabase
    .from("expenses")
    .insert({
      isp_id: ispId,
      category,
      title,
      amount_minor: Number(amount_minor),
      expense_date: expense_date || new Date().toISOString().slice(0, 10),
      notes: notes || null,
      created_by: user.id,
    })
    .select()
    .single();

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 400 });
  return NextResponse.json({ expense: data }, { status: 201 });
}
