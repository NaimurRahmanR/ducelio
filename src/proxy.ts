import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { config as readConfig } from "@/lib/env";
export async function proxy(request: NextRequest) {
  const env = readConfig();
  let response = NextResponse.next({ request });
  response.headers.set("Cache-Control", "private, no-store");
  const protectedPage = /^\/(student|support|admin)(\/|$)/.test(
    request.nextUrl.pathname,
  );
  if (!env.configured)
    return protectedPage
      ? NextResponse.redirect(new URL("/login", env.appUrl))
      : response;
  // Callback routes validate their own one-time codes; do not refresh an old session first.
  if (request.nextUrl.pathname.startsWith("/auth/")) return response;
  const client = createServerClient(env.url, env.key, {
    cookieOptions: {
      httpOnly: true,
      sameSite: "lax",
      secure: env.appUrl.startsWith("https://"),
      path: "/",
    },
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(values) {
        for (const { name, value } of values) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of values)
          response.cookies.set(name, value, options);
        response.headers.set("Cache-Control", "private, no-store");
      },
    },
  });
  const {
    data: { user },
    error,
  } = await client.auth.getUser();
  if (protectedPage && (error || !user || !user.email_confirmed_at)) {
    const denied = NextResponse.redirect(new URL("/login", env.appUrl));
    for (const cookie of response.cookies.getAll()) denied.cookies.set(cookie);
    denied.headers.set("Cache-Control", "private, no-store");
    return denied;
  }
  return response;
}
export const config = {
  matcher: [
    "/student/:path*",
    "/support/:path*",
    "/admin/:path*",
    "/login",
    "/signup",
    "/verify-email",
    "/forgot-password",
    "/reset-password",
    "/auth/:path*",
    "/api/:path*",
  ],
};
