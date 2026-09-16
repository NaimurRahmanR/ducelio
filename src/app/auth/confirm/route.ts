import { NextResponse, type NextRequest } from "next/server";
import { createSupabase } from "@/server/supabase";
import { config } from "@/lib/env";
import { confirmationTypeSchema, safeAuthDestination } from "@/domain/auth";
export async function GET(request: NextRequest) {
  const env = config();
  const token_hash = request.nextUrl.searchParams.get("token_hash");
  const type = confirmationTypeSchema.safeParse(
    request.nextUrl.searchParams.get("type"),
  );
  if (env.configured && token_hash && type.success) {
    const client = await createSupabase();
    const { error } = await client.auth.verifyOtp({
      token_hash,
      type: type.data,
    });
    if (!error)
      return NextResponse.redirect(
        new URL(
          type.data === "recovery"
            ? "/reset-password"
            : safeAuthDestination(request.nextUrl.searchParams.get("next")),
          env.appUrl,
        ),
      );
  }
  return NextResponse.redirect(
    new URL("/login?error=link-expired", env.appUrl),
  );
}
