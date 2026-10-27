// LOCAL ONLY learner acceptance stack (docs/61). NOT production acceptance.
//
// A minimal Supabase-compatible gateway over a disposable database on the
// local embedded PostgreSQL cluster, so the real Next.js app can be driven
// in a real browser against the real migrations (001-076) without touching
// any hosted environment. It implements only what the learner journeys use:
//   POST /auth/v1/token?grant_type=password|refresh_token, GET/PUT /auth/v1/user,
//   POST /auth/v1/logout, POST /rest/v1/rpc/<fn>, GET /rest/v1/<table> with
//   select= and eq./neq./is./in. filters, order= and limit=.
// Each request runs in its own transaction as `authenticated` (with the JWT
// subject in request.jwt.claim.sub) or `anon`, exactly like the test suites'
// claim helper. Anything else answers 501 and is logged as UNSUPPORTED so a
// gap is never mistaken for a pass. Email change and password reset are
// recorded in memory only; nothing is ever sent.
//
// Usage (from the repository root, local cluster running on 55484):
//   node scripts/local/learner-stack.mjs --reset   # rebuild + seed, then serve
//   node scripts/local/learner-stack.mjs           # serve the existing database
// Then run the app with process-only env (never .env.local):
//   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54399
//   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_local_only
//   APP_URL=http://127.0.0.1:3000
import http from "node:http";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { parse as parseConnectionString } from "pg-connection-string";
import { createJiti } from "jiti";

const ENDPOINT =
  process.env.DUCELIO_LOCAL_POSTGRES_URL ??
  "postgres://postgres@127.0.0.1:55484/postgres";
const DATABASE = "ducelio_local_learner";
const PORT = Number(process.env.DUCELIO_LOCAL_GATEWAY_PORT ?? 54399);
export const PUBLISHABLE_KEY = "sb_publishable_local_only";
// TEST ONLY password for the seeded synthetic accounts on this local stack.
export const LOCAL_PASSWORD = "Local-Only-Test-2026!";
const SECRET = randomBytes(32);

// Checked on what `pg` will actually connect to: its parser lets query
// parameters (host=, hostaddr=) override the URL host, so any query string
// is refused and the resolved host must be loopback.
const endpoint = new URL(ENDPOINT);
const resolvedHost = parseConnectionString(ENDPOINT).host;
if (
  endpoint.search ||
  !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
  !["127.0.0.1", "localhost", "::1"].includes(resolvedHost)
)
  throw new Error("LOCAL ONLY: a non-localhost database was refused.");
const dbUrl = new URL(ENDPOINT);
dbUrl.pathname = "/" + DATABASE;

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": resolve("src"),
    "server-only": resolve("tests/server-only.ts"),
  },
});

async function rebuild() {
  const admin = new pg.Client({ connectionString: ENDPOINT });
  await admin.connect();
  await admin.query(`drop database if exists ${DATABASE} with (force)`);
  await admin.query(`create database ${DATABASE}`);
  await admin.end();
  const db = new pg.Client({ connectionString: dbUrl.toString() });
  await db.connect();
  const { testDatabaseStatements } = await jiti.import(
    pathToFileURL(resolve("tests/db-helper.ts")).href,
  );
  for (const sql of await testDatabaseStatements({
    supabaseDefaultPrivileges: true,
  }))
    await db.query(sql);
  const { seedLocalLearner } = await jiti.import(
    pathToFileURL(resolve("scripts/local/learner-seed.ts")).href,
  );
  const summary = await seedLocalLearner((sql, params) =>
    db.query(sql, params),
  );
  await db.end();
  return summary;
}

// --- JWT (HS256, local secret regenerated per process) ----------------------
const b64 = (v) => Buffer.from(v).toString("base64url");
function sign(payload) {
  const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64(JSON.stringify(payload));
  const mac = createHmac("sha256", SECRET)
    .update(`${head}.${body}`)
    .digest("base64url");
  return `${head}.${body}.${mac}`;
}
function verify(token) {
  const [head, body, mac] = String(token ?? "").split(".");
  if (!head || !body || !mac) return null;
  const expected = createHmac("sha256", SECRET)
    .update(`${head}.${body}`)
    .digest("base64url");
  if (expected !== mac) return null;
  const claims = JSON.parse(Buffer.from(body, "base64url").toString());
  return claims.exp * 1000 > Date.now() ? claims : null;
}

