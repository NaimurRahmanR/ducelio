import pg from "pg";
import { randomUUID } from "node:crypto";
import { testDatabaseStatements } from "./db-helper";

// Disposable localhost only. No hosted database can be selected by this helper.
export async function localPostgresDatabase(
  options: { throughMigration?: number } = {},
) {
  const endpoint = process.env.DUCELIO_TEST_POSTGRES_URL;
  if (!endpoint) throw new Error("Disposable local PostgreSQL URL is required");
  const url = new URL(endpoint);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    throw new Error("Hosted database refused");
  const database = "ducelio_isolation_" + randomUUID().replaceAll("-", "");
  const admin = new pg.Client({ connectionString: endpoint });
  await admin.connect();
  await admin.query(`create database ${database}`);
  url.pathname = "/" + database;
  const db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
  const close = async () => {
    await db.end();
    await admin.query(`drop database ${database}`);
    await admin.end();
  };
  try {
    for (const sql of await testDatabaseStatements({
      ...options,
      supabaseDefaultPrivileges: true,
    }))
      await db.query(sql);
  } catch (e) {
    await close();
    throw e;
  }
  return {
    query: (sql: string, args?: unknown[]) => db.query(sql, args),
    exec: (sql: string) => db.query(sql),
    close,
  };
}
