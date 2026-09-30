import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import PackageEditor from "./PackageEditor";

export default async function PackageDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: memberships } = await supabase.from("isp_users").select("isp_id").limit(1);
  const ispId = memberships?.[0]?.isp_id as string | undefined;
  if (!ispId) notFound();

  const { data: pkg } = await supabase.from("packages")
    .select("*").eq("id", id).eq("isp_id", ispId).maybeSingle();
  if (!pkg) notFound();

  // The RADIUS group is created by a trigger alongside the package, so it should
  // always be here; a package without one is shown as such rather than hidden.
  const { data: group } = await supabase.from("radius_groups")
    .select("id,group_name,service_type").eq("package_id", id).maybeSingle();
  const attributes = group
    ? ((await supabase.from("radius_group_attributes")
      .select("id,attribute,op,value")
      .eq("group_id", group.id).order("attribute")).data ?? [])
    : [];

  return <PackageEditor pkg={pkg} group={group} initialAttributes={attributes} />;
}
