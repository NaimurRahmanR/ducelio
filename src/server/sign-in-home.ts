import "server-only";
import { signInHome } from "@/domain/auth";
import type { createSupabase } from "./supabase";

type Client = Awaited<ReturnType<typeof createSupabase>>;

// Reads the just-signed-in account's role grants through its own session
// (row-level security applies) to choose its default landing page. Any
// failure keeps the previous default, /student.
export async function signedInHome(client: Client): Promise<string> {
  try {
    const {
      data: { user },
    } = await client.auth.getUser();
    if (!user) return "/student";
    const { data: profile } = await client
      .from("app_users")
      .select("id")
      .eq("auth_user_id", user.id)
      .eq("is_demo", false)
      .single();
    if (!profile || typeof profile.id !== "string") return "/student";
    const { data: grants } = await client
      .from("role_grants")
      .select("role")
      .eq("user_id", profile.id);
    return signInHome(
      Array.isArray(grants)
        ? grants.map((g) => String((g as { role: unknown }).role))
        : [],
    );
  } catch {
    return "/student";
  }
}
