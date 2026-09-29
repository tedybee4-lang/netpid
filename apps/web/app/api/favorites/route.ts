// Dashboard favorites — per staff member, so two operators can pin different
// shortcuts. Every query is pinned to auth.uid(); the id in the body is never
// trusted for the ownership check.
import { NextResponse } from "next/server";
import { resolveIsp } from "@/lib/isp";
import { z } from "zod";

const addSchema = z.object({
  label: z.string().min(1).max(60),
  // Only same-origin dashboard paths, so a favorite cannot become an open
  // redirect to an attacker's site.
  href: z.string().min(1).max(300).startsWith("/dashboard"),
});

export async function GET(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const { data } = await r.supabase
    .from("dashboard_favorites")
    .select("id,label,href,position")
    .eq("user_id", r.user.id)
    .order("position");
  return NextResponse.json({ favorites: data ?? [] });
}

export async function POST(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const parsed = addSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Label required, and the link must be a /dashboard path" }, { status: 400 });
  }
  const { count } = await r.supabase
    .from("dashboard_favorites").select("id", { count: "exact", head: true }).eq("user_id", r.user.id);
  if ((count ?? 0) >= 30) {
    return NextResponse.json({ error: "You can pin up to 30 favorites" }, { status: 400 });
  }
  // onConflict: user_id,href — re-pinning moves the existing row instead of
  // failing on the unique index.
  const { data, error } = await r.supabase.from("dashboard_favorites").upsert({
    isp_id: r.ispId, user_id: r.user.id,
    label: parsed.data.label, href: parsed.data.href, position: count ?? 0,
  }, { onConflict: "user_id,href" }).select("id,label,href").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ favorite: data }, { status: 201 });
}

export async function DELETE(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const { error } = await r.supabase.from("dashboard_favorites")
    .delete().eq("id", id).eq("user_id", r.user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
