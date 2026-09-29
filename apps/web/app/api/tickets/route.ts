// Support tickets. GET lists (optionally filtered), POST opens one and also
// fires the notification the dashboard bell shows.
import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { resolveIsp, uidem } from "@/lib/isp";
import { z } from "zod";

const createSchema = z.object({
  subject: z.string().min(3).max(160),
  body: z.string().max(4000).optional().or(z.literal("")),
  customer_id: z.string().uuid().optional().or(z.literal("")),
  channel: z.enum(["email", "whatsapp", "phone", "portal"]).default("email"),
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
});

const patchSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["open", "pending", "resolved", "closed"]).optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  assigned_to: z.string().uuid().nullable().optional(),
  // A reply is appended to the thread and flips the ticket back to pending.
  reply: z.string().max(4000).optional(),
});

export async function GET(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status");
  let q = r.supabase
    .from("support_tickets")
    .select("id,ticket_no,subject,status,priority,channel,created_at,updated_at,resolved_at,customer_id,customers(full_name,customer_no,phone)")
    .eq("isp_id", r.ispId)
    .order("created_at", { ascending: false })
    .limit(300);
  if (status && status !== "all") q = q.eq("status", status);
  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ tickets: data ?? [] });
}

export async function POST(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const parsed = createSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }
  const svc = createServiceClient();
  // Sequence per ISP: count + 1 is fine for an SME-sized queue and avoids a
  // Postgres sequence per tenant.
  const { count } = await svc
    .from("support_tickets").select("id", { count: "exact", head: true }).eq("isp_id", r.ispId);
  const ticket_no = `TKT-${String((count ?? 0) + 1).padStart(4, "0")}`;

  const customerId = parsed.data.customer_id || null;
  let customer: { full_name: string; phone: string } | null = null;
  if (customerId) {
    const { data } = await svc.from("customers")
      .select("full_name,phone").eq("id", customerId).eq("isp_id", r.ispId).maybeSingle();
    customer = data;
  }

  const { data, error } = await svc.from("support_tickets").insert({
    isp_id: r.ispId, customer_id: customerId, ticket_no,
    subject: parsed.data.subject, body: parsed.data.body,
    channel: parsed.data.channel, priority: parsed.data.priority,
    status: "open", assigned_to: r.user.id,
  }).select("id,ticket_no").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  await svc.from("notifications").insert({
    isp_id: r.ispId, customer_id: customerId, type: "support",
    title: `${ticket_no} opened — ${parsed.data.subject}`,
    message: customer ? `${customer.full_name} (${customer.phone})` : "Raised from the dashboard",
  });

  return NextResponse.json({ ticket: data }, { status: 201 });
}

export async function PATCH(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const parsed = patchSchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const { id, reply, ...rest } = parsed.data;
  const svc = createServiceClient();

  // Scope by isp_id on the UPDATE itself: a body-supplied id from another tenant
  // must match zero rows, not silently resolve.
  const patch: Record<string, unknown> = { ...rest };
  if (rest.status === "resolved" || rest.status === "closed") patch.resolved_at = new Date().toISOString();
  if (reply) {
    const { data: cur } = await svc.from("support_tickets")
      .select("body").eq("id", id).eq("isp_id", r.ispId).maybeSingle();
    patch.body = `${cur?.body ?? ""}\n\n--- reply ${new Date().toISOString()} by staff ---\n${reply}`.trim();
    if (!rest.status) patch.status = "pending";
  }
  const { data, error } = await svc.from("support_tickets")
    .update(patch).eq("id", id).eq("isp_id", r.ispId)
    .select("id,ticket_no,status").single();
  if (error || !data) return NextResponse.json({ error: error?.message ?? "Not found" }, { status: 404 });

  if (data.status === "resolved" || data.status === "closed") {
    const { data: t } = await svc.from("support_tickets")
      .select("customer_id,customer_no").eq("id", id).eq("isp_id", r.ispId).maybeSingle();
    await svc.from("notifications").insert({
      isp_id: r.ispId, customer_id: t?.customer_id ?? null, type: "support",
      title: `${data.ticket_no} resolved`,
      message: t?.customer_no ? `Customer ${t.customer_no} notified.` : "Ticket closed.",
    });
  }
  return NextResponse.json({ ticket: data });
}
