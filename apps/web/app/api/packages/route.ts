import { NextResponse } from "next/server";
import { createPackageSchema } from "@/lib/validation";
import { resolveIsp } from "@/lib/isp";

// GET /api/packages?isp= — list ISP packages (RLS scoped)
export async function GET(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const { data, error } = await r.supabase.from("packages")
    .select("*").eq("isp_id", r.ispId).order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ packages: data });
}

// POST /api/packages — create package (admin/owner via RLS policy)
export async function POST(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const parsed = createPackageSchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const { data, error } = await r.supabase.from("packages")
    .insert({ ...parsed.data, isp_id: r.ispId }).select("*").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 403 });
  return NextResponse.json({ package: data }, { status: 201 });
}