const pool = new pg.Pool({ connectionString: dbUrl.toString(), max: 8 });
const refreshTokens = new Map(); // refresh token -> auth user id
const pendingEmail = new Map(); // auth user id -> requested address
const unsupported = new Set();

async function authUser(id) {
  const { rows } = await pool.query(
    "select id, email, email_confirmed_at from auth.users where id = $1",
    [id],
  );
  if (!rows[0]) return null;
  const u = rows[0];
  return {
    id: u.id,
    aud: "authenticated",
    role: "authenticated",
    email: u.email,
    email_confirmed_at: u.email_confirmed_at?.toISOString() ?? null,
    new_email: pendingEmail.get(u.id) ?? undefined,
    app_metadata: { provider: "email", providers: ["email"] },
    user_metadata: {},
    identities: [],
    created_at: new Date(0).toISOString(),
    updated_at: new Date().toISOString(),
  };
}
async function session(userId) {
  const user = await authUser(userId);
  const now = Math.floor(Date.now() / 1000);
  const refresh = randomUUID();
  refreshTokens.set(refresh, userId);
  return {
    access_token: sign({
      sub: userId,
      role: "authenticated",
      aud: "authenticated",
      email: user.email,
      iat: now,
      exp: now + 3600,
      session_id: randomUUID(),
    }),
    token_type: "bearer",
    expires_in: 3600,
    expires_at: now + 3600,
    refresh_token: refresh,
    user,
  };
}

