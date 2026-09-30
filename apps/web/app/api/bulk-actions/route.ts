// Bulk actions over customers. Every batch is written to bulk_jobs so an
// operator can see exactly what ran and what failed, and every target id is
// re-checked against the caller's ISP inside the transaction.
import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { resolveIsp } from "@/lib/isp";
import { z } from "zod";
import { renderTemplate } from "@/lib/sms-templates";

const runSchema = z.object({
  kind: z.enum(["suspend", "resume", "expire", "extend", "notify_expiry"]),
  customer_ids: z.array(z.string().uuid()).min(1).max(2000),
  // "extend" only.
  days: z.coerce.number().int().min(1).max(3650).optional(),
});

export async function GET(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const { data } = await r.supabase
    .from("bulk_jobs")
    .select("id,kind,total,succeeded,failed,status,detail,created_at,finished_at")
    .eq("isp_id", r.ispId).order("created_at", { ascending: false }).limit(50);
  return NextResponse.json({ jobs: data ?? [] });
}

export async function POST(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const parsed = runSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Select at least one customer" }, { status: 400 });
  }
  const { kind, customer_ids, days } = parsed.data;
  const svc = createServiceClient();

  const { data: job } = await svc.from("bulk_jobs").insert({
    isp_id: r.ispId, kind, payload: { customer_ids, days: days ?? null },
    total: customer_ids.length, status: "running", created_by: r.user.id,
  }).select("id").single();

  // Read back only this ISP's rows; a cross-tenant id in the payload is
  // dropped rather than acted on.
  const { data: targets } = await svc.from("customers")
    .select("id,customer_no,full_name,status,expiry_date,phone")
    .eq("isp_id", r.ispId).in("id", customer_ids);
  const found = targets ?? [];

  let succeeded = 0;
  const failures: { customer_no: string; reason: string }[] = [];

  for (const c of found) {
    if (kind === "extend" && days) {
      const base = c.expiry_date ? new Date(c.expiry_date) : new Date();
      // Extending an already-expired account must start from now, not from a
      // date in the past — otherwise the customer stays dead after a "renew".
      if (base.getTime() < Date.now()) base.setTime(Date.now());
      base.setDate(base.getDate() + days);
      const { error } = await svc.from("customers").update({
        expiry_date: base.toISOString(), status: "active",
      }).eq("id", c.id).eq("isp_id", r.ispId);
      if (error) { failures.push({ customer_no: c.customer_no, reason: error.message }); continue; }
      succeeded++;
    } else if (kind === "suspend" && c.status !== "suspended") {
      const { error } = await svc.from("customers").update({ status: "suspended" })
        .eq("id", c.id).eq("isp_id", r.ispId);
      if (error) { failures.push({ customer_no: c.customer_no, reason: error.message }); continue; }
      succeeded++;
    } else if (kind === "resume" && c.status === "suspended") {
      const { error } = await svc.from("customers").update({ status: "active" })
        .eq("id", c.id).eq("isp_id", r.ispId);
      if (error) { failures.push({ customer_no: c.customer_no, reason: error.message }); continue; }
      succeeded++;
    } else if (kind === "expire" && !["expired", "suspended", "terminated"].includes(c.status)) {
      const { error } = await svc.from("customers")
        .update({ status: "expired", expiry_date: new Date().toISOString() })
        .eq("id", c.id).eq("isp_id", r.ispId);
      if (error) { failures.push({ customer_no: c.customer_no, reason: error.message }); continue; }
      succeeded++;
    } else if (kind === "notify_expiry") {
      succeeded++; // counted below via the SMS path
    } else {
      failures.push({ customer_no: c.customer_no, reason: "Already in that state" });
    }
  }

  // notify_expiry: queue the message in sms_logs. The network-worker owns the
  // actual provider call and drains this queue, so a bulk run here never blocks
  // on a third-party API (and the existing sender ID + rate limits still apply).
  // Without an active provider the rows are still written but pre-marked
  // "skipped", so the work is visible rather than silently dropped.
  if (kind === "notify_expiry" && found.length) {
    const { data: provider } = await svc.from("sms_providers")
      .select("status").eq("isp_id", r.ispId).eq("provider", "topspeed").maybeSingle();
    const sendable = provider?.status === "active";

    // One template read for the whole run. The stored template wins when there
    // is one, so editing it changes what subscribers get; the inline wording is
    // only a fallback for an ISP that has never touched the defaults.
    const [{ data: tpl }, { data: isp }] = await Promise.all([
      svc.from("sms_templates").select("body, enabled").eq("isp_id", r.ispId)
        .eq("event", "expiry_reminder").eq("locale", "en").maybeSingle(),
      svc.from("isps").select("name").eq("id", r.ispId).maybeSingle(),
    ]);
    // A disabled template means "do not send this event", not "use the default".
    const templateOff = tpl !== null && tpl !== undefined && tpl.enabled === false;
    const fallbackBody =
      "Hi {{name}}, your {{isp}} subscription ({{customer_no}}) expires soon. Renew to stay online.";

    const rows = found
      .filter((c) => c.phone)
      .map((c) => ({
        isp_id: r.ispId,
        to_phone: c.phone as string,
        event: "expiry_reminder",
        body: renderTemplate(tpl?.body ?? fallbackBody, {
          name: c.full_name ?? "",
          customer_no: c.customer_no ?? "",
          phone: c.phone as string,
          isp: isp?.name ?? "",
          expiry: c.expiry_date ? new Date(c.expiry_date).toLocaleDateString("en-KE") : "",
        }),
        status: templateOff
          ? "skipped" as const
          : sendable ? "queued" as const : "skipped" as const,
        error: templateOff
          ? "Template disabled — nothing sent"
          : sendable ? null : "SMS provider not active — enable it under SMS",
      }));
    if (rows.length) {
      const { error } = await svc.from("sms_logs").insert(rows);
      if (error) {
        failures.push({ customer_no: "SMS queue", reason: error.message });
      } else {
        succeeded = rows.length;
      }
    }
    for (const c of found.filter((x) => !x.phone)) {
      failures.push({ customer_no: c.customer_no, reason: "No phone on file" });
    }
  }

  const missing = customer_ids.length - found.length;
  if (missing > 0) {
    failures.push({ customer_no: `${missing} row(s)`, reason: "Not found in your ISP" });
  }

  const status = failures.length && !succeeded ? "failed" : "done";
  await svc.from("bulk_jobs").update({
    succeeded, failed: failures.length, status,
    detail: { failures: failures.slice(0, 50) },
    finished_at: new Date().toISOString(),
  }).eq("id", job?.id ?? "");

  return NextResponse.json({
    job_id: job?.id, total: customer_ids.length, succeeded, failed: failures.length,
    failures: failures.slice(0, 50), status,
  });
}
