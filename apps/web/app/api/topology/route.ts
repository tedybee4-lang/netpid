import { resolveIsp } from "@/lib/isp";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const { supabase, ispId, error } = await resolveIsp(req);
  if (error) return error;

  const { data, error: dbErr } = await supabase
    .from("network_nodes")
    .select("*, routers(name, host)")
    .eq("isp_id", ispId)
    .order("created_at", { ascending: true });

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 400 });
  return NextResponse.json({ nodes: data ?? [] });
}

export async function POST(req: Request) {
  const { supabase, ispId, error } = await resolveIsp(req);
  if (error) return error;

  const body = await req.json().catch(() => ({}));
  const { name, node_type, parent_node_id, router_id, address, latitude, longitude } = body;

  if (!name || !node_type) {
    return NextResponse.json({ error: "Node name and type are required" }, { status: 400 });
  }

  const { data, error: dbErr } = await supabase
    .from("network_nodes")
    .insert({
      isp_id: ispId,
      name,
      node_type,
      parent_node_id: parent_node_id || null,
      router_id: router_id || null,
      address: address || null,
      latitude: latitude ? Number(latitude) : null,
      longitude: longitude ? Number(longitude) : null,
      status: "operational",
    })
    .select()
    .single();

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 400 });
  return NextResponse.json({ node: data }, { status: 201 });
}
