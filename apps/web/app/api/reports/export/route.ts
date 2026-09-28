import { resolveIsp } from "@/lib/isp";
import { NextResponse } from "next/server";

// GET /api/reports/export?kind=revenue|customers|usage
export async function GET(req: Request) {
  const { supabase, ispId, error } = await resolveIsp(req);
  if (error) return error;

  const kind = new URL(req.url).searchParams.get("kind") ?? "revenue";
  let csv = "";
  let filename = `report-${kind}-${new Date().toISOString().slice(0, 10)}.csv`;

  if (kind === "revenue") {
    const { data: payments } = await supabase.from("payments")
      .select("reference, mpesa_receipt, amount, phone, status, paid_at")
      .eq("isp_id", ispId).order("created_at", { ascending: false }).limit(2000);
    csv = "Reference,M-Pesa Receipt,Amount KSh,Phone,Status,Paid At\n" +
      (payments ?? []).map((p) =>
        `"${p.reference ?? ""}","${p.mpesa_receipt ?? ""}",${((p.amount ?? 0) / 100).toFixed(2)},"${p.phone ?? ""}","${p.status}","${p.paid_at ?? ""}"`
      ).join("\n");
  } else if (kind === "customers") {
    const { data: customers } = await supabase.from("customers")
      .select("account_number, full_name, phone, username, connection_type, status, expiry_date, balance")
      .eq("isp_id", ispId).order("created_at", { ascending: false }).limit(2000);
    csv = "Account,Name,Phone,Username,Type,Status,Expiry,Balance KSh\n" +
      (customers ?? []).map((c) =>
        `"${c.account_number ?? ""}","${(c.full_name ?? "").replace(/"/g, '""')}","${c.phone ?? ""}","${c.username ?? ""}","${c.connection_type}","${c.status}","${c.expiry_date ?? ""}",${((c.balance ?? 0) / 100).toFixed(2)}`
      ).join("\n");
  } else if (kind === "usage") {
    const { data: usage } = await supabase.from("data_usage")
      .select("day, upload_bytes, download_bytes, session_seconds, sessions")
      .eq("isp_id", ispId).order("day", { ascending: false }).limit(2000);
    csv = "Day,Upload MB,Download MB,Total MB,Sessions,Duration Minutes\n" +
      (usage ?? []).map((u) => {
        const upMb = (Number(u.upload_bytes ?? 0) / 1048576).toFixed(2);
        const dnMb = (Number(u.download_bytes ?? 0) / 1048576).toFixed(2);
        const totMb = ((Number(u.upload_bytes ?? 0) + Number(u.download_bytes ?? 0)) / 1048576).toFixed(2);
        const mins = (Number(u.session_seconds ?? 0) / 60).toFixed(1);
        return `"${u.day}",${upMb},${dnMb},${totMb},${u.sessions ?? 0},${mins}`;
      }).join("\n");
  } else {
    return NextResponse.json({ error: "Unknown kind. Choose: revenue, customers, usage" }, { status: 400 });
  }

  return new NextResponse(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}
