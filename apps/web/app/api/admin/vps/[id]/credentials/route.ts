import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin, getServer, credentialSchema, deriveCredentialStatus } from "@/lib/vps";
import { encryptSecret } from "@/lib/secrets";
import { audit } from "@/lib/platform-audit";
import { z } from "zod";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();

// POST /api/admin/vps/[id]/credentials — rotate the stored credential.
//
// This is the only path that writes credential_encrypted. The secret is
// encrypted here, audited by metadata only, and never echoed back. An empty
// string is not accepted: clearing a credential is an explicit DELETE-style
// action so that a stray whitespace paste cannot silently wipe it.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await requireAdmin();
  if ("error" in denied) return denied.error;

  const { id } = await params;
  if (!idSchema.safeParse(id).success) {
    return NextResponse.json({ error: "Invalid server id" }, { status: 400 });
  }

  const row = await getServer(id);
  if (!row) return NextResponse.json({ error: "Server not found" }, { status: 404 });

  const parsed = credentialSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 },
    );
  }
  const { auth_method, secret, expires_at } = parsed.data;

  let encrypted: string;
  try {
    encrypted = encryptSecret(secret);
  } catch (e) {
    // Almost always APP_ENCRYPTION_KEY missing or the wrong length. Surface the
    // reason — it is a server misconfiguration, not a user error.
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not encrypt the credential" },
      { status: 500 },
    );
  }

  const expiresAt = expires_at || null;
  const status = deriveCredentialStatus("active", expiresAt);
  const now = new Date().toISOString();

  const { error } = await createServiceClient().from("vps_servers").update({
    auth_method,
    credential_encrypted: encrypted,
    credential_status: status,
    credential_expires_at: expiresAt,
    credential_updated_at: now,
  }).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  await audit({
    action: "vps_credentials_changed",
    targetType: "vps_server", targetId: id, targetLabel: row.name,
    // Deliberately no secret, no length, no fingerprint — just the facts an
    // auditor needs: which method, and when it will need renewing.
    detail: { auth_method, expires_at: expiresAt, rotated_from: row.credential_status },
  });

  return NextResponse.json({
    ok: true,
    // Status only. The operator never gets the secret back.
    credential_status: status,
    credential_expires_at: expiresAt,
    credential_updated_at: now,
  });
}

// DELETE — remove the stored credential and mark the server unusable for
// remote access until a new one is added.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await requireAdmin();
  if ("error" in denied) return denied.error;

  const { id } = await params;
  const row = await getServer(id);
  if (!row) return NextResponse.json({ error: "Server not found" }, { status: 404 });

  const { error } = await createServiceClient().from("vps_servers").update({
    credential_encrypted: null,
    credential_status: "missing",
    credential_expires_at: null,
  }).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  await audit({
    action: "vps_credentials_changed",
    targetType: "vps_server", targetId: id, targetLabel: row.name,
    detail: { cleared: true },
  });
  return NextResponse.json({ ok: true, credential_status: "missing" });
}