// --- PostgREST subset -------------------------------------------------------
const IDENT = /^[a-z_][a-z0-9_]*$/;
const procCache = new Map();
async function procFor(name, argNames) {
  if (!procCache.has(name)) {
    const { rows } = await pool.query(
      `select coalesce(p.proargnames, '{}') names, p.proargmodes modes,
              array(select format_type(t, null) from unnest(p.proargtypes) t) types,
              p.proretset retset
         from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = $1`,
      [name],
    );
    procCache.set(name, rows);
  }
  return procCache
    .get(name)
    .find((p) => argNames.every((n) => p.names.includes(n)));
}
function pgError(e) {
  const code = e.code ?? "XX000";
  // PostgREST answers a privilege failure with 403, other errors with 400.
  const status = code === "42501" ? 403 : 400;
  return [
    status,
    {
      code,
      message: e.message,
      details: e.detail ?? null,
      hint: e.hint ?? null,
    },
  ];
}
async function asCaller(claims, run) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      "select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)",
      [claims?.sub ?? "", JSON.stringify(claims ?? { role: "anon" })],
    );
    await client.query(
      claims ? "set local role authenticated" : "set local role anon",
    );
    const result = await run(client);
    await client.query("commit");
    return result;
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
async function callRpc(claims, name, body) {
  if (!IDENT.test(name))
    return [404, { code: "PGRST202", message: "not found" }];
  const args = body && typeof body === "object" ? body : {};
  const names = Object.keys(args);
  const proc = await procFor(name, names);
  if (!proc)
    return [404, { code: "PGRST202", message: `function ${name} not found` }];
  const params = names.map((n) => {
    const type = proc.types[proc.names.indexOf(n)] ?? "";
    const v = args[n];
    if (v === null || v === undefined) return null;
    if (/^jsonb?$/.test(type)) return JSON.stringify(v);
    if (type.endsWith("[]")) return v;
    return typeof v === "object" ? JSON.stringify(v) : v;
  });
  const call = `public.${name}(${names.map((n, i) => `${n} => $${i + 1}`).join(", ")})`;
  try {
    const rows = await asCaller(claims, async (c) =>
      proc.retset
        ? (await c.query(`select * from ${call}`, params)).rows
        : (await c.query(`select ${call} as r`, params)).rows,
    );
    if (!proc.retset) return [200, rows[0]?.r ?? null];
    return [
      200,
      rows.map((r) => {
        const keys = Object.keys(r);
        return keys.length === 1 && keys[0] === name ? r[name] : r;
      }),
    ];
  } catch (e) {
    return pgError(e);
  }
}
const OPS = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };
async function selectTable(claims, table, search, single) {
  if (!IDENT.test(table)) return [404, { code: "42P01", message: "no table" }];
  const cols = (search.get("select") ?? "*").split(",").map((s) => s.trim());
  if (!cols.every((c) => c === "*" || IDENT.test(c))) {
    unsupported.add(`select=${search.get("select")} on ${table}`);
    return [501, { code: "LOCAL_UNSUPPORTED", message: "embedded select" }];
  }
  const where = [];
  const params = [];
  let order = "";
  let limit = "";
  for (const [key, raw] of search) {
    if (key === "select") continue;
    if (key === "order") {
      const parts = raw.split(",").map((p) => p.split("."));
      if (!parts.every(([c]) => IDENT.test(c)))
        return [400, { message: "order" }];
      order = ` order by ${parts.map(([c, d]) => `"${c}" ${d === "desc" ? "desc" : "asc"}`).join(", ")}`;
      continue;
    }
    if (key === "limit") {
      limit = ` limit ${Math.max(0, Number.parseInt(raw, 10) || 0)}`;
      continue;
    }
    if (key === "offset") continue;
    if (!IDENT.test(key)) return [400, { message: "filter" }];
    const dot = raw.indexOf(".");
    const op = raw.slice(0, dot);
    const value = raw.slice(dot + 1);
    if (OPS[op]) {
      params.push(value);
      where.push(`"${key}"::text ${OPS[op]} $${params.length}`);
    } else if (op === "is") {
      where.push(
        `"${key}" is ${value === "null" ? "null" : value === "true" ? "true" : "false"}`,
      );
    } else if (op === "in") {
      params.push(
        value
          .replace(/^\(|\)$/g, "")
          .split(",")
          .map((v) => v.replace(/^"|"$/g, "")),
      );
      where.push(`"${key}"::text = any($${params.length})`);
    } else {
      unsupported.add(`filter ${op} on ${table}`);
      return [501, { code: "LOCAL_UNSUPPORTED", message: `filter ${op}` }];
    }
  }
  const sql = `select ${cols.map((c) => (c === "*" ? "*" : `"${c}"`)).join(", ")} from public."${table}"${where.length ? " where " + where.join(" and ") : ""}${order}${limit}`;
  try {
    const rows = await asCaller(
      claims,
      async (c) => (await c.query(sql, params)).rows,
    );
    if (single) {
      if (rows.length !== 1)
        return [
          406,
          {
            code: "PGRST116",
            message: "JSON object requested, multiple (or no) rows returned",
            details: `The result contains ${rows.length} rows`,
            hint: null,
          },
        ];
      return [200, rows[0]];
    }
    return [200, rows];
  } catch (e) {
    return pgError(e);
  }
}

// --- HTTP -------------------------------------------------------------------
const readBody = (req) =>
  new Promise((ok) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString();
      try {
        ok(text ? JSON.parse(text) : {});
      } catch {
        ok({});
      }
    });
  });
function send(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
  });
  res.end(body === undefined ? "" : JSON.stringify(body));
}
const authError = (res, status, code, msg) =>
  send(res, status, { code: status, error_code: code, msg, message: msg });

