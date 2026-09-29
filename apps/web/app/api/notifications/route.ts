// Notification centre. GET returns the caller's feed; PATCH marks read/unread.
// recipient_user_id is always auth.uid(), so one operator can never clear (or
// read) a colleague's notifications.
import { NextResponse } from "next/server";
import { resolveIsp } from "@/lib/isp";
import { z } from "zod";

const patchSchema = z.object({
  id: z.string().uuid().optional(),
  all: z.boolean().optional(),
  read: z.boolean().default(true),
});

export async function GET(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const { data, error } = await r.supabase
    .from("notifications")
    .select("id,type,title,message,read,created_at,customer_id,customers(customer_no,full_name)")
    .eq("isp_id", r.ispId)
    // A NULL recipient means "everyone in the ISP" (e.g. a platform notice).
    .or(`recipient_user_id.eq.${r.user.id},recipient_user_id.is.null`)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  const all = data ?? [];
  return NextResponse.json({ notifications: all, unread: all.filter((n) => !n.read).length });
}

export async function PATCH(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const parsed = patchSchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const { createServiceClient } = await import("@/lib/supabase/server");
  const svc = createServiceClient();

  // Rows with a NULL recipient are ISP-wide broadcasts, so they are excluded
  // from the WHERE: marking one read would hide it from every other operator.
  // Marking an id that belongs to someone else simply matches zero rows.
  // The filters are applied inside the select() call so the builder keeps its
  // full type instead of collapsing to the update-only generic.
  if (parsed.data.all) {
    const { error } = await svc
      .from("notifications")
      .update({ read: parsed.data.read })
      .eq("isp_id", r.ispId)
      .not("recipient_user_id", "is", null);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ ok: true });
  }

  const { error } = await svc
    .from("notifications")
    .update({ read: parsed.data.read })
    .eq("id", parsed.data.id ?? "")
    .eq("recipient_user_id", r.user.id)
    .eq("isp_id", r.ispId)
    .not("recipient_user_id", "is", null);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
