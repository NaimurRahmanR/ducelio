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
// Independent-review finding 2: a comment promising "never production" is
// not a safety mechanism. Every mutating acceptance/concurrency fixture
// (fixtures.mjs's seedAcceptanceCourse/seedAcceptanceResults,
// concurrency.mjs's seedOwningChain and every race scenario) MUST call
// assertAcceptanceWriteAuthorized(client) as its first action, before any
// INSERT/UPDATE/DELETE. Two independent things must both be true, and
// neither alone is sufficient:
//   1. the local opt-in ACCEPTANCE_WRITE_ENABLED is exactly "true";
//   2. the TARGET DATABASE ITSELF carries a deliberately-provisioned
//      marker row (ACCEPTANCE_MARKER_TABLE/ACCEPTANCE_MARKER_VALUE below)
//      -- something only an operator who actually intends this connection
//      string to point at a disposable staging/acceptance database would
//      ever have created. A stray or mistaken production connection
//      string satisfies neither an env var typo nor a marker it was never
//      given, and fails closed with BLOCKED, never proceeds.
// Read-only introspection (functionExists/tableExists/triggerExists,
// migration verification) never calls this gate and remains available
// with ACCEPTANCE_DATABASE_URL alone.
import pg from "pg";
import { isConfigured } from "./env.mjs";

export const ACCEPTANCE_MARKER_TABLE = "_ducelio_acceptance_marker";
export const ACCEPTANCE_MARKER_VALUE = "DUCELIO_ACCEPTANCE_ENVIRONMENT_V1";

// The exact, minimal provisioning statement an operator runs ONCE, by hand,
// directly against their own dedicated staging/acceptance database -- never
// something this harness or any Ducelio migration creates automatically.
// Deliberately outside supabase/migrations: this marker is acceptance-
// tooling-only and must never become part of the real product schema.
export const ACCEPTANCE_MARKER_PROVISIONING_SQL = `create table if not exists public.${ACCEPTANCE_MARKER_TABLE} (marker text primary key);
insert into public.${ACCEPTANCE_MARKER_TABLE}(marker) values ('${ACCEPTANCE_MARKER_VALUE}') on conflict do nothing;`;

export class AcceptanceWriteNotAuthorizedError extends Error {
  constructor(reason) {
    super(`Acceptance database write not authorized: ${reason}`);
    this.name = "AcceptanceWriteNotAuthorizedError";
  }
}

/**
 * Fails closed (throws AcceptanceWriteNotAuthorizedError) unless BOTH the
 * local opt-in env var and the in-database marker row are present. Must be
 * called, with the SAME connection about to be used for writes, as the
 * very first statement of every mutating acceptance/concurrency fixture.
 */
export async function assertAcceptanceWriteAuthorized(client) {
  if (process.env.ACCEPTANCE_WRITE_ENABLED?.trim() !== "true")
    throw new AcceptanceWriteNotAuthorizedError(
      "ACCEPTANCE_WRITE_ENABLED is not exactly 'true'.",
    );
  let rows;
  try {
    ({ rows } = await client.query(
      `select 1 from public.${ACCEPTANCE_MARKER_TABLE} where marker=$1 limit 1`,
      [ACCEPTANCE_MARKER_VALUE],
    ));
  } catch {
    throw new AcceptanceWriteNotAuthorizedError(
      `the acceptance-environment marker table (public.${ACCEPTANCE_MARKER_TABLE}) does not exist on this database -- this does not look like a deliberately provisioned acceptance database. Run ACCEPTANCE_MARKER_PROVISIONING_SQL against it once, by hand, if it genuinely is one.`,
    );
  }
  if (!rows.length)
    throw new AcceptanceWriteNotAuthorizedError(
      `the acceptance-environment marker row is missing from public.${ACCEPTANCE_MARKER_TABLE} on this database.`,
    );
}

export function acceptanceDbConfigured() {
  return isConfigured("ACCEPTANCE_DATABASE_URL");
}

/** Opens ONE new, independent connection. Caller must call client.end(). */
export async function connect() {
  if (!acceptanceDbConfigured())
    throw new Error("ACCEPTANCE_DATABASE_URL is not configured.");
  const client = new pg.Client({
    connectionString: process.env.ACCEPTANCE_DATABASE_URL,
    // Acceptance runs may legitimately hit a staging DB behind a managed
    // TLS terminator with a certificate chain Node doesn't already trust;
    // this harness never handles production credentials or writes outside
    // its own scoped fixtures, so this is an acceptable acceptance-only
    // relaxation, never applied to application runtime code.
    ssl: { rejectUnauthorized: false },
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
