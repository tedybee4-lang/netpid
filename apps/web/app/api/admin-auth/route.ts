import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { verifyAdminCredentials, setAdminSession, clearAdminSession, isAdmin } from "@/lib/admin-auth";
import { checkRateLimit } from "@/lib/secrets";
import { z } from "zod";

const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

// Brute-force protection for a fixed, publicly-known credential. Without this
// the password is only as strong as the network path to this endpoint.
const WINDOW_SEC = 900;
const MAX_ATTEMPTS = 8;

export async function POST(req: Request) {
  const parsed = loginSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Enter a username and password" }, { status: 400 });
  }

  // Key on the submitted username plus the caller's IP, so one attacker cannot
  // lock out the real operator by hammering a known username from elsewhere.
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const svc = createServiceClient();
  const key = `admin_login:${ip}:${parsed.data.username.toLowerCase()}`;

  const allowed = await checkRateLimit(svc, svc, key, MAX_ATTEMPTS, WINDOW_SEC);
  if (!allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Wait 15 minutes and try again." },
      { status: 429 },
    );
  }

  if (!verifyAdminCredentials(parsed.data.username, parsed.data.password)) {
    // One message for both a wrong username and a wrong password: revealing
    // which one was wrong confirms the username to someone guessing.
    return NextResponse.json({ error: "Incorrect username or password" }, { status: 401 });
  }

  await setAdminSession();

  // Record who signed in, and from where. Best-effort: if the audit write
  // fails the login still succeeds, because locking the operator out of their
  // own platform over a logging hiccup is worse than a missing log line.
  await svc.from("system_health").insert({
    component: "admin_login",
    status: "online",
    detail: { username: parsed.data.username, ip, at: new Date().toISOString() },
  });

  return NextResponse.json({ ok: true });
}

export async function GET() {
  return NextResponse.json({ authenticated: await isAdmin() });
}

export async function DELETE() {
  await clearAdminSession();
  return NextResponse.json({ ok: true });
}
