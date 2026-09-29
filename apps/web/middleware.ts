import { createServerClient, type SetAllCookies } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

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
  matcher: ["/dashboard/:path*", "/platform-admin/:path*", "/onboarding/:path*"],
};
