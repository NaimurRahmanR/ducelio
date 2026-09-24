// Hosted Supabase client helpers for the acceptance harness. Uses the SAME
// @supabase/supabase-js package and the SAME public URL/publishable-key
// pair the application itself uses (NEXT_PUBLIC_SUPABASE_URL,
// NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) -- this harness never uses a
// service-role credential, because the application has none and this
// harness deliberately exercises the exact same authority boundary real
// learners/admins go through (PostgREST + RLS + the governed RPCs), not a
// privileged bypass.
import { createClient } from "@supabase/supabase-js";
import { isConfigured } from "./env.mjs";

export function hostedSupabaseConfigured() {
  return (
    isConfigured("NEXT_PUBLIC_SUPABASE_URL") &&
    isConfigured("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY")
  );
}

/** An anonymous (unauthenticated) client -- exactly what a signed-out browser gets. */
export function anonClient() {
  if (!hostedSupabaseConfigured())
    throw new Error("Hosted Supabase is not configured.");
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  );
}

/**
 * Signs in a synthetic acceptance identity via real Supabase Auth (email +
 * password) and returns an authenticated client. Never creates or invents a
 * session; a missing/incorrect credential fails closed and the caller
 * reports BLOCKED, never a fabricated PASS.
 */
export async function signIn(emailVar, passwordVar) {
  const email = process.env[emailVar];
  const password = process.env[passwordVar];
  if (!email || !password)
    throw new Error(
      `Acceptance identity ${emailVar}/${passwordVar} is not configured.`,
    );
  const client = anonClient();
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error)
    throw new Error(
      `Acceptance identity ${emailVar} could not authenticate (hosted Supabase Auth denied it).`,
    );
  return client;
}

export const acceptanceIdentities = {
  admin: () => signIn("ACCEPTANCE_ADMIN_EMAIL", "ACCEPTANCE_ADMIN_PASSWORD"),
  learner: () =>
    signIn("ACCEPTANCE_LEARNER_EMAIL", "ACCEPTANCE_LEARNER_PASSWORD"),
  foreignLearner: () =>
    signIn(
      "ACCEPTANCE_FOREIGN_LEARNER_EMAIL",
      "ACCEPTANCE_FOREIGN_LEARNER_PASSWORD",
    ),
};

export function acceptanceIdentitiesConfigured() {
  return (
    isConfigured("ACCEPTANCE_ADMIN_EMAIL") &&
    isConfigured("ACCEPTANCE_ADMIN_PASSWORD") &&
    isConfigured("ACCEPTANCE_LEARNER_EMAIL") &&
    isConfigured("ACCEPTANCE_LEARNER_PASSWORD")
  );
}
