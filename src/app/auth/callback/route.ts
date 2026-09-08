import { NextResponse,type NextRequest } from "next/server";
import { createSupabase } from "@/server/supabase";
import { config } from "@/lib/env";
import { safeAuthDestination } from "@/domain/auth";
export async function GET(request:NextRequest){
 const env=config();const code=request.nextUrl.searchParams.get("code");
 if(env.configured&&code){const client=await createSupabase();const {error}=await client.auth.exchangeCodeForSession(code);if(!error)return NextResponse.redirect(new URL(safeAuthDestination(request.nextUrl.searchParams.get("next")),env.appUrl));}
 return NextResponse.redirect(new URL("/login?error=link-expired",env.appUrl));
}
