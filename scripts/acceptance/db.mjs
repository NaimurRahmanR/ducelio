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
import pg from "pg";
import { isConfigured } from "./env.mjs";

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
