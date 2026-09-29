// Escalations to NETPID platform support. Attaches a snapshot of the caller's
// own health data so support does not have to ask for screenshots.
import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { resolveIsp } from "@/lib/isp";
import { z } from "zod";

const createSchema = z.object({
  category: z.enum(["general", "billing", "outage", "bug", "router", "data_loss", "other"]).default("general"),
  summary: z.string().min(5).max(160),
  detail: z.string().max(8000).optional().or(z.literal("")),
  attach_diagnostics: z.boolean().default(true),
});

export async function GET(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const { data } = await r.supabase
    .from("escalations")
    .select("id,category,summary,detail,status,created_at,resolved_at")
    .eq("isp_id", r.ispId).order("created_at", { ascending: false }).limit(100);
  return NextResponse.json({ escalations: data ?? [] });
}

export async function POST(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const parsed = createSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Describe the problem in at least 5 characters" }, { status: 400 });
  }
  const svc = createServiceClient();

  let diagnostics: Record<string, unknown> = {};
  if (parsed.data.attach_diagnostics) {
    // Counts only, and only this ISP's rows. No customer PII is copied out.
    const [routers, customers, offline, openTickets] = await Promise.all([
      svc.from("routers").select("id", { count: "exact", head: true }).eq("isp_id", r.ispId),
      svc.from("customers").select("id", { count: "exact", head: true }).eq("isp_id", r.ispId),
      svc.from("routers").select("id", { count: "exact", head: true })
        .eq("isp_id", r.ispId).neq("status", "online"),
      svc.from("support_tickets").select("id", { count: "exact", head: true })
        .eq("isp_id", r.ispId).eq("status", "open"),
    ]);
    diagnostics = {
      routers: routers.count ?? 0, routers_not_online: offline.count ?? 0,
      customers: customers.count ?? 0, open_tickets: openTickets.count ?? 0,
      app_version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local",
      captured_at: new Date().toISOString(),
    };
  }

  const { data, error } = await svc.from("escalations").insert({
    isp_id: r.ispId, category: parsed.data.category, summary: parsed.data.summary,
    detail: parsed.data.detail, diagnostics, raised_by: r.user.id,
  }).select("id,category,summary,status,created_at").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  await svc.from("notifications").insert({
    isp_id: r.ispId, recipient_user_id: r.user.id, type: "escalation",
    title: `Escalation raised — ${parsed.data.summary.slice(0, 60)}`,
    message: "NETPID platform support has your report and will reply here.",
  });
  return NextResponse.json({ escalation: data, diagnostics }, { status: 201 });
}
