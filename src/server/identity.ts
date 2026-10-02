import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { createSupabase } from "./supabase";
import { config } from "@/lib/env";
import { roleSchema, type Role } from "@/domain/academy";
import {
  AccessDenied,
  AuthenticationRequired,
  canEnter,
  type Actor,
  type Area,
} from "@/domain/policy";

type ActorResolution = { actor: Actor | null; deactivated: boolean };

async function resolveActor(): Promise<ActorResolution> {
  const none = { actor: null, deactivated: false };
  if (!config().configured) return none;
  const client = await createSupabase();
  const {
    data: { user },
    error,
  } = await client.auth.getUser();
  if (error || !user || !user.email_confirmed_at) return none;
  const { data: profile, error: profileError } = await client
    .from("app_users")
    .select("id,display_name")
    .eq("auth_user_id", user.id)
    .eq("is_demo", false)
    .single();
  if (profileError || !profile) {
    // A deactivated account's own row is hidden by RLS (migration 044's
    // current_app_user() resolves ACTIVE accounts only), so it holds no
    // application authority: report it as signed out, never as an actor.
    const status = await client.rpc("current_account_status");
    if (!status.error && status.data === "DEACTIVATED")
      return { actor: null, deactivated: true };
    throw new Error("Your academy profile could not be loaded.");
  }
  const { data: grants, error: roleError } = await client
    .from("role_grants")
    .select("role")
    .eq("user_id", profile.id);
  if (roleError) throw new Error("Academy permissions could not be loaded.");
  return {
    actor: {
      id: profile.id,
      displayName: profile.display_name,
      roles: (grants ?? []).map((g) => roleSchema.parse(g.role)),
    },
    deactivated: false,
  };
}

// Capability execution must revalidate identity/roles rather than reuse a render cache.
export async function getAuthenticatedActor(): Promise<Actor | null> {
  return (await resolveActor()).actor;
}

const resolveCurrentActor = cache(resolveActor);
export async function getCurrentActor(): Promise<Actor | null> {
  return (await resolveCurrentActor()).actor;
}

export async function requireStudentPrincipal() {
  const actor = await getAuthenticatedActor();
  if (!actor) throw new AuthenticationRequired();
  if (!actor.roles.includes("STUDENT")) throw new AccessDenied();
  return actor;
}

export async function requireActor(area?: Area) {
  const { actor, deactivated } = await resolveCurrentActor();
  if (!actor)
    redirect(deactivated ? "/login?error=account-inactive" : "/login");
  if (area && !canEnter(actor, area)) redirect("/login?error=forbidden");
  return actor;
}

export async function requireAnyRole(roles: readonly Role[]) {
  const actor = await requireActor();
  if (!roles.some((role) => actor.roles.includes(role)))
    throw new AccessDenied();
  return actor;
}
