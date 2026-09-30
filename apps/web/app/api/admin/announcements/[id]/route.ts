import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/admin-auth";
import { announcementUpdateSchema } from "@/lib/validation";

// PATCH/DELETE /api/admin/announcements/[id] — Super Admin only.
//
// `published: false` is both "unpublish" and "archive": once it is false the
// `ann_read` RLS policy stops serving the row to ISPs, so an unpublish is an
// archive as far as subscribers are concerned. Re-publishing sets a fresh
// published_at so the console always shows when it went live.

async function guard() {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }
  return null;
}

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  const denied = await guard();
  if (denied) return denied;
  const { id } = await ctx.params;

  const parsed = announcementUpdateSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }

  const svc = createServiceClient();
  const { data: existing } = await svc.from("announcements")
    .select("id, published, published_at").eq("id", id).maybeSingle();
  if (!existing) return NextResponse.json({ error: "Announcement not found" }, { status: 404 });

  const patch: Record<string, unknown> = { ...parsed.data };
  if (parsed.data.published !== undefined) {
    patch.published_at = parsed.data.published
      ? (existing.published_at ?? new Date().toISOString())
      : null;
  }

  const { data, error } = await svc.from("announcements")
    .update(patch)
    .eq("id", id)
    .select("id, title, body, audience, published, published_at, created_at")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ announcement: data });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const denied = await guard();
  if (denied) return denied;
  const { id } = await ctx.params;

  const svc = createServiceClient();
  const { data: existing } = await svc.from("announcements")
    .select("id, title, published").eq("id", id).maybeSingle();
  if (!existing) return NextResponse.json({ error: "Announcement not found" }, { status: 404 });

  const { error } = await svc.from("announcements").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({
    ok: true,
    message: existing.published
      ? "Deleted. It was live — anyone who had already read it still has that copy in their history."
      : "Deleted.",
  });
}
