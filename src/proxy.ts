import { createServerClient } from "@supabase/ssr";
import { NextResponse,type NextRequest } from "next/server";
import { config as readConfig } from "@/lib/env";
export async function proxy(request:NextRequest) {
 const env=readConfig();
 let response=NextResponse.next({request});
 response.headers.set("Cache-Control","private, no-store");
 if(!env.configured) return response;
 const client=createServerClient(env.url,env.key,{
  cookieOptions:{httpOnly:true,sameSite:"lax",secure:env.appUrl.startsWith("https://"),path:"/"},
  cookies:{getAll:()=>request.cookies.getAll(),setAll(values){
   for(const {name,value} of values) request.cookies.set(name,value);
   response=NextResponse.next({request});
   for(const {name,value,options} of values) response.cookies.set(name,value,options);
   response.headers.set("Cache-Control","private, no-store");
  }}
 });
 await client.auth.getUser();
 return response;
}
export const config={matcher:["/student/:path*","/support/:path*","/admin/:path*","/login","/signup","/verify-email","/forgot-password","/reset-password","/auth/:path*","/api/:path*"]};
