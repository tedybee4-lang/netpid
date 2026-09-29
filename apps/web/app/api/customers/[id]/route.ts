import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { resolveIsp } from "@/lib/isp";
import { updateCustomerSpeedSchema } from "@/lib/validation";
import { checkRateLimit } from "@/lib/secrets";

// PATCH /api/customers/[id] — per-customer speed cap (separate download/upload).
//
// The DB trigger (provision_customer_rate_group, migration 0034) creates the
// customer's own RADIUS group carrying this rate limit, points their login at
// it and marks the user pending — the worker syncs it to radgroupreply, and a
// `router-apply-rate` job can push the same pair as a simple queue.
// Setting BOTH fields to null clears the override: the dedicated group is
// dropped and the login falls back to the package group.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;

  const body = await req.json().catch(() => ({}));
  const parsed = updateCustomerSpeedSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", issues: parsed.error.flatten() }, { status: 400 });
  }

  const svc = createServiceClient();
  const ok = await checkRateLimit(svc, svc, `customer-speed:${r.ispId}`, 30, 3600);
  if (!ok) return NextResponse.json({ error: "Rate limited." }, { status: 429 });

  const { data: customer } = await svc.from("customers").select("id")
    .eq("id", id).eq("isp_id", r.ispId).maybeSingle();
  if (!customer) return NextResponse.json({ error: "Customer not found" }, { status: 404 });

  const patch: { download_kbps: number | null; upload_kbps: number | null } = {
    download_kbps: null,
    upload_kbps: null,
  };
  if (parsed.data.download_mbps != null && parsed.data.download_mbps > 0) {
    patch.download_kbps = Math.round(parsed.data.download_mbps * 1000);
  }
  if (parsed.data.upload_mbps != null && parsed.data.upload_mbps > 0) {
    patch.upload_kbps = Math.round(parsed.data.upload_mbps * 1000);
  }

  const { error } = await svc.from("customers").update(patch).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({
    customer_id: id,
    download_kbps: patch.download_kbps,
    upload_kbps: patch.upload_kbps,
    overridden: patch.download_kbps != null || patch.upload_kbps != null,
    message: patch.download_kbps == null && patch.upload_kbps == null
      ? "Override cleared — the customer inherits their package again."
      : "Speed override saved — RADIUS group re-sync queued.",
  });
}
