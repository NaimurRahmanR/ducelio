import { NextResponse, type NextRequest } from "next/server";
import { createSupabase } from "@/server/supabase";
import { config } from "@/lib/env";
import {
  confirmationTypeSchema,
  EMAIL_CHANGE_CONFIRMED_PATH,
  safeAuthDestination,
} from "@/domain/auth";

// Destinations are fixed per type: recovery always goes to the reset form and
// a verified email change always returns to the profile (the address itself
// is never trusted from the URL; Supabase Auth applies it). Only a sign-up
// confirmation honours the bounded `next` allowlist.
function destination(type: string, next: string | null) {
  if (type === "recovery") return "/reset-password";
  if (type === "email_change") return EMAIL_CHANGE_CONFIRMED_PATH;
  return safeAuthDestination(next);
}

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
          destination(type.data, request.nextUrl.searchParams.get("next")),
          env.appUrl,
        ),
      );
  }
  return NextResponse.redirect(
    new URL("/login?error=link-expired", env.appUrl),
  );
}
