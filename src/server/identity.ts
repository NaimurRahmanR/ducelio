import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { createSupabase } from "./supabase";
import { config } from "@/lib/env";
import { roleSchema, type Role } from "@/domain/academy";
import { AccessDenied, canEnter, type Actor, type Area } from "@/domain/policy";

export const getCurrentActor = cache(async (): Promise<Actor | null> => {
  if (!config().configured) return null;
  const client = await createSupabase();
  const {
    data: { user },
    error,
  } = await client.auth.getUser();
  if (error || !user || !user.email_confirmed_at) return null;
  const { data: profile, error: profileError } = await client
    .from("app_users")
    .select("id,display_name")
    .eq("auth_user_id", user.id)
    .eq("is_demo", false)
    .single();
  if (profileError || !profile)
    throw new Error("Your academy profile could not be loaded.");
  const { data: grants, error: roleError } = await client
    .from("role_grants")
    .select("role")
    .eq("user_id", profile.id);
  if (roleError) throw new Error("Academy permissions could not be loaded.");
  return {
    id: profile.id,
    displayName: profile.display_name,
    roles: (grants ?? []).map((g) => roleSchema.parse(g.role)),
  };
});

export async function requireActor(area?: Area) {
  const actor = await getCurrentActor();
  if (!actor) redirect("/login");
  if (area && !canEnter(actor, area)) redirect("/login?error=forbidden");
  return actor;
}

export async function requireAnyRole(roles: readonly Role[]) {
  const actor = await requireActor();
  if (!roles.some((role) => actor.roles.includes(role)))
    throw new AccessDenied();
  return actor;
}
