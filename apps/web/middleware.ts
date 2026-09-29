import { createServerClient, type SetAllCookies } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Mirrors lib/admin-auth.ts. Middleware cannot import that module because it
// pulls in next/headers, so the two rules live side by side and are kept in
// sync by hand: same cookie name, same HMAC scheme, same 8-hour window.
//
// This uses Web Crypto, not node:crypto — middleware runs on the Edge runtime,
// where Node built-ins are unavailable.
const ADMIN_COOKIE = "netpid_admin_session";

function adminSessionSecret(): string {
  return process.env.ADMIN_SESSION_SECRET ?? "netpid-admin-session-dev-secret";
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function isAdminRequest(req: NextRequest): Promise<boolean> {
  const token = req.cookies.get(ADMIN_COOKIE)?.value;
  if (!token) return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig || !/^\d+$/.test(exp)) return false;
  if (Number(exp) < Date.now()) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(adminSessionSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(exp));
  // Both sides are 64 hex chars, so a direct comparison is safe here.
  return sig === toHex(mac);
}

export async function middleware(req: NextRequest) {
  const res = NextResponse.next();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => req.cookies.getAll(),
        setAll: (all: Parameters<SetAllCookies>[0]) => { all.forEach(({ name, value, options }) => res.cookies.set(name, value, options)); },
      },
    }
  );
  const { data: { user } } = await supabase.auth.getUser();
  const path = req.nextUrl.pathname;

  // The admin console has its own credential and its own session, so it is
  // checked before — and independently of — the Supabase session above. An
  // ISP user must not reach it, and an admin must not need an ISP account.
  if (path.startsWith("/admin")) {
    if (await isAdminRequest(req)) return res;
    const url = req.nextUrl.clone();
    url.pathname = "/admin-login";
    url.searchParams.set("next", path);
    return NextResponse.redirect(url);
  }

  const guarded = path.startsWith("/dashboard") || path.startsWith("/platform-admin") || path.startsWith("/onboarding");
  if (guarded && !user) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", path);
    return NextResponse.redirect(url);
  }
  if (path.startsWith("/platform-admin")) {
    // Platform-admin check happens in layout (server) for full RLS enforcement;
    // middleware keeps session fresh. Do not gate on client claims here.
  }
  return res;
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/platform-admin/:path*",
    "/onboarding/:path*",
    // Match /admin exactly as well as its children, but NOT /admin-login —
    // a prefix matcher on "/admin" would also catch the login page and
    // redirect it to itself, an infinite loop.
    "/admin",
    "/admin/:path*",
  ],
};
