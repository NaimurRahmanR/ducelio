import { NextResponse, type NextRequest } from "next/server";
import { createSupabase } from "@/server/supabase";
import { config } from "@/lib/env";
import { safeAuthDestination } from "@/domain/auth";
import { logOAuthCallback } from "@/server/oauth-diagnostics";
import { signedInHome } from "@/server/sign-in-home";
export async function GET(request: NextRequest) {
  const env = config();
  const code = request.nextUrl.searchParams.get("code");
  // Development-only diagnostic input: incoming cookie NAMES only, captured
  // before the exchange consumes the PKCE verifier.
  const diagnostic = {
    configured: env.configured,
    params: request.nextUrl.searchParams,
    requestHost: request.headers.get("host"),
    appUrl: env.appUrl,
    cookieNames: request.cookies.getAll().map((cookie) => cookie.name),
  };
  if (env.configured && code) {
    const client = await createSupabase();
    const flowId = request.nextUrl.searchParams.get("sb_flow_id");
    const { error } = await client.auth.exchangeCodeForSession(
      code,
      flowId ? { flowId } : undefined,
    );
    logOAuthCallback({ ...diagnostic, exchangeAttempted: true, error });
    if (!error) {
      const explicit = safeAuthDestination(
        request.nextUrl.searchParams.get("next"),
        "",
      );
      return NextResponse.redirect(
        new URL(explicit || (await signedInHome(client)), env.appUrl),
      );
    }
  } else
    logOAuthCallback({ ...diagnostic, exchangeAttempted: false, error: null });
  return NextResponse.redirect(
    new URL("/login?error=link-expired", env.appUrl),
  );
}
