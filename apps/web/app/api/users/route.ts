import { NextResponse } from "next/server";
import { resolveIsp } from "@/lib/isp";
import { createServiceClient } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/secrets";
import { inviteStaffSchema, updateStaffSchema } from "@/lib/validation";

// Staff management for one ISP. App Router route files may only export HTTP
// verbs, so every helper below stays local. The service client is used for
// reads RLS hides from members (isp_user_roles) and for auth-user lookups;
// the ADMIN gate always runs first on the caller's own session via RPC.
type Svc = ReturnType<typeof createServiceClient>;

async function requireAdmin(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return { error: r.error as NextResponse };
  const { data, error } = await r.supabase.rpc("has_isp_role", {
    p_isp_id: r.ispId, p_role: "admin",
  });
  if (error) return { error: NextResponse.json({ error: error.message }, { status: 400 }) };
  if (data !== true) return { error: NextResponse.json({ error: "Admin access required" }, { status: 403 }) };
  return { ok: r }; // { supabase, user, ispId }
}

// GoTrue has no by-email admin lookup; scan a bounded number of pages. Staff
// directories are small (plan caps staff at 3–30) and auth.users only holds
// dashboard accounts — customers live in public.customers.
async function findUserByEmail(svc: Svc, email: string): Promise<string | null> {
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await svc.auth.admin.listUsers({ page, perPage: 100 });
    if (error || !data?.users?.length) return null;
    const hit = data.users.find((u) => (u.email ?? "").toLowerCase() === email);
    if (hit) return hit.id ?? null;
    if (data.users.length < 100) return null; // last page
  }
  return null;
}

// Emails live in auth.users, not isp_users — resolve them for the directory.
async function fetchEmails(svc: Svc, ids: string[]): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  await Promise.all(ids.map(async (id) => {
    try {
      const { data } = await svc.auth.admin.getUserById(id);
      out[id] = data?.user?.email ?? null;
    } catch {
      out[id] = null;
    }
  }));
  return out;
}