async function handle(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (req.method === "OPTIONS") return send(res, 204);
  if (req.headers.apikey !== PUBLISHABLE_KEY)
    return authError(res, 401, "bad_key", "Invalid API key");
  const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  const claims = verify(bearer);
  const path = url.pathname;

  if (path === "/auth/v1/token" && req.method === "POST") {
    const body = await readBody(req);
    const grant = url.searchParams.get("grant_type");
    if (grant === "password") {
      const { rows } = await pool.query(
        "select id from auth.users where lower(email) = lower($1)",
        [String(body.email ?? "")],
      );
      if (!rows[0] || body.password !== LOCAL_PASSWORD) {
        // Why a local sign-in failed (synthetic accounts only; the password
        // itself is never logged), so a mistyped or autofilled credential
        // is distinguishable from a gateway fault.
        const password = String(body.password ?? "");
        console.log(
          rows[0]
            ? `[local] sign-in refused: wrong password for ${String(body.email)} (length ${password.length}${password !== password.trim() ? ", surrounding whitespace" : ""})`
            : `[local] sign-in refused: no local account ${JSON.stringify(String(body.email ?? ""))}`,
        );
        return authError(
          res,
          400,
          "invalid_credentials",
          "Invalid login credentials",
        );
      }
      return send(res, 200, await session(rows[0].id));
    }
    if (grant === "refresh_token") {
      const id = refreshTokens.get(body.refresh_token);
      if (!id)
        return authError(
          res,
          400,
          "refresh_token_not_found",
          "Invalid Refresh Token",
        );
      refreshTokens.delete(body.refresh_token);
      return send(res, 200, await session(id));
    }
    unsupported.add(`auth grant ${grant}`);
    return authError(
      res,
      501,
      "local_unsupported",
      "grant not supported locally",
    );
  }
  if (path === "/auth/v1/user") {
    if (!claims) return authError(res, 401, "bad_jwt", "invalid JWT");
    if (req.method === "GET") {
      const user = await authUser(claims.sub);
      return user
        ? send(res, 200, user)
        : authError(res, 404, "user_not_found", "User not found");
    }
    if (req.method === "PUT") {
      const body = await readBody(req);
      if (typeof body.email === "string") {
        // Recorded only: the address changes after a confirmation link, which
        // this local stack never sends.
        pendingEmail.set(claims.sub, body.email.trim().toLowerCase());
        console.log(`[local] email change requested (not sent): ${claims.sub}`);
      } else if (typeof body.password === "string") {
        unsupported.add("password change");
        return authError(
          res,
          501,
          "local_unsupported",
          "password change not supported locally",
        );
      }
      return send(res, 200, await authUser(claims.sub));
    }
  }
  if (path === "/auth/v1/logout") return send(res, 204);
  if (path === "/auth/v1/recover") return send(res, 200, {});

  if (path.startsWith("/rest/v1/rpc/") && req.method === "POST") {
    const [status, body] = await callRpc(
      claims,
      path.slice(13),
      await readBody(req),
    );
    if (status >= 500 || status === 404)
      console.log(`[local] rpc ${path.slice(13)} -> ${status}`);
    return send(res, status, body);
  }
  if (path.startsWith("/rest/v1/") && req.method === "GET") {
    const single = String(req.headers.accept ?? "").includes(
      "vnd.pgrst.object",
    );
    const [status, body] = await selectTable(
      claims,
      path.slice(9),
      url.searchParams,
      single,
    );
    return send(res, status, body);
  }
  unsupported.add(`${req.method} ${path}`);
  console.log(`[local] UNSUPPORTED ${req.method} ${path}`);
  return send(res, 501, {
    code: "LOCAL_UNSUPPORTED",
    message: `${req.method} ${path}`,
  });
}

if (process.argv.includes("--reset")) {
  console.log(`[local] rebuilding ${DATABASE} on ${endpoint.host} ...`);
  console.log("[local] seeded:", JSON.stringify(await rebuild(), null, 2));
}
http
  .createServer((req, res) =>
    handle(req, res).catch((e) => {
      console.error("[local] gateway error", e);
      send(res, 500, { code: "LOCAL_GATEWAY_ERROR", message: "gateway error" });
    }),
  )
  .listen(PORT, "127.0.0.1", () =>
    console.log(
      `[local] LOCAL ONLY gateway on http://127.0.0.1:${PORT} (database ${DATABASE})`,
    ),
  );
process.on("SIGINT", () => {
  if (unsupported.size)
    console.log("[local] UNSUPPORTED calls:", [...unsupported]);
  process.exit(0);
});
