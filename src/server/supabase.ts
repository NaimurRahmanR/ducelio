import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { config } from "@/lib/env";
export async function createSupabase() {
 const env=config();
 if(!env.configured) throw new Error("Authentication is not configured.");
 const jar=await cookies();
 return createServerClient(env.url,env.key,{
  cookieOptions:{httpOnly:true,sameSite:"lax",secure:env.appUrl.startsWith("https://"),path:"/"},
  cookies:{getAll:()=>jar.getAll(),setAll(values){try { for(const {name,value,options} of values) jar.set(name,value,options); } catch { /* Server components cannot set cookies; proxy refreshes them. */ }}}
 });
}
