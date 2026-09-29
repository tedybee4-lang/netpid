// Merged activity log. Four separate audit tables exist (router provisioning,
// AI diagnostics, support tickets, SMS) and an operator wants one timeline
// rather than four tabs, so they are unioned here and sorted server-side.
import { NextResponse } from "next/server";
import { resolveIsp } from "@/lib/isp";

export type LogKind = "Router" | "Diagnostic" | "Ticket" | "SMS" | "Payment" | "Customer";
export interface LogRow {
  id: string;
  at: string;
  kind: LogKind;
  summary: string;
  status: "ok" | "warn" | "bad";
  source: string;
  detail?: Record<string, unknown>;
}

export async function GET(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const s = r.supabase;
  const kind = new URL(req.url).searchParams.get("kind");
  const want = (k: LogKind) => !kind || kind === "all" || kind === k;
  // PromiseLike, not Promise: a PostgREST builder is thenable but has no
  // catch/finally, so typing this as Promise[] rejects every push.
  const jobs: PromiseLike<LogRow[]>[] = [];

  // PostgREST returns an embedded to-one relation as an ARRAY, so the shapes
  // below cast through unknown rather than fighting the generated union.
  const one = <T,>(v: unknown) => (Array.isArray(v) ? (v[0] as T | undefined) : v as T | undefined);

  if (want("Router")) {
    jobs.push(s.from("router_provision_log")
      .select("id,action,source,detail,created_at,routers(name)").eq("isp_id", r.ispId)
      .order("created_at", { ascending: false }).limit(120)
      .then(({ data }) => (data ?? []).map((x): LogRow => ({
        id: x.id, at: x.created_at, kind: "Router", source: x.source,
        summary: `${x.action.replace(/-/g, " ")} — ${one<{ name: string }>(x.routers)?.name ?? "router"}`,
        status: x.action === "deleted" ? "bad" : "ok",
        detail: x.detail as Record<string, unknown>,
      }))));
  }
  if (want("Diagnostic")) {
    jobs.push(s.from("ai_diagnostic_logs")
      .select("id,target_type,target_id,diagnosis,suggested_action,severity,created_at").eq("isp_id", r.ispId)
      .order("created_at", { ascending: false }).limit(120)
      .then(({ data }) => (data ?? []).map((x): LogRow => ({
        id: x.id, at: x.created_at, kind: "Diagnostic", source: "app",
        summary: `${x.target_type} ${x.target_id}: ${x.diagnosis.slice(0, 90)}`,
        status: ["critical", "high"].includes(x.severity) ? "bad"
          : x.severity === "medium" ? "warn" : "ok",
        detail: { suggested_action: x.suggested_action },
      }))));
  }
  if (want("Ticket")) {
    jobs.push(s.from("support_tickets")
      .select("id,ticket_no,subject,status,priority,created_at,updated_at").eq("isp_id", r.ispId)
      .order("created_at", { ascending: false }).limit(120)
      .then(({ data }) => (data ?? []).map((x): LogRow => ({
        id: x.id, at: x.updated_at ?? x.created_at, kind: "Ticket", source: "app",
        summary: `${x.ticket_no} — ${x.subject}`,
        status: x.status === "resolved" || x.status === "closed" ? "ok"
          : x.priority === "urgent" ? "bad" : "warn",
      }))));
  }
  if (want("SMS")) {
    jobs.push(s.from("sms_logs")
      .select("id,to_phone,event,status,error,created_at").eq("isp_id", r.ispId)
      .order("created_at", { ascending: false }).limit(120)
      .then(({ data }) => (data ?? []).map((x): LogRow => ({
        id: x.id, at: x.created_at, kind: "SMS", source: "worker",
        summary: `${x.to_phone} — ${x.event ?? "message"}`,
        status: x.status === "failed" ? "bad" : x.status === "skipped" ? "warn" : "ok",
        detail: x.error ? { error: x.error } : undefined,
      }))));
  }
  if (want("Payment")) {
    jobs.push(s.from("payments")
      .select("id,amount,status,method,created_at,customers(customer_no,full_name)").eq("isp_id", r.ispId)
      .order("created_at", { ascending: false }).limit(120)
      .then(({ data }) => (data ?? []).map((x): LogRow => ({
        id: x.id, at: x.created_at, kind: "Payment", source: "app",
        summary: `KSh ${(x.amount / 100).toLocaleString("en-KE")} ${x.method} — ${
          one<{ full_name: string }>(x.customers)?.full_name ?? "customer"}`,
        status: x.status === "success" ? "ok" : x.status === "failed" ? "bad" : "warn",
      }))));
  }

  const merged = (await Promise.all(jobs)).flat()
    .sort((a, b) => ((a.at ?? "") < (b.at ?? "") ? 1 : -1))
    .slice(0, 300);

  const kinds: LogKind[] = ["Router", "Diagnostic", "Ticket", "SMS", "Payment"];
  return NextResponse.json({ log: merged, kinds });
}
