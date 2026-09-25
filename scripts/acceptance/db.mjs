// Direct PostgreSQL connection helper for the acceptance harness, used only
// for read/verify migration introspection and for the true-concurrency
// scenarios (E3), which need genuinely independent database connections
// that a single PostgREST/supabase-js client cannot provide.
//
// This is acceptance-tooling-only: ACCEPTANCE_DATABASE_URL is never read by
// application runtime code (src/**), and this module is never imported
// there either. It is a SEPARATE, explicitly acceptance-scoped credential,
// never the application's own runtime authority (which has no direct
// database connection or service-role credential at all -- see docs/38).
//
// Every helper here defaults to READ-ONLY / verify behaviour. Nothing in
// this module issues TRUNCATE, DROP, or an unscoped DELETE; the concurrency
// scenarios that must write use explicit acceptance-run-scoped identifiers
// and clean up only rows they themselves created (see concurrency.mjs).
//
// Independent-review finding 2 (prior pass): a comment promising "never
// production" is not a safety mechanism. Every mutating acceptance/
// concurrency fixture (fixtures.mjs's seedAcceptanceCourse/
// seedAcceptanceResults, concurrency.mjs's seedOwningChain and every race
// scenario) MUST call assertAcceptanceDatabaseWriteAuthorized(client) as
// its first action, on EVERY writing connection, before any
// INSERT/UPDATE/DELETE. Two independent things must both be true, and
// neither alone is sufficient:
//   1. the local opt-in ACCEPTANCE_WRITE_ENABLED is exactly "true";
//   2. the TARGET DATABASE ITSELF carries a deliberately-provisioned
//      marker row (ACCEPTANCE_MARKER_TABLE/ACCEPTANCE_MARKER_VALUE below)
//      whose environment_id exactly matches this session's own
//      ACCEPTANCE_ENVIRONMENT_ID -- something only an operator who
//      actually intends this connection string to point at a disposable
//      staging/acceptance environment would ever have created. A stray or
//      mistaken production connection string satisfies neither an env var
//      typo nor a marker it was never given, and fails closed with
//      BLOCKED, never proceeds.
//
// Independent-review finding 1 (this pass): this direct-database gate
// alone does NOT prove that Supabase/PostgREST writes (which travel a
// completely different network path, authenticated by
// NEXT_PUBLIC_SUPABASE_URL, not ACCEPTANCE_DATABASE_URL) target the SAME
// environment. seedAcceptanceCourse() therefore ALSO calls
// supabase.mjs's assertAcceptanceSupabaseWriteAuthorized, which
// independently reads the SAME ACCEPTANCE_ENVIRONMENT_ID back through a
// narrowly-scoped hosted RPC. Both must agree before either function ever
// writes anything.
//
// Read-only introspection (functionExists/tableExists/triggerExists,
// migration verification) never calls this gate and remains available
// with ACCEPTANCE_DATABASE_URL alone.
import pg from "pg";
import { isConfigured } from "./env.mjs";

export const ACCEPTANCE_MARKER_TABLE = "_ducelio_acceptance_marker";
export const ACCEPTANCE_MARKER_VALUE = "DUCELIO_ACCEPTANCE_ENVIRONMENT_V1";

/**
 * The exact, minimal provisioning statement an operator runs ONCE, by
 * hand, directly against their own dedicated staging/acceptance database
 * -- never something this harness or any Ducelio migration creates
 * automatically. Deliberately outside supabase/migrations: this marker is
 * acceptance-tooling-only and must never become part of the real product
 * schema. `environmentId` must be the exact same UUID the operator also
 * sets as ACCEPTANCE_ENVIRONMENT_ID and exposes via the hosted
 * get_ducelio_acceptance_environment_id() RPC (see supabase.mjs) -- one
 * value, provisioned by hand in both places, is what binds the two
 * independent connections to the same environment.
 */
