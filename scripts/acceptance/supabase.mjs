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
import { AcceptanceWriteNotAuthorizedError } from "./db.mjs";

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

// Independent-review finding 3: JWT_POSTGREST must not be able to PASS
// without ever proving foreign-learner isolation. This requires the
// COMPLETE pair -- an email with no password (or vice versa) is an
// incomplete prerequisite, not a usable identity, and returns false just
// like both being absent.
export function foreignLearnerIdentityConfigured() {
  return (
    isConfigured("ACCEPTANCE_FOREIGN_LEARNER_EMAIL") &&
    isConfigured("ACCEPTANCE_FOREIGN_LEARNER_PASSWORD")
  );
}

// ---------------------------------------------------------------------------
// Independent-review finding 1, gate 2 of 2: the Supabase/PostgREST side of
// the same-environment binding. A direct-database marker match alone does
// NOT prove that writes issued through the authenticated Supabase client
// (a completely different network path, authenticated by
// NEXT_PUBLIC_SUPABASE_URL/PUBLISHABLE_KEY, never ACCEPTANCE_DATABASE_URL)
// land on the same environment. This independently re-derives the
// environment id through a narrowly-scoped, manually-provisioned hosted
// RPC and compares it to ACCEPTANCE_ENVIRONMENT_ID. Both this gate and
// db.mjs's assertAcceptanceDatabaseWriteAuthorized must independently
// agree with the SAME operator-declared ACCEPTANCE_ENVIRONMENT_ID before
// seedAcceptanceCourse() (fixtures.mjs) writes anything.
//
// public.get_ducelio_acceptance_environment_id() is NOT a Ducelio
// migration and never will be -- it belongs to the same manually-
// provisioned acceptance marker contract as db.mjs's marker table,
// created once, by hand, directly against the dedicated acceptance
// Supabase project:
//
//   create or replace function public.get_ducelio_acceptance_environment_id()
//   returns uuid language sql stable as $$
//     select '<the exact same ACCEPTANCE_ENVIRONMENT_ID uuid>'::uuid
//   $$;
//   revoke all on function public.get_ducelio_acceptance_environment_id() from public, anon;
//   grant execute on function public.get_ducelio_acceptance_environment_id() to authenticated;
//
// It returns only the acceptance environment's own UUID -- no secret, no
// privileged database metadata, and is granted to `authenticated` only
// (never `anon`), so only a signed-in acceptance identity can even call
// it.
// ---------------------------------------------------------------------------
export async function assertAcceptanceSupabaseWriteAuthorized(client) {
  if (!isConfigured("ACCEPTANCE_ENVIRONMENT_ID"))
    throw new AcceptanceWriteNotAuthorizedError(
      "ACCEPTANCE_ENVIRONMENT_ID is not configured or is not a valid UUID.",
    );
  const expected = process.env.ACCEPTANCE_ENVIRONMENT_ID.trim().toLowerCase();
  let data, error;
  try {
    ({ data, error } = await client.rpc(
      "get_ducelio_acceptance_environment_id",
    ));
  } catch (thrown) {
    error = thrown;
  }
  if (error)
    throw new AcceptanceWriteNotAuthorizedError(
      "the hosted Supabase project does not expose (or denied) get_ducelio_acceptance_environment_id() -- this does not look like a deliberately provisioned acceptance environment.",
    );
  if (typeof data !== "string" || data.trim().toLowerCase() !== expected)
    throw new AcceptanceWriteNotAuthorizedError(
      "the hosted Supabase acceptance-environment id does not match ACCEPTANCE_ENVIRONMENT_ID -- refusing to write (NEXT_PUBLIC_SUPABASE_URL may point at a different environment than ACCEPTANCE_DATABASE_URL).",
    );
}