// Plan seat cap (netpid_plans.limits.staff; -1 = unlimited). No subscription
// row → no cap: never block on missing billing data.
async function staffLimit(svc: Svc, ispId: string): Promise<number | null> {
  const { data } = await svc.from("netpid_subscriptions")
    .select("netpid_plans(limits)")
    .eq("isp_id", ispId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const staff = (data as { netpid_plans?: { limits?: { staff?: unknown } } } | null)
    ?.netpid_plans?.limits?.staff;
  return typeof staff === "number" && staff >= 0 ? staff : null;
}

// PostgREST types an embedded many-to-one as an array, so normalize both shapes
// and keep the caller logic shape-agnostic.
type RoleEmbed = { id?: string; slug?: string; name?: string };

function roleSlugs(embed: RoleEmbed | RoleEmbed[] | null | undefined): string[] {
  if (!embed) return [];
  return (Array.isArray(embed) ? embed : [embed])
    .map((r) => r?.slug)
    .filter((s): s is string => typeof s === "string");
}

// GET /api/users — member directory with roles, emails, and seat cap.
// Admin only: it exposes every staff member's auth email.
export async function GET(req: Request) {
  const a = await requireAdmin(req);
  if ("error" in a) return a.error;
  const { ispId, user } = a.ok;
  const svc = createServiceClient();

  const [{ data: members, error: mErr }, { data: roleCatalog }, limit] = await Promise.all([
    svc.from("isp_users")
      .select("id, user_id, full_name, phone, is_active, created_at")
      .eq("isp_id", ispId)
      .order("created_at", { ascending: true }),
    svc.from("isp_roles").select("slug, name, description").order("slug"),
    staffLimit(svc, ispId),
  ]);
  if (mErr) return NextResponse.json({ error: mErr.message }, { status: 400 });

  const list = (members ?? []) as {
    id: string; user_id: string; full_name: string | null; phone: string | null;
    is_active: boolean; created_at: string;
  }[];

  type Assignment = { isp_user_id: string; isp_roles: RoleEmbed | RoleEmbed[] | null };
  const assignments: Assignment[] = [];
  if (list.length) {
    const { data: rows, error: aErr } = await svc.from("isp_user_roles")
      .select("isp_user_id, isp_roles(id, slug, name)")
      .in("isp_user_id", list.map((m) => m.id));
    if (aErr) return NextResponse.json({ error: aErr.message }, { status: 400 });
    assignments.push(...((rows ?? []) as Assignment[]));
  }
  const rolesByMember: Record<string, RoleEmbed[]> = {};
  for (const row of assignments) {
    const slugs = roleSlugs(row.isp_roles);
    if (!slugs.length) continue;
    (rolesByMember[row.isp_user_id] ??= []).push({ slug: slugs[0], name: slugs[0] });
  }
  const emails = await fetchEmails(svc, list.map((m) => m.user_id));

  return NextResponse.json({
    members: list.map((m) => ({
      ...m,
      email: emails[m.user_id] ?? null,
      roles: rolesByMember[m.id] ?? [],
    })),
    roles: roleCatalog ?? [],
    me: user.id,
    staff_limit: limit,
  });
}

// POST /api/users — invite/add a staff member and assign a role.
export async function POST(req: Request) {
  const a = await requireAdmin(req);
  if ("error" in a) return a.error;
  const { ispId } = a.ok;

  const parsed = inviteStaffSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", issues: parsed.error.flatten() }, { status: 400 });
  }
  const { email, full_name, role } = parsed.data;
  const normalizedEmail = email.trim().toLowerCase();

  const svc = createServiceClient();
  const allowed = await checkRateLimit(svc, svc, `staff-invite:${ispId}`, 20, 3600);
  if (!allowed) return NextResponse.json({ error: "Rate limited. Try again later." }, { status: 429 });

  // Enforce the plan seat cap BEFORE touching auth.
  const limit = await staffLimit(svc, ispId);
  if (limit !== null) {
    const { count } = await svc.from("isp_users")
      .select("id", { count: "exact", head: true })
      .eq("isp_id", ispId);
    if ((count ?? 0) >= limit) {
      return NextResponse.json(
        { error: `Your plan includes ${limit} staff seat${limit === 1 ? "" : "s"}. Upgrade to invite more.` },
        { status: 402 },
      );
    }
  }

  const { data: roleRow } = await svc.from("isp_roles")
    .select("id, slug").eq("slug", role).maybeSingle();
  if (!roleRow) return NextResponse.json({ error: "Unknown role" }, { status: 400 });

  // Existing account → attach directly (no email). New account → invite, which
  // creates the auth user and emails a set-password link. If the invite fails
  // after user creation (SMTP), fall back to lookup and still attach.
  let userId: string | null = await findUserByEmail(svc, normalizedEmail);
  let emailSent = false;
  let message: string;
  if (userId) {
    message = "Existing account added to your team. No invite email was sent.";
  } else {
    const { data, error } = await svc.auth.admin.inviteUserByEmail(normalizedEmail, {
      data: { full_name: full_name || undefined, invited_isp: ispId },
    });
    if (data?.user?.id) {
      userId = data.user.id;
      emailSent = true;
      message = `Invite sent to ${normalizedEmail}.`;
    } else {
      userId = await findUserByEmail(svc, normalizedEmail);
      if (!userId) {
        return NextResponse.json(
          { error: error?.message ?? "Could not invite that user." },
          { status: 400 },
        );
      }
      message = "Account created, but the invite email could not be sent. Ask them to use Forgot password.";
    }
  }

  const { data: existing } = await svc.from("isp_users")
    .select("id").eq("isp_id", ispId).eq("user_id", userId).maybeSingle();
  if (existing) {
    return NextResponse.json({ error: "That person is already a member of this ISP." }, { status: 409 });
  }

  const { data: iu, error: iuErr } = await svc.from("isp_users")
    .insert({ isp_id: ispId, user_id: userId, full_name: full_name || null })
    .select("id, user_id, full_name, is_active, created_at")
    .single();
  if (iuErr) {
    if (iuErr.code === "23505") {
      return NextResponse.json({ error: "That person is already a member of this ISP." }, { status: 409 });
    }
    return NextResponse.json({ error: iuErr.message }, { status: 400 });
  }

  const { error: roleErr } = await svc.from("isp_user_roles")
    .insert({ isp_user_id: iu.id, role_id: roleRow.id });
  if (roleErr) {
    // Don't leave a roleless member behind on a failed assignment.
    await svc.from("isp_users").delete().eq("id", iu.id);
    return NextResponse.json({ error: roleErr.message }, { status: 400 });
  }

  return NextResponse.json({
    member: { ...iu, email: normalizedEmail, roles: [{ slug: role, name: role }] },
    email_sent: emailSent,
    message,
  }, { status: 201 });
}