export function acceptanceMarkerProvisioningSql(environmentId) {
  return `create table if not exists public.${ACCEPTANCE_MARKER_TABLE} (
  marker text primary key,
  environment_id uuid not null
);
insert into public.${ACCEPTANCE_MARKER_TABLE}(marker, environment_id)
values ('${ACCEPTANCE_MARKER_VALUE}', '${environmentId}')
on conflict (marker) do update set environment_id = excluded.environment_id;`;
}

export class AcceptanceWriteNotAuthorizedError extends Error {
  constructor(reason) {
    super(`Acceptance database write not authorized: ${reason}`);
    this.name = "AcceptanceWriteNotAuthorizedError";
  }
}

/**
 * Fails closed (throws AcceptanceWriteNotAuthorizedError) unless ALL of the
 * following are true: the local opt-in env var is exactly "true";
 * ACCEPTANCE_ENVIRONMENT_ID is configured and well-formed; the in-database
 * marker row exists; and its environment_id column exactly matches
 * ACCEPTANCE_ENVIRONMENT_ID. Must be called, with the SAME connection
 * about to be used for writes, as the very first statement of every
 * mutating acceptance/concurrency fixture -- and independently on every
 * writing connection when more than one is opened (see
 * assertAllAcceptanceDatabaseWriteAuthorized below). Never logs the
 * connection string, the environment id, or any row value.
 */
export async function assertAcceptanceDatabaseWriteAuthorized(client) {
  if (process.env.ACCEPTANCE_WRITE_ENABLED?.trim() !== "true")
    throw new AcceptanceWriteNotAuthorizedError(
      "ACCEPTANCE_WRITE_ENABLED is not exactly 'true'.",
    );
  if (!isConfigured("ACCEPTANCE_ENVIRONMENT_ID"))
    throw new AcceptanceWriteNotAuthorizedError(
      "ACCEPTANCE_ENVIRONMENT_ID is not configured or is not a valid UUID.",
    );
  const environmentId = process.env.ACCEPTANCE_ENVIRONMENT_ID.trim();
  let rows;
  try {
    ({ rows } = await client.query(
      `select 1 from public.${ACCEPTANCE_MARKER_TABLE} where marker=$1 and environment_id=$2::uuid limit 1`,
      [ACCEPTANCE_MARKER_VALUE, environmentId],
    ));
  } catch {
    throw new AcceptanceWriteNotAuthorizedError(
      `the acceptance-environment marker table (public.${ACCEPTANCE_MARKER_TABLE}) does not exist, is malformed, or is not readable on this database -- this does not look like a deliberately provisioned acceptance database. Run acceptanceMarkerProvisioningSql(ACCEPTANCE_ENVIRONMENT_ID) against it once, by hand, if it genuinely is one.`,
    );
  }
  if (!rows.length)
    throw new AcceptanceWriteNotAuthorizedError(
      `no marker row on public.${ACCEPTANCE_MARKER_TABLE} matches both the expected marker and this session's ACCEPTANCE_ENVIRONMENT_ID -- either the marker is missing, or this database's declared environment id does not match. Refusing to write.`,
    );
}

/**
 * Independent-review finding 2: gates every one of several writing
 * connections independently, rather than trusting that checking one
 * connection proves anything about a sibling connection opened from the
 * same connectMany() call. Concurrency semantics are unaffected -- this
 * runs before any of the connections' own writes are issued.
 */
export async function assertAllAcceptanceDatabaseWriteAuthorized(clients) {
  await Promise.all(
    clients.map((c) => assertAcceptanceDatabaseWriteAuthorized(c)),
  );
}

export function acceptanceDbConfigured() {
  return isConfigured("ACCEPTANCE_DATABASE_URL");
}

