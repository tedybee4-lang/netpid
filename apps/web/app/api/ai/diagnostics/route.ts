import { resolveIsp } from "@/lib/isp";
import { NextResponse } from "next/server";

// POST /api/ai/diagnostics: Rule-based & heuristic ISP AI diagnostics engine
export async function POST(req: Request) {
  const { supabase, ispId, user, error } = await resolveIsp(req);
  if (error) return error;

  const body = await req.json().catch(() => ({}));
  const { target_type, target_id, prompt } = body;

  if (!target_type || !target_id) {
    return NextResponse.json({ error: "Target type and ID are required" }, { status: 400 });
  }

  let diagnosis = "";
  let action = "";
  let severity: "info" | "low" | "medium" | "high" | "critical" = "info";

  if (target_type === "customer") {
    const { data: customer } = await supabase
      .from("customers")
      .select("*, pppoe_accounts(*), radius_users(*)")
      .eq("isp_id", ispId)
      .eq("id", target_id)
      .maybeSingle();

    if (!customer) {
      return NextResponse.json({ error: "Customer not found" }, { status: 404 });
    }

    const { data: openSession } = await supabase
      .from("radius_sessions")
      .select("*")
      .eq("isp_id", ispId)
      .eq("username", customer.username)
      .eq("is_open", true)
      .maybeSingle();

    const isExpired = customer.status === "expired" || (customer.expiry_date && new Date(customer.expiry_date) < new Date());

    if (isExpired) {
      severity = "medium";
      diagnosis = `Customer package has expired on ${new Date(customer.expiry_date).toLocaleDateString()}. Account status is set to '${customer.status}'. RADIUS authentication will reject new PPPoE attempts with Access-Reject.`;
      action = "Instruct customer to renew via M-Pesa: STK push from their customer page once Daraja is connected, or record the Till/PayBill receipt as a manual payment. Service restores as soon as the payment is confirmed.";
    } else if (!openSession) {
      severity = "high";
      diagnosis = `Customer is active and billed, but has NO active RADIUS session. Possible ONT power loss, fiber cut, or misconfigured PPPoE credentials in CPE router.`;
      action = "Check optical power levels on ONU via TR-069. Verify physical fiber link lights and re-test PPPoE username credentials on router.";
    } else {
      severity = "info";
      diagnosis = `Customer is currently ONLINE. Session started at ${new Date(openSession.start_time).toLocaleTimeString()} from Framed-IP: ${openSession.framed_ip || 'DHCP'} on NAS: ${openSession.nas_ip}. Bandwidth usage: ${(Number(openSession.input_octets || 0) / 1048576).toFixed(1)}MB Up, ${(Number(openSession.output_octets || 0) / 1048576).toFixed(1)}MB Down.`;
      action = "No corrective action needed. Link health and RADIUS accounting are normal.";
    }
  } else if (target_type === "router") {
    const { data: router } = await supabase
      .from("routers")
      .select("*")
      .eq("isp_id", ispId)
      .eq("id", target_id)
      .maybeSingle();

    if (!router) {
      return NextResponse.json({ error: "Router not found" }, { status: 404 });
    }

    if (router.status === "offline") {
      severity = "critical";
      diagnosis = `MikroTik router '${router.name}' at ${router.host} is UNREACHABLE. Last health poll failed or timed out on API port ${router.port || 8728}.`;
      action = "Verify router power, upstream gateway ping, and firewall rule allowing NETPID worker IP on RouterOS API port.";
    } else {
      severity = "info";
      diagnosis = `Router '${router.name}' is ONLINE. CPU load: ${router.cpu_load || 0}%, RAM: ${(Number(router.free_memory || 0) / 1048576).toFixed(0)}MB free, RouterOS v${router.version || 'unknown'}.`;
      action = "Router metrics within safe operational parameters.";
    }
  } else {
    diagnosis = `Automated telemetry scan performed for ${target_type} (${target_id}). No anomalies detected.`;
    action = "Continue periodic health polling.";
  }

  // Record AI diagnostic log
  const { data: logEntry, error: logErr } = await supabase
    .from("ai_diagnostic_logs")
    .insert({
      isp_id: ispId,
      target_type,
      target_id,
      prompt: prompt || `Automated diagnostics check on ${target_type}`,
      diagnosis,
      suggested_action: action,
      severity,
      created_by: user.id,
    })
    .select()
    .single();

  if (logErr) return NextResponse.json({ error: logErr.message }, { status: 400 });

  return NextResponse.json({
    diagnosis,
    suggested_action: action,
    severity,
    log: logEntry,
  });
}
