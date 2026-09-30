import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/admin-auth";
import { announcementSchema } from "@/lib/validation";

// Platform announcements — Super Admin only.
//
// This is a DIFFERENT credential path from the ISP dashboard (see
// lib/admin-auth.ts), so the guard is the fixed admin session cookie and there
// is no isp_id to scope by: announcements are written once by the platform and
// read by every ISP. Publishing/unpublishing is the archive control here — the
// table has no separate archive column, and an unpublished row is already
// invisible to ISPs through the `ann_read` RLS policy.

// 401 signed out of the admin console, 403 signed in as a non-admin.
async function guard() {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }
  return null;
}

// GET — every announcement, published or not, newest first.
export async function GET() {
  const denied = await guard();
  if (denied) return denied;

  const svc = createServiceClient();
  const { data, error } = await svc.from("announcements")
    .select("id, title, body, audience, published, published_at, created_at")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ announcements: data ?? [] });
}

// POST — create (as a draft unless `published` is set).
export async function POST(req: Request) {
  const denied = await guard();
  if (denied) return denied;

  const parsed = announcementSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }

  const { data, error } = await createServiceClient().from("announcements").insert({
    title: parsed.data.title,
    body: parsed.data.body,
    audience: parsed.data.audience,
    published: parsed.data.published,
    // Set on first publish so "published since" is a real timestamp, not the
    // row creation time carried forward through edits.
    published_at: parsed.data.published ? new Date().toISOString() : null,
  }).select("id, title, body, audience, published, published_at, created_at").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ announcement: data }, { status: 201 });
}