/** Opens ONE new, independent connection. Caller must call client.end(). */
export async function connect() {
  if (!acceptanceDbConfigured())
    throw new Error("ACCEPTANCE_DATABASE_URL is not configured.");
  // Independent-review finding 4: TLS certificate verification is NEVER
  // unconditionally disabled. By default no `ssl` option is passed at
  // all, so `pg` relies entirely on ACCEPTANCE_DATABASE_URL's own
  // connection-string TLS parameters (e.g. ?sslmode=require/verify-full) --
  // a correctly provisioned hosted acceptance database supplies these
  // itself. The insecure, certificate-skipping mode is available ONLY
  // behind a separately named, explicit opt-in that also appears as its
  // own clearly-labelled INSECURE entry in `npm run acceptance:preflight`.
  const insecureTls =
    process.env.ACCEPTANCE_DATABASE_INSECURE_TLS?.trim() === "true";
  const client = new pg.Client({
    connectionString: process.env.ACCEPTANCE_DATABASE_URL,
    ...(insecureTls ? { ssl: { rejectUnauthorized: false } } : {}),
  });
  await client.connect();
  return client;
}

/** Runs `work` with a single connection, guaranteeing it is closed. */
export async function withConnection(work) {
  const client = await connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/**
 * Independent-review finding (this pass): withConnection() alone does not
 * gate anything -- it is also the right (and only) shape for read-only
 * introspection, which must NEVER be gated. That made it possible for a
 * mutating call site (a cleanup DELETE, in particular) to be added later
 * via plain withConnection() and forget the gate entirely, with nothing
 * static or behavioural to catch it.
 *
 * withAcceptanceWriteConnection() is the single sanctioned shape for a
 * fresh, single-connection WRITE: it (1) opens the connection, (2) calls
 * assertAcceptanceDatabaseWriteAuthorized(client) BEFORE `work` ever runs,
 * so an unauthorized/misconfigured target throws
 * AcceptanceWriteNotAuthorizedError and `work` never executes a single
 * statement, and (3) always closes the connection, success or failure.
 * Every direct-PostgreSQL INSERT/UPDATE/DELETE in the acceptance harness
 * that does not participate in a multi-client race (which instead opens
 * its clients via connectMany() and gates them all with
 * assertAllAcceptanceDatabaseWriteAuthorized) must go through this
 * function, never through bare withConnection().
 */
export async function withAcceptanceWriteConnection(work) {
  const client = await connect();
  try {
    await assertAcceptanceDatabaseWriteAuthorized(client);
    return await work(client);
  } finally {
    await client.end();
  }
}

/** Opens N independent connections for genuine concurrency scenarios. */
export async function connectMany(n) {
  const clients = await Promise.all(Array.from({ length: n }, () => connect()));
  return {
    clients,
    async closeAll() {
      await Promise.all(clients.map((c) => c.end()));
    },
  };
}

// ---------------------------------------------------------------------------
// Read-only introspection helpers.
// ---------------------------------------------------------------------------

/** True if a function with this exact name exists in schema `public`. */
export async function functionExists(client, name) {
  const { rows } = await client.query(
    `select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname=$1 limit 1`,
    [name],
  );
  return rows.length > 0;
}

/** True if a table exists in schema `public`. */
export async function tableExists(client, name) {
  const { rows } = await client.query(
    `select 1 from information_schema.tables
     where table_schema='public' and table_name=$1 limit 1`,
    [name],
  );
  return rows.length > 0;
}

/** True if a trigger with this exact name exists anywhere. */
export async function triggerExists(client, name) {
  const { rows } = await client.query(
    `select 1 from pg_trigger where tgname=$1 and not tgisinternal limit 1`,
    [name],
  );
  return rows.length > 0;
}

/**
 * The set of migration filenames actually present on disk under
 * supabase/migrations -- used by migrations.mjs to know what "through 042"
 * means without hardcoding a duplicate list here.
 */
export async function listLocalMigrationFiles() {
  const { readdir } = await import("node:fs/promises");
  const files = (
    await readdir(new URL("../../supabase/migrations", import.meta.url))
  )
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return files;
}