// PATCH /api/users — rename, activate/deactivate, or change a member's role.
export async function PATCH(req: Request) {
  const a = await requireAdmin(req);
  if ("error" in a) return a.error;
  const { ispId, user } = a.ok;

  const parsed = updateStaffSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", issues: parsed.error.flatten() }, { status: 400 });
  }
  const { id, ...changes } = parsed.data;
  const svc = createServiceClient();

  const { data: target, error: tErr } = await svc.from("isp_users")
    .select("id, user_id, is_active")
    .eq("id", id).eq("isp_id", ispId).maybeSingle();
  if (tErr) return NextResponse.json({ error: tErr.message }, { status: 400 });
  if (!target) return NextResponse.json({ error: "Member not found." }, { status: 404 });

  const touchesAccess = changes.is_active !== undefined || changes.role !== undefined;
  if (target.user_id === user.id && touchesAccess) {
    return NextResponse.json({ error: "You cannot change your own access. Ask another admin." }, { status: 400 });
  }
  if (touchesAccess) {
    const { data: tRoles } = await svc.from("isp_user_roles")
      .select("isp_roles(slug)").eq("isp_user_id", target.id);
    if (roleSlugs(tRoles?.[0]?.isp_roles).includes("owner")) {
      return NextResponse.json({ error: "The ISP owner's access cannot be changed here." }, { status: 403 });
    }
  }

  const patch: Record<string, unknown> = {};
  if (changes.full_name !== undefined) patch.full_name = changes.full_name || null;
  if (changes.phone !== undefined) patch.phone = changes.phone || null;
  if (changes.is_active !== undefined) patch.is_active = changes.is_active;
  if (Object.keys(patch).length) {
    const { error: uErr } = await svc.from("isp_users")
      .update(patch).eq("id", target.id).eq("isp_id", ispId);
    if (uErr) return NextResponse.json({ error: uErr.message }, { status: 400 });
  }

  if (changes.role !== undefined) {
    const { data: roleRow } = await svc.from("isp_roles")
      .select("id").eq("slug", changes.role).maybeSingle();
    if (!roleRow) return NextResponse.json({ error: "Unknown role" }, { status: 400 });
    const { error: dErr } = await svc.from("isp_user_roles")
      .delete().eq("isp_user_id", target.id);
    if (dErr) return NextResponse.json({ error: dErr.message }, { status: 400 });
    const { error: rErr } = await svc.from("isp_user_roles")
      .insert({ isp_user_id: target.id, role_id: roleRow.id });
    if (rErr) return NextResponse.json({ error: rErr.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}

// DELETE /api/users?id= — remove the membership (roles cascade). The auth
// account itself stays: it may belong to other ISPs or own this one.
export async function DELETE(req: Request) {
  const a = await requireAdmin(req);
  if ("error" in a) return a.error;
  const { ispId, user } = a.ok;

  const id = new URL(req.url).searchParams.get("id");
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return NextResponse.json({ error: "Member id required" }, { status: 400 });
  }

  const svc = createServiceClient();
  const { data: target } = await svc.from("isp_users")
    .select("id, user_id").eq("id", id).eq("isp_id", ispId).maybeSingle();
  if (!target) return NextResponse.json({ error: "Member not found." }, { status: 404 });
  if (target.user_id === user.id) {
    return NextResponse.json({ error: "You cannot remove your own membership." }, { status: 400 });
  }

  const { data: tRoles } = await svc.from("isp_user_roles")
    .select("isp_roles(slug)").eq("isp_user_id", target.id);
  if (roleSlugs(tRoles?.[0]?.isp_roles).includes("owner")) {
    return NextResponse.json({ error: "The ISP owner cannot be removed here." }, { status: 403 });
  }

  const { error: dErr } = await svc.from("isp_users")
    .delete().eq("id", target.id).eq("isp_id", ispId);
  if (dErr) return NextResponse.json({ error: dErr.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
