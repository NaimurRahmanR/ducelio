import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
// Captured via a plain static import, at file-load time, BEFORE any test's
// vi.doMock/vi.resetModules() ever runs -- these are pure functions with no
// internal state, so this reference stays perfectly valid and unaffected by
// later module-registry resets. Reused inside the mocked supabase.mjs below
// so the JWT-classification tests genuinely exercise the REAL classifier
// logic against a controlled raw response shape, rather than a hand-rolled
// duplicate that could silently drift from it.
import {
  isJwtAuthRejection as realIsJwtAuthRejection,
  isJwtExpiryRejection as realIsJwtExpiryRejection,
  isAnonInsufficientPrivilegeRejection as realIsAnonInsufficientPrivilegeRejection,
  isAuthenticatedInsufficientPrivilegeRejection as realIsAuthenticatedInsufficientPrivilegeRejection,
} from "../scripts/acceptance/supabase.mjs";

// env.mjs is plain, untyped JS (see tests/mjs-modules.d.ts); this local
// shape lets the callbacks below avoid implicit-any without adding a
// parallel type system for the acceptance harness itself.
type VarReport = { name: string; status: string; scope: string };

// ============================================================================
// Checkpoint E2/E3/E4/E5: local tests for the acceptance harness ITSELF
// (scripts/acceptance/*.mjs), independent of any hosted infrastructure.
// These are the tests the review's own "TEST THE HARNESS ITSELF" section
// requires -- proving the harness's own decision logic (classification,
// secret redaction, gating) is correct, never proving hosted acceptance
// itself (which remains BLOCKED/NOT_RUN without real hosted credentials).
// ============================================================================

const ORIGINAL_ENV = { ...process.env };
function resetEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}
beforeEach(resetEnv);
afterEach(resetEnv);

function clearAcceptanceVars() {
  for (const key of Object.keys(process.env)) {
    if (
      key.startsWith("ACCEPTANCE_") ||
      key.startsWith("ACADEMIC_") ||
      key.startsWith("STRIPE_") ||
      key.startsWith("COMMERCE_") ||
      key.startsWith("NEXT_PUBLIC_SUPABASE_") ||
      key === "OPENAI_API_KEY" ||
      key === "ANTHROPIC_API_KEY"
    )
      delete process.env[key];
  }
}

// JWT_POSTGREST completion (docs/38 section 3): a genuinely structurally
// JWT-shaped (three dot-separated base64url segments, valid JSON payload)
// synthetic token, with a fully caller-controlled `exp` claim and NO real
// signature -- exactly what jwt.mjs's structural-only decoder (never a
// signature verifier) needs to exercise. Never used as a real credential
// against anything; only ever fed to this harness's own local decode logic
// or to a mocked callProtectedRpcWithBearerToken.
function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
function makeFakeJwt(expSecondsFromNow: number): string {
  const header = base64url({ alg: "HS256", typ: "JWT" });
  const payload = base64url({
    sub: "acceptance-test-fixture",
    exp: Math.floor(Date.now() / 1000) + expSecondsFromNow,
  });
  return `${header}.${payload}.fake-signature-segment-never-a-real-mac`;
}

describe("acceptance harness: env.mjs preflight", () => {
  it("reports every known variable as missing when unset", async () => {
    clearAcceptanceVars();
    const { preflightReport } = await import("../scripts/acceptance/env.mjs");
    const report = preflightReport();
    expect(report.length).toBeGreaterThan(0);
    expect((report as VarReport[]).every((r) => r.status === "missing")).toBe(
      true,
    );
  });

  it("detects a malformed value without ever exposing it", async () => {
    clearAcceptanceVars();
    process.env.ACADEMIC_EXECUTION_KEY_ID = "not-a-uuid";
    process.env.ACADEMIC_EXECUTION_HMAC_KEY_HEX = "too-short";
    process.env.STRIPE_SECRET_KEY = "definitely-not-a-stripe-key";
    const { preflightReport } = await import("../scripts/acceptance/env.mjs");
    const report: VarReport[] = preflightReport();
    const byName = Object.fromEntries(report.map((r) => [r.name, r]));
    expect(byName.ACADEMIC_EXECUTION_KEY_ID.status).toBe("malformed");
    expect(byName.ACADEMIC_EXECUTION_HMAC_KEY_HEX.status).toBe("malformed");
    expect(byName.STRIPE_SECRET_KEY.status).toBe("malformed");
    // The report objects themselves carry no value field at all -- the only
    // way this test could leak a secret is if the module design allowed it,
    // so this asserts the shape structurally, not just behaviourally.
    for (const r of report) {
      expect(Object.keys(r).sort()).toEqual(["name", "scope", "status"]);
    }
  });

  it("accepts a well-formed value as configured", async () => {
    clearAcceptanceVars();
    process.env.ACADEMIC_EXECUTION_KEY_ID =
      "10000000-0000-4000-8000-000000000001";
    process.env.ACADEMIC_EXECUTION_HMAC_KEY_HEX = "a".repeat(64);
    process.env.STRIPE_SECRET_KEY = "sk_test_abcdef";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_abcdef";
    const { preflightReport } = await import("../scripts/acceptance/env.mjs");
    const byName = Object.fromEntries(
      (preflightReport() as VarReport[]).map((r) => [r.name, r]),
    );
    expect(byName.ACADEMIC_EXECUTION_KEY_ID.status).toBe("configured");
    expect(byName.ACADEMIC_EXECUTION_HMAC_KEY_HEX.status).toBe("configured");
    expect(byName.STRIPE_SECRET_KEY.status).toBe("configured");
    expect(byName.STRIPE_WEBHOOK_SECRET.status).toBe("configured");
  });

  it("treats an empty-string value identically to unset (missing, never malformed)", async () => {
    clearAcceptanceVars();
    process.env.ACADEMIC_EXECUTION_KEY_ID = "   ";
    const { statusOf } = await import("../scripts/acceptance/env.mjs");
    expect(statusOf("ACADEMIC_EXECUTION_KEY_ID")).toBe("missing");
  });

  it("throws on an unknown variable name rather than silently returning a status", async () => {
    const { statusOf } = await import("../scripts/acceptance/env.mjs");
    expect(() => statusOf("SOME_MADE_UP_VARIABLE")).toThrow();
  });
});

describe("acceptance harness: ACCEPTANCE_DATABASE_URL validation (independent-review finding 1)", () => {
  it("accepts a valid postgres:// connection string", async () => {
    clearAcceptanceVars();
    process.env.ACCEPTANCE_DATABASE_URL =
      "postgres://acceptance:secret@db.example.com:5432/acceptance_db";
    const { statusOf } = await import("../scripts/acceptance/env.mjs");
    expect(statusOf("ACCEPTANCE_DATABASE_URL")).toBe("configured");
  });

  it("accepts a valid postgresql:// connection string", async () => {
    clearAcceptanceVars();
    process.env.ACCEPTANCE_DATABASE_URL =
      "postgresql://acceptance:secret@db.example.com:5432/acceptance_db";
    const { statusOf } = await import("../scripts/acceptance/env.mjs");
    expect(statusOf("ACCEPTANCE_DATABASE_URL")).toBe("configured");
  });

  it("accepts a valid postgres:// connection string with no credentials (peer/trust auth)", async () => {
    clearAcceptanceVars();
    process.env.ACCEPTANCE_DATABASE_URL =
      "postgres://db.example.com:5432/acceptance_db";
    const { statusOf } = await import("../scripts/acceptance/env.mjs");
    expect(statusOf("ACCEPTANCE_DATABASE_URL")).toBe("configured");
  });

  it("rejects an http(s) URL -- a database connection string is never http/https", async () => {
    clearAcceptanceVars();
    process.env.ACCEPTANCE_DATABASE_URL =
      "https://db.example.com/acceptance_db";
    const { statusOf } = await import("../scripts/acceptance/env.mjs");
    expect(statusOf("ACCEPTANCE_DATABASE_URL")).toBe("malformed");
  });

  it("rejects a malformed value", async () => {
    clearAcceptanceVars();
    process.env.ACCEPTANCE_DATABASE_URL = "not a url at all";
    const { statusOf } = await import("../scripts/acceptance/env.mjs");
    expect(statusOf("ACCEPTANCE_DATABASE_URL")).toBe("malformed");
  });

  it("rejects a username with no password (and vice versa) as malformed, not a valid connection string", async () => {
    clearAcceptanceVars();
    process.env.ACCEPTANCE_DATABASE_URL =
      "postgres://onlyuser@db.example.com:5432/db";
    const { statusOf } = await import("../scripts/acceptance/env.mjs");
    expect(statusOf("ACCEPTANCE_DATABASE_URL")).toBe("malformed");
  });

  it("never reports the raw URL/credentials -- the report carries no value field at all", async () => {
    clearAcceptanceVars();
    process.env.ACCEPTANCE_DATABASE_URL =
      "postgres://acceptance:top-secret-password@db.example.com:5432/acceptance_db";
    const { preflightReport } = await import("../scripts/acceptance/env.mjs");
    const report = (preflightReport() as VarReport[]).find(
      (r) => r.name === "ACCEPTANCE_DATABASE_URL",
    )!;
    expect(Object.keys(report).sort()).toEqual(["name", "scope", "status"]);
    expect(JSON.stringify(report)).not.toContain("top-secret-password");
    expect(JSON.stringify(report)).not.toContain("db.example.com");
  });

  it("does not weaken the http/https validation used by NEXT_PUBLIC_SUPABASE_URL/ACADEMIC_PROVIDER_BASE_URL", async () => {
    clearAcceptanceVars();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "postgres://not-a-supabase-url/db";
    process.env.ACADEMIC_PROVIDER_BASE_URL = "postgres://not-an-http-url/db";
    const { statusOf } = await import("../scripts/acceptance/env.mjs");
    expect(statusOf("NEXT_PUBLIC_SUPABASE_URL")).toBe("malformed");
    expect(statusOf("ACADEMIC_PROVIDER_BASE_URL")).toBe("malformed");
  });
});

const VALID_ENV_ID = "a0000000-0000-4000-8000-000000000001";
const OTHER_ENV_ID = "b0000000-0000-4000-8000-000000000002";

function setValidWriteEnv(id = VALID_ENV_ID) {
  process.env.ACCEPTANCE_WRITE_ENABLED = "true";
  process.env.ACCEPTANCE_ENVIRONMENT_ID = id;
}

describe("acceptance harness: direct-database write-safety gate (independent-review finding 2, prior pass)", () => {
  it("fails closed when ACCEPTANCE_WRITE_ENABLED is not exactly 'true', even if a matching marker row would be found", async () => {
    clearAcceptanceVars();
    process.env.ACCEPTANCE_ENVIRONMENT_ID = VALID_ENV_ID;
    const {
      assertAcceptanceDatabaseWriteAuthorized,
      AcceptanceWriteNotAuthorizedError,
    } = await import("../scripts/acceptance/db.mjs");
    const fakeClient = { query: async () => ({ rows: [{ marker: "x" }] }) };
    await expect(
      assertAcceptanceDatabaseWriteAuthorized(fakeClient),
    ).rejects.toThrow(AcceptanceWriteNotAuthorizedError);
  });

  it("fails closed when ACCEPTANCE_WRITE_ENABLED is 'yes'/'1'/anything other than the literal string 'true'", async () => {
    clearAcceptanceVars();
    process.env.ACCEPTANCE_WRITE_ENABLED = "yes";
    process.env.ACCEPTANCE_ENVIRONMENT_ID = VALID_ENV_ID;
    const {
      assertAcceptanceDatabaseWriteAuthorized,
      AcceptanceWriteNotAuthorizedError,
    } = await import("../scripts/acceptance/db.mjs");
    const fakeClient = { query: async () => ({ rows: [{ marker: "x" }] }) };
    await expect(
      assertAcceptanceDatabaseWriteAuthorized(fakeClient),
    ).rejects.toThrow(AcceptanceWriteNotAuthorizedError);
  });

  it("fails closed when ACCEPTANCE_ENVIRONMENT_ID is missing, even with the write opt-in set", async () => {
    clearAcceptanceVars();
    process.env.ACCEPTANCE_WRITE_ENABLED = "true";
    const {
      assertAcceptanceDatabaseWriteAuthorized,
      AcceptanceWriteNotAuthorizedError,
    } = await import("../scripts/acceptance/db.mjs");
    const fakeClient = { query: async () => ({ rows: [{ marker: "x" }] }) };
    await expect(
      assertAcceptanceDatabaseWriteAuthorized(fakeClient),
    ).rejects.toThrow(AcceptanceWriteNotAuthorizedError);
  });

  it("fails closed when ACCEPTANCE_ENVIRONMENT_ID is not a valid UUID", async () => {
    clearAcceptanceVars();
    process.env.ACCEPTANCE_WRITE_ENABLED = "true";
    process.env.ACCEPTANCE_ENVIRONMENT_ID = "not-a-uuid";
    const {
      assertAcceptanceDatabaseWriteAuthorized,
      AcceptanceWriteNotAuthorizedError,
    } = await import("../scripts/acceptance/db.mjs");
    const fakeClient = { query: async () => ({ rows: [{ marker: "x" }] }) };
    await expect(
      assertAcceptanceDatabaseWriteAuthorized(fakeClient),
    ).rejects.toThrow(AcceptanceWriteNotAuthorizedError);
  });

  it("fails closed when the marker table does not exist on the target, even with everything else set", async () => {
    clearAcceptanceVars();
    setValidWriteEnv();
    const {
      assertAcceptanceDatabaseWriteAuthorized,
      AcceptanceWriteNotAuthorizedError,
    } = await import("../scripts/acceptance/db.mjs");
    const fakeClient = {
      query: async () => {
        throw new Error('relation "_ducelio_acceptance_marker" does not exist');
      },
    };
    await expect(
      assertAcceptanceDatabaseWriteAuthorized(fakeClient),
    ).rejects.toThrow(AcceptanceWriteNotAuthorizedError);
  });

  it("fails closed when the marker table exists but no row matches, even with everything else set", async () => {
    clearAcceptanceVars();
    setValidWriteEnv();
    const {
      assertAcceptanceDatabaseWriteAuthorized,
      AcceptanceWriteNotAuthorizedError,
    } = await import("../scripts/acceptance/db.mjs");
    const fakeClient = { query: async () => ({ rows: [] }) };
    await expect(
      assertAcceptanceDatabaseWriteAuthorized(fakeClient),
    ).rejects.toThrow(AcceptanceWriteNotAuthorizedError);
  });

  it("fails closed when the marker row's environment_id does not match ACCEPTANCE_ENVIRONMENT_ID (local mismatch)", async () => {
    clearAcceptanceVars();
    setValidWriteEnv(VALID_ENV_ID);
    const {
      assertAcceptanceDatabaseWriteAuthorized,
      AcceptanceWriteNotAuthorizedError,
    } = await import("../scripts/acceptance/db.mjs");
    // The query itself filters on environment_id=$2::uuid -- a fake client
    // simulating a real database returns no row when the id does not
    // match, exactly as Postgres would.
    const fakeClient = {
      query: async (_sql: string, params: unknown[]) =>
        params[1] === VALID_ENV_ID ? { rows: [{ marker: "x" }] } : { rows: [] },
    };
    process.env.ACCEPTANCE_ENVIRONMENT_ID = OTHER_ENV_ID;
    await expect(
      assertAcceptanceDatabaseWriteAuthorized(fakeClient),
    ).rejects.toThrow(AcceptanceWriteNotAuthorizedError);
  });

  it("succeeds only when the opt-in, a valid environment id, and a matching in-database marker row are ALL present, and queries by both marker and environment id", async () => {
    clearAcceptanceVars();
    setValidWriteEnv(VALID_ENV_ID);
    const {
      assertAcceptanceDatabaseWriteAuthorized,
      ACCEPTANCE_MARKER_TABLE,
      ACCEPTANCE_MARKER_VALUE,
    } = await import("../scripts/acceptance/db.mjs");
    let queriedSql = "";
    let queriedParams: unknown[] = [];
    const fakeClient = {
      query: async (sql: string, params: unknown[]) => {
        queriedSql = sql;
        queriedParams = params;
        return { rows: [{ marker: ACCEPTANCE_MARKER_VALUE }] };
      },
    };
    await expect(
      assertAcceptanceDatabaseWriteAuthorized(fakeClient),
    ).resolves.toBeUndefined();
    expect(queriedSql).toContain(ACCEPTANCE_MARKER_TABLE);
    expect(queriedSql).toContain("environment_id");
    expect(queriedParams).toEqual([ACCEPTANCE_MARKER_VALUE, VALID_ENV_ID]);
  });

  it("assertAllAcceptanceDatabaseWriteAuthorized gates EVERY connection independently, not just the first", async () => {
    clearAcceptanceVars();
    setValidWriteEnv();
    const { assertAllAcceptanceDatabaseWriteAuthorized } =
      await import("../scripts/acceptance/db.mjs");
    let calls = 0;
    const goodClient = () => {
      calls++;
      return { query: async () => ({ rows: [{ marker: "x" }] }) };
    };
    const clients = [goodClient(), goodClient(), goodClient()];
    await expect(
      assertAllAcceptanceDatabaseWriteAuthorized(clients),
    ).resolves.toBeUndefined();
    expect(calls).toBe(3);
  });

  it("assertAllAcceptanceDatabaseWriteAuthorized rejects if ANY one of several connections fails its own gate", async () => {
    clearAcceptanceVars();
    setValidWriteEnv();
    const {
      assertAllAcceptanceDatabaseWriteAuthorized,
      AcceptanceWriteNotAuthorizedError,
    } = await import("../scripts/acceptance/db.mjs");
    const okClient = { query: async () => ({ rows: [{ marker: "x" }] }) };
    const badClient = { query: async () => ({ rows: [] }) };
    await expect(
      assertAllAcceptanceDatabaseWriteAuthorized([okClient, badClient]),
    ).rejects.toThrow(AcceptanceWriteNotAuthorizedError);
  });

  it("every writing scenario in concurrency.mjs gates every client it opens via connectMany, not only clients[0]", async () => {
    // Independent-review finding 2: static proof that no scenario reverted
    // to gating a single representative connection.
    const text = await readFile(
      new URL("../scripts/acceptance/concurrency.mjs", import.meta.url),
      "utf8",
    );
    expect(text).not.toContain(
      "assertAcceptanceDatabaseWriteAuthorized(clients[0])",
    );
    const connectManyBlocks = text.split("await connectMany(2)").length - 1;
    const allGatedCalls = (
      text.match(/assertAllAcceptanceDatabaseWriteAuthorized\(clients\)/g) ?? []
    ).length;
    expect(connectManyBlocks).toBeGreaterThan(0);
    expect(allGatedCalls).toBe(connectManyBlocks);
  });

  it("the exported provisioning SQL generator creates exactly the marker table/row this gate checks, embeds the given environment id, and never a broader grant", async () => {
    const {
      acceptanceMarkerProvisioningSql,
      ACCEPTANCE_MARKER_TABLE,
      ACCEPTANCE_MARKER_VALUE,
    } = await import("../scripts/acceptance/db.mjs");
    const sql = acceptanceMarkerProvisioningSql(VALID_ENV_ID);
    expect(sql).toContain(
      `create table if not exists public.${ACCEPTANCE_MARKER_TABLE}`,
    );
    expect(sql).toContain("environment_id uuid not null");
    expect(sql).toContain(ACCEPTANCE_MARKER_VALUE);
    expect(sql).toContain(VALID_ENV_ID);
    expect(sql.toUpperCase()).not.toMatch(/\bGRANT\b|\bTRUNCATE\b|\bDROP\b/);
  });

  it("surfaces.mjs imports AcceptanceWriteNotAuthorizedError and maps it to BLOCKED, never FAIL, in checkResultProgressCompletion's catch block", async () => {
    // Static/structural proof (no network calls, no hosted infra needed):
    // the source itself must distinguish an authorization denial from a
    // genuine product-behaviour failure, rather than the two being
    // observationally indistinguishable at the call site.
    const text = await readFile(
      new URL("../scripts/acceptance/surfaces.mjs", import.meta.url),
      "utf8",
    );
    expect(text).toContain("AcceptanceWriteNotAuthorizedError");
    expect(text).toMatch(
      /error instanceof AcceptanceWriteNotAuthorizedError\s*\)\s*\n?\s*return blocked\(/,
    );
  });
});

describe("acceptance harness: every cleanup write connection is gated (independent-review finding 1, prior pass)", () => {
  it("concurrency.mjs no longer attempts to DELETE anything at all -- every table the owning chain touches now unconditionally rejects DELETE (schema-consistency audit, this pass)", async () => {
    // Independent-review finding: commercial_v1_examiner_executions,
    // commercial_v1_examiner_recovery_executions,
    // commercial_v1_assessment_result_revisions,
    // commercial_v1_completion_receipts and assessment_attempts all now
    // carry a guard/append-only trigger that unconditionally rejects
    // DELETE (migrations 2609090016/2609160031/2609240040/2609150030),
    // and the governed course/activation/enrolment graph
    // seedAcceptanceCourse builds is immutable the instant it is
    // published/enrolled (migration 2609080001's
    // guard_curriculum_version). The previous cleanup() DELETE loop, and
    // the two ungated-then-gated post-race DELETEs in
    // scenarioRecoveryVsRecovery, would throw on every real hosted run.
    // There is no longer a `cleanup(` function, and no `delete from` of
    // any kind in this file -- every row this run creates is left in
    // place as permanent, run-scoped institutional history instead (see
    // logAcceptanceChain).
    const text = await readFile(
      new URL("../scripts/acceptance/concurrency.mjs", import.meta.url),
      "utf8",
    );
    expect(text).not.toMatch(/\bdelete\s+from\b/i);
    expect(text).not.toMatch(/function\s+cleanup\s*\(/);
    expect(text).toContain("function logAcceptanceChain(chain)");
    expect(text).toMatch(/finally\s*\{\s*logAcceptanceChain\(chain\);\s*\}/);
  });

  it("no bare withConnection( call site in concurrency.mjs or fixtures.mjs is followed by a DELETE/INSERT/UPDATE statement -- every mutation goes through withAcceptanceWriteConnection", async () => {
    for (const file of ["concurrency.mjs", "fixtures.mjs"]) {
      const text = await readFile(
        new URL(`../scripts/acceptance/${file}`, import.meta.url),
        "utf8",
      );
      // Every literal "withConnection(" NOT preceded by "Acceptance" (i.e.
      // not part of "withAcceptanceWriteConnection(") is a bare, ungated
      // connection -- legitimate ONLY for read-only introspection. Extract
      // exactly that call's own (paren-balanced) argument list -- never a
      // fixed window, which could bleed into an unrelated, later,
      // correctly-gated statement -- and assert it never contains a
      // mutating statement.
      function extractBalancedCall(openParenIndex: number): string {
        let depth = 0;
        for (let i = openParenIndex; i < text.length; i++) {
          if (text[i] === "(") depth++;
          else if (text[i] === ")") {
            depth--;
            if (depth === 0) return text.slice(openParenIndex, i + 1);
          }
        }
        return text.slice(openParenIndex);
      }
      const bareCallIndices: number[] = [];
      const re = /withConnection\(/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(text))) {
        const precedingText = text.slice(
          Math.max(0, match.index - 10),
          match.index,
        );
        if (!precedingText.endsWith("Acceptance"))
          bareCallIndices.push(match.index);
      }
      expect(bareCallIndices.length).toBeGreaterThan(0);
      for (const index of bareCallIndices) {
        const openParenIndex = index + "withConnection".length;
        const call = extractBalancedCall(openParenIndex).toLowerCase();
        expect(call).not.toMatch(/\bdelete\s+from\b/);
        expect(call).not.toMatch(/\binsert\s+into\b/);
        expect(call).not.toMatch(/\bupdate\s+\w+\s+set\b/);
      }
    }
  });

  it("surfaces.mjs never imports assertAcceptanceDatabaseWriteAuthorized directly for a single-connection write -- withAcceptanceWriteConnection or the two-client gate are the only sanctioned shapes", async () => {
    const text = await readFile(
      new URL("../scripts/acceptance/concurrency.mjs", import.meta.url),
      "utf8",
    );
    // The old per-function `assertAcceptanceDatabaseWriteAuthorized(client)`
    // calls this pass removed must not have crept back in as a duplicate,
    // now-redundant gate that could mask an ungated caller elsewhere.
    expect(text).not.toContain(
      "assertAcceptanceDatabaseWriteAuthorized(client)",
    );
    expect(text).not.toContain("assertAcceptanceDatabaseWriteAuthorized(c)");
  });

  describe("withAcceptanceWriteConnection behavioural proof (mocked pg, no real database)", () => {
    afterEach(() => {
      vi.doUnmock("pg");
      vi.resetModules();
    });

    it("never invokes work, and still closes the connection, when the gate is not authorized", async () => {
      clearAcceptanceVars();
      process.env.ACCEPTANCE_DATABASE_URL =
        "postgresql://acceptance:acceptance@localhost:5432/acceptance";
      // ACCEPTANCE_WRITE_ENABLED deliberately left unset.
      let ended = false;
      const fakeClient = {
        connect: async () => {},
        end: async () => {
          ended = true;
        },
        query: async () => ({ rows: [] }),
      };
      vi.doMock("pg", () => ({
        default: {
          Client: function FakeClient() {
            return fakeClient;
          },
        },
      }));
      vi.resetModules();
      const {
        withAcceptanceWriteConnection,
        AcceptanceWriteNotAuthorizedError,
      } = await import("../scripts/acceptance/db.mjs");
      const work = vi.fn();
      await expect(withAcceptanceWriteConnection(work)).rejects.toThrow(
        AcceptanceWriteNotAuthorizedError,
      );
      expect(work).not.toHaveBeenCalled();
      expect(ended).toBe(true);
    });

    it("invokes work only after the gate passes, with the same client, and closes the connection on success", async () => {
      clearAcceptanceVars();
      process.env.ACCEPTANCE_DATABASE_URL =
        "postgresql://acceptance:acceptance@localhost:5432/acceptance";
      process.env.ACCEPTANCE_WRITE_ENABLED = "true";
      process.env.ACCEPTANCE_ENVIRONMENT_ID = VALID_ENV_ID;
      let ended = false;
      const fakeClient = {
        connect: async () => {},
        end: async () => {
          ended = true;
        },
        query: async () => ({ rows: [{ marker: "x" }] }),
      };
      vi.doMock("pg", () => ({
        default: {
          Client: function FakeClient() {
            return fakeClient;
          },
        },
      }));
      vi.resetModules();
      const { withAcceptanceWriteConnection } =
        await import("../scripts/acceptance/db.mjs");
      const work = vi.fn(async (c: unknown) => {
        expect(c).toBe(fakeClient);
        return "ok";
      });
      const result = await withAcceptanceWriteConnection(work);
      expect(result).toBe("ok");
      expect(work).toHaveBeenCalledTimes(1);
      expect(ended).toBe(true);
    });

    it("still closes the connection when work itself throws", async () => {
      clearAcceptanceVars();
      process.env.ACCEPTANCE_DATABASE_URL =
        "postgresql://acceptance:acceptance@localhost:5432/acceptance";
      process.env.ACCEPTANCE_WRITE_ENABLED = "true";
      process.env.ACCEPTANCE_ENVIRONMENT_ID = VALID_ENV_ID;
      let ended = false;
      const fakeClient = {
        connect: async () => {},
        end: async () => {
          ended = true;
        },
        query: async () => ({ rows: [{ marker: "x" }] }),
      };
      vi.doMock("pg", () => ({
        default: {
          Client: function FakeClient() {
            return fakeClient;
          },
        },
      }));
      vi.resetModules();
      const { withAcceptanceWriteConnection } =
        await import("../scripts/acceptance/db.mjs");
      await expect(
        withAcceptanceWriteConnection(async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(ended).toBe(true);
    });
  });
});

describe("acceptance harness: owning-chain schema-consistency audit (concurrency.mjs no longer builds its own raw programme/version/activation graph)", () => {
  it("concurrency.mjs no longer inserts programmes/programme_versions/app_users/course_package_imports/course_activations/modules/lessons directly -- it builds the owning chain through fixtures.mjs's governed RPC pipeline", async () => {
    // Independent-review finding: the old seedOwningChain() inserted
    // programme_versions directly as PUBLISHED (migration 2609080006
    // rejects this: "Create programme versions as DRAFT and publish
    // after content validation"), a synthetic app_users row violating
    // the base identity check (auth_user_id is not null or is_demo),
    // lessons missing programme_version_id, course_package_imports
    // PUBLISHED without lifecycle metadata, and course_activations
    // without the course_activation_versions binding migration
    // 2609140027 requires. None of that raw graph-building code may
    // exist any more.
    const text = await readFile(
      new URL("../scripts/acceptance/concurrency.mjs", import.meta.url),
      "utf8",
    );
    for (const table of [
      "insert into programmes(",
      "insert into programme_versions(",
      "insert into app_users(",
      "insert into student_profiles(",
      "insert into cohorts(",
      "insert into course_package_imports(",
      "insert into course_activations(",
      "insert into modules(",
      "insert into lessons(",
      "insert into assessments(",
    ]) {
      expect(text.toLowerCase()).not.toContain(table);
    }
    expect(text).not.toMatch(/'PUBLISHED'/);
    // V7 also imports seedAcceptanceResults (COMPLETION_VS_COMPLETION's
    // separate completion-ready course).
    expect(text).toMatch(
      /import \{\s*seedAcceptanceCourse,\s*seedAcceptanceAttempt,\s*seedAcceptanceResults,\s*\} from "\.\/fixtures\.mjs"/,
    );
    expect(text).toMatch(/await seedAcceptanceCourse\(/);
  });

  it("concurrency.mjs's main() BLOCKS, before any write, when hosted Supabase or acceptance identities are not configured -- the owning chain now needs real Auth identities, not only a direct database connection", async () => {
    const text = await readFile(
      new URL("../scripts/acceptance/concurrency.mjs", import.meta.url),
      "utf8",
    );
    expect(text).toContain("hostedSupabaseConfigured()");
    expect(text).toContain("acceptanceIdentitiesConfigured()");
    expect(text).toMatch(
      /if\s*\(\s*!hostedSupabaseConfigured\(\)\s*\|\|\s*!acceptanceIdentitiesConfigured\(\)\s*\)\s*\{/,
    );
  });

  it("fixtures.mjs's seedAcceptanceCourse resolves the real app_users.id from the Auth user id it is given, rather than trusting the caller already resolved it (auth.users.id and app_users.id are separately generated uuids)", async () => {
    const text = await readFile(
      new URL("../scripts/acceptance/fixtures.mjs", import.meta.url),
      "utf8",
    );
    expect(text).toMatch(
      /resolveAppUserId\(\s*client,\s*learnerAuthUserId,?\s*\)/,
    );
    expect(text).toMatch(
      /if\s*\(\s*!resolvedStudentId\s*\)\s*\n?\s*throw new Error/,
    );
    expect(text).toContain("p_student_id: studentId");
    // The old, incorrect shape must be gone.
    expect(text).not.toContain("p_student_id: learnerUserId");
  });

  it("fixtures.mjs never inserts a literal null attempt_id/submission_id into commercial_v1_assessment_result_revisions or commercial_v1_lab_result_revisions -- both columns are NOT NULL (migration 2609150030)", async () => {
    const text = await readFile(
      new URL("../scripts/acceptance/fixtures.mjs", import.meta.url),
      "utf8",
    );
    expect(text).not.toMatch(/,null,\$\d+,1,\$\d+,10,/); // old lab-result shape with a literal null submission_id
    expect(text).not.toMatch(/\$4,null,\$5,1,\$6,10,/); // old assessment-result shape with a literal null attempt_id
    expect(text).toContain("seedAcceptanceAttempt(client");
    expect(text).toContain("seedAcceptanceLabSubmission(client");
  });

  it("seedAcceptanceAttempt inserts assessment_attempts as SUBMITTED (never ACTIVE, so it never collides with one_active_controlled_assessment_per_student) and seedAcceptanceLabSubmission supplies a unique idempotency_key", async () => {
    const text = await readFile(
      new URL("../scripts/acceptance/fixtures.mjs", import.meta.url),
      "utf8",
    );
    const attemptFn = text.slice(
      text.indexOf("export async function seedAcceptanceAttempt"),
      text.indexOf("export async function seedAcceptanceLabSubmission"),
    );
    expect(attemptFn).toContain("'SUBMITTED'");
    expect(attemptFn).not.toContain("'ACTIVE'");
    const labFn = text.slice(
      text.indexOf("export async function seedAcceptanceLabSubmission"),
      text.indexOf("export async function seedAcceptanceResults"),
    );
    expect(labFn).toContain("idempotency_key");
    expect(labFn).toContain("idempotencySeed");
  });

  it("resolveAppUserId (db.mjs) queries app_users by auth_user_id and returns null, never throws, when no row is linked", async () => {
    const { resolveAppUserId } = await import("../scripts/acceptance/db.mjs");
    let queriedSql = "";
    let queriedParams: unknown[] = [];
    const fakeClient = {
      query: async (sql: string, params: unknown[]) => {
        queriedSql = sql;
        queriedParams = params;
        return { rows: [] };
      },
    };
    const authId = "b0000000-0000-4000-8000-000000000002";
    const result = await resolveAppUserId(fakeClient, authId);
    expect(result).toBeNull();
    expect(queriedSql.toLowerCase()).toContain("app_users");
    expect(queriedSql.toLowerCase()).toContain("auth_user_id");
    expect(queriedParams).toEqual([authId]);
  });

  it("resolveAppUserId returns the matched app_users.id when a row is linked", async () => {
    const { resolveAppUserId } = await import("../scripts/acceptance/db.mjs");
    const appUserId = "c0000000-0000-4000-8000-000000000003";
    const fakeClient = {
      query: async () => ({ rows: [{ id: appUserId }] }),
    };
    const result = await resolveAppUserId(
      fakeClient,
      "b0000000-0000-4000-8000-000000000002",
    );
    expect(result).toBe(appUserId);
  });
});

describe("acceptance harness: seedAcceptanceCourse's six assessment windows are deterministic and non-overlapping (independent-review finding 1, v4, BLOCKER)", () => {
  it("derives all six windows from ONE captured base timestamp, strictly sequential in QUIZ_1->QUIZ_2->MIDTERM->QUIZ_3->QUIZ_4->FINAL order, each window comfortably wider than the 30-minute duration", async () => {
    // Independent-review finding: every one of the six components
    // previously shared the EXACT SAME opens_at/closes_at window, which
    // publish_commercial_v1_grading_policy (migration 2609140029) always
    // rejects with ASSESSMENT_SEQUENCE_INVALID (a later component's
    // opens_at must never be earlier than the previous component's
    // closes_at, in that fixed order) -- seedAcceptanceCourse could never
    // actually reach a published grading policy. This is a static proof
    // that the fix's window-construction shape is present in source
    // (real, migrated-schema proof of the RPC pipeline itself would
    // additionally require mocking the full Supabase RPC path, which is
    // out of scope for this focused correction).
    const text = await readFile(
      new URL("../scripts/acceptance/fixtures.mjs", import.meta.url),
      "utf8",
    );
    expect(text).toContain("const baseTime = Date.now() - 3600_000;");
    expect(text).toContain("const windowMinutes = 120;");
    // Every window's opensAt/closesAt must derive from baseTime + a
    // multiple of windowMinutes -- never Date.now() called again per
    // component (which is exactly how every window ended up identical).
    const fnStart = text.indexOf("const p_assessments = COMPONENTS.map(");
    const fnEnd = text.indexOf("}));", fnStart) + 4;
    const windowBuilder = text.slice(fnStart, fnEnd);
    expect(windowBuilder).not.toContain("Date.now()");
    expect(windowBuilder).toContain("baseTime + index * windowMinutes");
    expect(windowBuilder).toContain("baseTime + (index + 1) * windowMinutes");

    // Behavioural proof of the pure arithmetic itself: replay the exact
    // shape against the real COMPONENTS order and confirm strictly
    // sequential, non-overlapping windows each >= 30 minutes wide.
    const COMPONENTS = [
      "QUIZ_1",
      "QUIZ_2",
      "MIDTERM",
      "QUIZ_3",
      "QUIZ_4",
      "FINAL",
    ];
    const baseTime = Date.now() - 3600_000;
    const windowMinutes = 120;
    const windows = COMPONENTS.map((c, index) => ({
      component: c,
      opensAt: baseTime + index * windowMinutes * 60_000,
      closesAt: baseTime + (index + 1) * windowMinutes * 60_000,
    }));
    for (let i = 0; i < windows.length; i++) {
      expect(windows[i].closesAt - windows[i].opensAt).toBeGreaterThanOrEqual(
        30 * 60_000,
      );
      if (i > 0) {
        // Never earlier than the previous component's closes_at -- the
        // exact condition publish_commercial_v1_grading_policy checks.
        expect(windows[i].opensAt).toBeGreaterThanOrEqual(
          windows[i - 1].closesAt,
        );
      }
    }
  });
});

describe("acceptance harness: concurrency races only treat a SQLSTATE 23505 rejection as the intended loser (independent-review finding 2, v4, BLOCKER)", () => {
  it("classifyRace/isUniqueViolation exist and every scenario's PASS condition requires uniqueRejected===1 && otherRejections.length===0, never a bare rejected-count", async () => {
    const text = await readFile(
      new URL("../scripts/acceptance/concurrency.mjs", import.meta.url),
      "utf8",
    );
    expect(text).toContain('const UNIQUE_VIOLATION_SQLSTATE = "23505";');
    expect(text).toContain("reason.code === UNIQUE_VIOLATION_SQLSTATE");
    expect(text).toContain("function classifyRace(settled)");
    // INITIAL_VS_INITIAL and RECOVERY_VS_RECOVERY check `rows[0].n === 1`;
    // NEVER_TWO_REVISION_ONES (V7) additionally requires the one surviving
    // QUIZ_1 revision to be revision 1, valid, and the winner's own id.
    // COMPLETION_VS_COMPLETION (V7) is no longer a raw-insert race at all
    // (it drives the governed RPC), so it has no 23505 pass condition.
    const passConditions = text.match(
      /if \(\s*\n\s*fulfilled === 1 &&\s*\n\s*uniqueRejected === 1 &&\s*\n\s*otherRejections\.length === 0 &&\s*\n\s*(rows\[0\]\.n === 1|survivor\?\.revision_number === 1 &&\s*\n\s*survivor\.valid === true &&\s*\n\s*survivor\.id === winnerId)\s*\n\s*\)/g,
    );
    expect(passConditions).not.toBeNull();
    // INITIAL_VS_INITIAL, RECOVERY_VS_RECOVERY, NEVER_TWO_REVISION_ONES.
    expect(passConditions!.length).toBe(3);
    // The old, insufficient shape (a bare boolean rejected-count with no
    // SQLSTATE check) must be gone from every scenario.
    expect(text).not.toMatch(
      /const rejected = settled\.filter\(\(s\) => s\.status === "rejected"\)\.length;/,
    );
  });

  it("behaviourally: a non-unique-violation rejection (e.g. a permission error) produces FAIL, never PASS, even when exactly one side is rejected", async () => {
    clearAcceptanceVars();
    process.env.ACCEPTANCE_DATABASE_URL =
      "postgresql://acceptance:acceptance@localhost:5432/acceptance";
    process.env.ACCEPTANCE_WRITE_ENABLED = "true";
    process.env.ACCEPTANCE_ENVIRONMENT_ID = VALID_ENV_ID;
    let call = 0;
    function FakeClient() {
      return {
        connect: async () => {},
        end: async () => {},
        query: async (sql: string) => {
          if (sql.includes("acceptance_marker"))
            return { rows: [{ marker: "x" }] };
          if (/select\s+count\(\*\)/i.test(sql)) return { rows: [{ n: 1 }] };
          call += 1;
          if (call === 1) return { rows: [] }; // the "winner"
          // The "loser" -- a permission error, NOT a unique violation.
          const err = Object.assign(new Error("permission denied"), {
            code: "42501",
          });
          throw err;
        },
      };
    }
    vi.doMock("pg", () => ({ default: { Client: FakeClient } }));
    vi.resetModules();
    const { scenarioInitialVsInitial } =
      await import("../scripts/acceptance/concurrency.mjs");
    const result = await scenarioInitialVsInitial({
      studentId: "s1",
      enrolmentId: "e1",
      activationId: "a1",
      attemptId: "quiz1-attempt",
    });
    vi.doUnmock("pg");
    vi.resetModules();
    expect(result.status).toBe("FAIL");
  });
});

describe("acceptance harness: NEVER_TWO_REVISION_ONES builds each contender's COMPLETE revision inside its own transaction before COMMIT (V7, Defect A)", () => {
  // The real-schema proof (what actually gets committed/rolled back on the
  // migrated PGlite schema) lives in tests/acceptance-concurrency-schema.
  // test.ts. These mocked-pg tests prove the harness's own control flow:
  // independent connections, the start gate, per-client statement order,
  // rollback on failure, and the post-race survivor checks.
  afterEach(() => {
    vi.doUnmock("pg");
    vi.resetModules();
  });

  const chain = {
    studentId: "s1",
    enrolmentId: "e1",
    activationId: "a1",
    assessmentId: "quiz1-assessment",
    attemptId: "quiz1-attempt",
  };

  type Event = { client: number; sql: string; params: unknown[] };
  function mockRevisionRace(
    options: {
      invalid?: boolean;
      survivors?: { id: string; revision_number: number; valid: boolean }[];
    } = {},
  ) {
    clearAcceptanceVars();
    process.env.ACCEPTANCE_DATABASE_URL =
      "postgresql://acceptance:acceptance@localhost:5432/acceptance";
    process.env.ACCEPTANCE_WRITE_ENABLED = "true";
    process.env.ACCEPTANCE_ENVIRONMENT_ID = VALID_ENV_ID;
    const events: Event[] = [];
    let nextClient = 0;
    let revisionInserts = 0;
    function FakeClient() {
      const client = nextClient++;
      return {
        connect: async () => {},
        end: async () => {},
        query: async (sql: string, params: unknown[] = []) => {
          const text = sql.trim().toLowerCase();
          events.push({ client, sql: text, params });
          if (text.includes("acceptance_marker"))
            return { rows: [{ marker: "x" }] };
          if (text === "begin") {
            // The SECOND connection's BEGIN is deliberately slow: without
            // the start gate, the first contender would already have sent
            // its INSERT before this one is ready.
            if (client % 2 === 0)
              await new Promise((resolve) => setTimeout(resolve, 20));
            events.push({ client, sql: "begin:done", params: [] });
            return { rows: [] };
          }
          if (text.startsWith("select id, max_marks from assessment_questions"))
            return {
              rows: [
                { id: "q1", max_marks: 10 },
                { id: "q2", max_marks: 5 },
              ],
            };
          if (
            text.startsWith(
              "insert into commercial_v1_assessment_result_revisions",
            )
          ) {
            revisionInserts += 1;
            if (revisionInserts === 1) return { rows: [{ id: "rev-winner" }] };
            throw Object.assign(new Error("duplicate key value"), {
              code: "23505",
            });
          }
          if (text.includes("assessment_result_is_valid($1) as valid"))
            return { rows: [{ valid: !options.invalid }] };
          if (text.includes("from commercial_v1_assessment_result_revisions"))
            return {
              rows: options.survivors ?? [
                { id: "rev-winner", revision_number: 1, valid: true },
              ],
            };
          return { rows: [] };
        },
      };
    }
    vi.doMock("pg", () => ({ default: { Client: FakeClient } }));
    vi.resetModules();
    return events;
  }

  function contenderClients(events: Event[]) {
    return [
      ...new Set(events.filter((e) => e.sql === "begin").map((e) => e.client)),
    ];
  }

  it("PASS: two independent, individually gated connections each BEGIN, wait at one start gate, and the winner writes revision -> every question mark -> objective outcomes -> validity -> COMMIT on its own connection; the 23505 loser rolls back", async () => {
    const events = mockRevisionRace();
    const { scenarioNeverTwoRevisionOnes } =
      await import("../scripts/acceptance/concurrency.mjs");
    const result = await scenarioNeverTwoRevisionOnes(chain);
    expect(result.status).toBe("PASS");

    const contenders = contenderClients(events);
    expect(contenders.length).toBe(2);
    for (const client of contenders) {
      const own = events.filter((e) => e.client === client).map((e) => e.sql);
      // Each contender connection is gated BEFORE its transaction begins.
      const gateAt = own.findIndex((s) => s.includes("acceptance_marker"));
      expect(gateAt).toBeGreaterThanOrEqual(0);
      expect(gateAt).toBeLessThan(own.indexOf("begin"));
    }
    // Start gate: BOTH transactions were open before EITHER revision INSERT.
    const firstInsert = events.findIndex((e) =>
      e.sql.startsWith("insert into commercial_v1_assessment_result_revisions"),
    );
    const beginsDone = events
      .map((e, i) => (e.sql === "begin:done" ? i : -1))
      .filter((i) => i >= 0);
    expect(beginsDone.length).toBe(2);
    expect(Math.max(...beginsDone)).toBeLessThan(firstInsert);

    const commits = events.filter((e) => e.sql === "commit");
    expect(commits.length).toBe(1);
    const winner = events
      .filter((e) => e.client === commits[0].client)
      .map((e) => e.sql);
    const revisionAt = winner.findIndex((s) =>
      s.startsWith("insert into commercial_v1_assessment_result_revisions"),
    );
    const marks = winner
      .map((s, i) =>
        s.startsWith("insert into commercial_v1_assessment_question_marks")
          ? i
          : -1,
      )
      .filter((i) => i >= 0);
    const deriveAt = winner.findIndex((s) =>
      s.includes("derive_and_insert_objective_outcomes($1)"),
    );
    const validAt = winner.findIndex((s) =>
      s.includes("assessment_result_is_valid($1) as valid"),
    );
    expect(marks.length).toBe(2); // one per REAL question
    expect(Math.min(...marks)).toBeGreaterThan(revisionAt);
    expect(deriveAt).toBeGreaterThan(Math.max(...marks));
    expect(validAt).toBeGreaterThan(deriveAt);
    expect(winner.indexOf("commit")).toBeGreaterThan(validAt);
    // max_marks_total derives from the REAL questions (10 + 5), never 10.
    const revisionInsert = events.find(
      (e) =>
        e.client === commits[0].client &&
        e.sql.startsWith(
          "insert into commercial_v1_assessment_result_revisions",
        ),
    )!;
    expect(revisionInsert.params).toContain(15);

    const loser = events
      .filter(
        (e) => e.client !== commits[0].client && contenders.includes(e.client),
      )
      .map((e) => e.sql);
    expect(loser).toContain("rollback");
    expect(loser).not.toContain("commit");
    expect(
      loser.some((s) =>
        s.startsWith("insert into commercial_v1_assessment_question_marks"),
      ),
    ).toBe(false);
  });

  it("a validity result other than exactly true ROLLS BACK inside the contender transaction -- COMMIT is never sent, and the scenario FAILs", async () => {
    const events = mockRevisionRace({ invalid: true });
    const { scenarioNeverTwoRevisionOnes } =
      await import("../scripts/acceptance/concurrency.mjs");
    const result = await scenarioNeverTwoRevisionOnes(chain);
    expect(result.status).toBe("FAIL");
    expect(events.some((e) => e.sql === "commit")).toBe(false);
    expect(events.filter((e) => e.sql === "rollback").length).toBe(2);
    expect(result.details?.join("\n")).toContain(
      "rolled back, never committed",
    );
  });

  it.each([
    [
      "the surviving revision is not valid",
      [{ id: "rev-winner", revision_number: 1, valid: false }],
    ],
    [
      "two QUIZ_1 revisions survive",
      [
        { id: "rev-winner", revision_number: 1, valid: true },
        { id: "rev-other", revision_number: 1, valid: true },
      ],
    ],
    [
      "the surviving revision is not the winner's",
      [{ id: "rev-other", revision_number: 1, valid: true }],
    ],
    ["no revision survives", []],
  ])(
    "FAIL even after a clean 1-commit/1-23505 race when %s",
    async (_label, survivors) => {
      mockRevisionRace({ survivors });
      const { scenarioNeverTwoRevisionOnes } =
        await import("../scripts/acceptance/concurrency.mjs");
      const result = await scenarioNeverTwoRevisionOnes(chain);
      expect(result.status).toBe("FAIL");
    },
  );

  it("the acceptance write gate stays mandatory: without ACCEPTANCE_WRITE_ENABLED it throws AcceptanceWriteNotAuthorizedError before any BEGIN or INSERT", async () => {
    const events = mockRevisionRace();
    delete process.env.ACCEPTANCE_WRITE_ENABLED;
    const { scenarioNeverTwoRevisionOnes } =
      await import("../scripts/acceptance/concurrency.mjs");
    const { AcceptanceWriteNotAuthorizedError } =
      await import("../scripts/acceptance/db.mjs");
    await expect(scenarioNeverTwoRevisionOnes(chain)).rejects.toBeInstanceOf(
      AcceptanceWriteNotAuthorizedError,
    );
    expect(events.some((e) => e.sql === "begin")).toBe(false);
    expect(events.some((e) => e.sql.startsWith("insert"))).toBe(false);
  });
});

describe("acceptance harness: createStartGate releases every contender together only once all have arrived (V7)", () => {
  it("no arrive() promise resolves until the last party arrives, then all resolve", async () => {
    const { createStartGate } =
      await import("../scripts/acceptance/concurrency.mjs");
    const gate = createStartGate(2);
    let released = 0;
    const first = gate.arrive().then(() => {
      released += 1;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(released).toBe(0);
    const second = gate.arrive().then(() => {
      released += 1;
    });
    await Promise.all([first, second]);
    expect(released).toBe(2);
  });
});

describe("acceptance harness: COMPLETION_VS_COMPLETION drives the governed completion RPC on a separate completion-ready course (V7, Defect B)", () => {
  afterEach(() => {
    vi.doUnmock("pg");
    vi.doUnmock("../scripts/acceptance/supabase.mjs");
    vi.doUnmock("../scripts/acceptance/fixtures.mjs");
    vi.resetModules();
  });

  // The owning chain NEVER_TWO_REVISION_ONES already used -- completion
  // must never touch this enrolment.
  const chain = { enrolmentId: "owning-chain-enrolment" };
  const course = {
    importId: "completion-import",
    programmeVersionId: "completion-pv",
    activationId: "completion-activation",
    cohortId: "completion-cohort",
    enrolmentId: "completion-enrolment",
    studentId: "learner-app-user",
  };
  const goodReceipt = {
    id: "receipt-1",
    student_id: "learner-app-user",
    activation_id: "completion-activation",
    cohort_id: "completion-cohort",
    programme_version_id: "completion-pv",
    final_course_score_bp: 10000,
    pass_mark_bp: 5000,
    completed_by: "learner-app-user",
  };
  const COMPLETED = {
    data: {
      ok: true,
      code: "COMPLETED",
      receiptId: "receipt-1",
      courseScoreBp: 10000,
    },
    error: null,
  };
  const ALREADY = {
    data: { ok: true, code: "ALREADY_COMPLETED", receiptId: "receipt-1" },
    error: null,
  };

  type RpcResponse = { data: unknown; error: { message: string } | null };
  type Overrides = {
    responses?: (RpcResponse | Error)[];
    receipts?: Record<string, unknown>[];
    enrolment?: Record<string, unknown>;
    activation?: Record<string, unknown>;
    audits?: number;
  };

  function mockCompletionDeps(overrides: Overrides = {}) {
    clearAcceptanceVars();
    process.env.ACCEPTANCE_DATABASE_URL =
      "postgresql://acceptance:acceptance@localhost:5432/acceptance";
    const record = {
      learnerClients: [] as object[],
      rpcCalls: [] as {
        client: object;
        name: string;
        args: Record<string, unknown>;
      }[],
      maxInFlight: 0,
      seedCourseCalls: [] as unknown[][],
      seedResultsCalls: [] as unknown[][],
      sql: [] as string[],
    };
    let inFlight = 0;
    const responses = overrides.responses ?? [COMPLETED, ALREADY];
    function learnerClient() {
      const client = {
        auth: {
          getUser: async () => ({
            data: { user: { id: "learner-auth-user" } },
            error: null,
          }),
        },
        rpc: async (name: string, args: Record<string, unknown>) => {
          const index = record.rpcCalls.length;
          record.rpcCalls.push({ client, name, args });
          inFlight += 1;
          record.maxInFlight = Math.max(record.maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
          const response = responses[index];
          if (response instanceof Error) throw response;
          return response;
        },
      };
      record.learnerClients.push(client);
      return client;
    }
    vi.doMock("../scripts/acceptance/supabase.mjs", () => ({
      hostedSupabaseConfigured: () => true,
      acceptanceIdentitiesConfigured: () => true,
      acceptanceIdentities: {
        admin: async () => ({ rpc: async () => ({ data: null, error: null }) }),
        learner: async () => learnerClient(),
      },
    }));
    vi.doMock("../scripts/acceptance/fixtures.mjs", () => ({
      seedAcceptanceCourse: async (...args: unknown[]) => {
        record.seedCourseCalls.push(args);
        return course;
      },
      seedAcceptanceResults: async (...args: unknown[]) => {
        record.seedResultsCalls.push(args);
      },
      seedAcceptanceAttempt: async () => "unused-attempt",
    }));
    function FakeClient() {
      return {
        connect: async () => {},
        end: async () => {},
        query: async (sql: string) => {
          record.sql.push(sql);
          if (sql.includes("from commercial_v1_completion_receipts"))
            return { rows: overrides.receipts ?? [goodReceipt] };
          if (sql.includes("from enrolments"))
            return {
              rows: [
                {
                  status: "COMPLETED",
                  student_id: "learner-app-user",
                  cohort_id: "completion-cohort",
                  programme_version_id: "completion-pv",
                  ...overrides.enrolment,
                },
              ],
            };
          if (sql.includes("from course_activations"))
            return {
              rows: [
                {
                  cohort_id: "completion-cohort",
                  programme_version_id: "completion-pv",
                  ...overrides.activation,
                },
              ],
            };
          if (sql.includes("from commercial_v1_result_policies"))
            return { rows: [{ pass_mark_bp: 5000 }] };
          if (sql.includes("from audit_events"))
            return { rows: [{ n: overrides.audits ?? 1 }] };
          return { rows: [] };
        },
      };
    }
    vi.doMock("pg", () => ({ default: { Client: FakeClient } }));
    vi.resetModules();
    return record;
  }

  it("PASS: seeds a SEPARATE completion course via the governed helpers, then two distinct learner sessions call attempt_commercial_v1_course_completion together on it -- no receipt is ever written directly", async () => {
    const record = mockCompletionDeps();
    const { scenarioCompletionVsCompletion } =
      await import("../scripts/acceptance/concurrency.mjs");
    const result = await scenarioCompletionVsCompletion(chain);
    expect(result.status).toBe("PASS");
    expect(result.details?.join("\n")).toContain("completion-enrolment");

    // Separate, completion-specific fixture -- never the owning chain.
    expect(record.seedCourseCalls.length).toBe(1);
    const [, completionRunId, learnerAuthUserId] = record.seedCourseCalls[0];
    expect(String(completionRunId)).toMatch(/-completion$/);
    expect(learnerAuthUserId).toBe("learner-auth-user");
    expect(record.seedResultsCalls).toEqual([[course, true]]);

    // The governed RPC, on the completion enrolment, from two DISTINCT
    // authenticated learner clients, both in flight together.
    expect(record.rpcCalls.length).toBe(2);
    for (const call of record.rpcCalls) {
      expect(call.name).toBe("attempt_commercial_v1_course_completion");
      expect(call.args.p_enrolment_id).toBe("completion-enrolment");
      expect(call.args.p_enrolment_id).not.toBe(chain.enrolmentId);
      expect(String(call.args.p_reason).trim().length).toBeGreaterThanOrEqual(
        5,
      );
    }
    expect(record.learnerClients.length).toBe(2);
    expect(record.rpcCalls[0].client).not.toBe(record.rpcCalls[1].client);
    expect(record.maxInFlight).toBe(2);

    // Direct database access is read-only verification only.
    for (const sql of record.sql) {
      expect(sql.toLowerCase()).not.toMatch(
        /\binsert\s+into\b|\bupdate\s+\w+\s+set\b/,
      );
    }
    expect(
      record.sql.some((s) =>
        s.includes("from commercial_v1_completion_receipts"),
      ),
    ).toBe(true);
  });

  it("PASS regardless of which call wins (ALREADY_COMPLETED may resolve first)", async () => {
    mockCompletionDeps({ responses: [ALREADY, COMPLETED] });
    const { scenarioCompletionVsCompletion } =
      await import("../scripts/acceptance/concurrency.mjs");
    expect((await scenarioCompletionVsCompletion(chain)).status).toBe("PASS");
  });

  it.each<[string, Overrides]>([
    ["both calls report COMPLETED", { responses: [COMPLETED, COMPLETED] }],
    ["both calls report ALREADY_COMPLETED", { responses: [ALREADY, ALREADY] }],
    [
      "one call returns a PostgREST error",
      { responses: [COMPLETED, { data: null, error: { message: "boom" } }] },
    ],
    ["one call throws", { responses: [COMPLETED, new Error("network")] }],
    [
      "one call is refused as not eligible",
      {
        responses: [
          COMPLETED,
          { data: { ok: false, code: "COMPONENTS_INCOMPLETE" }, error: null },
        ],
      },
    ],
    [
      "the two responses name different receipts",
      {
        responses: [
          COMPLETED,
          { data: { ...ALREADY.data, receiptId: "receipt-2" }, error: null },
        ],
      },
    ],
    ["no receipt exists", { receipts: [] }],
    [
      "two receipts exist",
      { receipts: [goodReceipt, { ...goodReceipt, id: "receipt-2" }] },
    ],
    ["the enrolment is still ACTIVE", { enrolment: { status: "ACTIVE" } }],
    [
      "the receipt belongs to another student",
      { receipts: [{ ...goodReceipt, student_id: "someone-else" }] },
    ],
    [
      "the receipt was completed by someone other than the learner",
      { receipts: [{ ...goodReceipt, completed_by: "an-admin" }] },
    ],
    [
      "the receipt cohort does not match the enrolment",
      { receipts: [{ ...goodReceipt, cohort_id: "other-cohort" }] },
    ],
    [
      "the activation lineage does not match the enrolment",
      { activation: { programme_version_id: "other-pv" } },
    ],
    [
      "the final score is below the pass mark",
      { receipts: [{ ...goodReceipt, final_course_score_bp: 4000 }] },
    ],
    [
      "the receipt pass mark differs from the published policy",
      { receipts: [{ ...goodReceipt, pass_mark_bp: 4000 }] },
    ],
    ["two completion audit events exist", { audits: 2 }],
  ])("FAIL when %s", async (_label, overrides) => {
    mockCompletionDeps(overrides);
    const { scenarioCompletionVsCompletion } =
      await import("../scripts/acceptance/concurrency.mjs");
    expect((await scenarioCompletionVsCompletion(chain)).status).toBe("FAIL");
  });

  it("the acceptance write gate stays mandatory: with the REAL fixtures and no ACCEPTANCE_ENVIRONMENT_ID, the completion course seed throws AcceptanceWriteNotAuthorizedError before any completion RPC", async () => {
    clearAcceptanceVars();
    const rpcNames: string[] = [];
    const client = (id: string) => ({
      auth: {
        getUser: async () => ({ data: { user: { id } }, error: null }),
      },
      rpc: async (name: string) => {
        rpcNames.push(name);
        return { data: null, error: null };
      },
    });
    vi.doMock("../scripts/acceptance/supabase.mjs", async (importOriginal) => ({
      ...(await importOriginal<Record<string, unknown>>()),
      acceptanceIdentities: {
        admin: async () => client("admin-auth-user"),
        learner: async () => client("learner-auth-user"),
      },
    }));
    vi.resetModules();
    const { scenarioCompletionVsCompletion } =
      await import("../scripts/acceptance/concurrency.mjs");
    const { AcceptanceWriteNotAuthorizedError } =
      await import("../scripts/acceptance/db.mjs");
    await expect(scenarioCompletionVsCompletion(chain)).rejects.toBeInstanceOf(
      AcceptanceWriteNotAuthorizedError,
    );
    expect(rpcNames).not.toContain("attempt_commercial_v1_course_completion");
    expect(rpcNames).toEqual([]);
  });

  it("no code path in concurrency.mjs inserts into commercial_v1_completion_receipts any more", async () => {
    const text = await readFile(
      new URL("../scripts/acceptance/concurrency.mjs", import.meta.url),
      "utf8",
    );
    const code = text
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(
      /insert\s+into\s+commercial_v1_completion_receipts/i,
    );
  });
});

describe("acceptance harness: concurrency.mjs is import-safe (independent-review finding 1, this pass)", () => {
  it("guards its top-level main() call so importing the module for tests never triggers process.exit", async () => {
    // Independent-review finding: main() calls process.exit() directly.
    // Every other test in this file that dynamically imports
    // concurrency.mjs would have crashed the whole test worker if this
    // guard were missing or broken -- this is the source-level contract
    // that makes that safe, and documents why.
    const text = await readFile(
      new URL("../scripts/acceptance/concurrency.mjs", import.meta.url),
      "utf8",
    );
    expect(text).toContain('import { pathToFileURL } from "node:url"');
    expect(text).toMatch(
      /if\s*\(\s*import\.meta\.url\s*===\s*pathToFileURL\(process\.argv\[1\]\s*\?\?\s*""\)\.href\s*\)\s*\{\s*\n?\s*await main\(\);/,
    );
  });
});

describe("acceptance harness: cross-scenario attempt isolation (independent-review finding 1, this pass, BLOCKER)", () => {
  afterEach(() => {
    vi.doUnmock("pg");
    vi.resetModules();
  });

  it("scenarioInitialVsInitial and scenarioRecoveryVsRecovery insert against genuinely DISTINCT attempt_id/component targets -- never the same attempt, proven from actual SQL/params, not source text alone", async () => {
    // Independent-review finding: commercial_v1_examiner_executions
    // carries a PERMANENT unique index on attempt_id alone
    // (examiner_execution_one_per_attempt). scenarioInitialVsInitial
    // leaves one admitted, non-deletable row for its attempt;
    // scenarioRecoveryVsRecovery's own seed insert (a second
    // commercial_v1_examiner_executions row) must never target that same
    // attempt_id, or it would violate the unique index before its race
    // even starts.
    clearAcceptanceVars();
    process.env.ACCEPTANCE_DATABASE_URL =
      "postgresql://acceptance:acceptance@localhost:5432/acceptance";
    process.env.ACCEPTANCE_WRITE_ENABLED = "true";
    process.env.ACCEPTANCE_ENVIRONMENT_ID = VALID_ENV_ID;

    const calls: { sql: string; params: unknown[] }[] = [];
    function respond(sql: string) {
      if (sql.includes("acceptance_marker")) return { rows: [{ marker: "x" }] };
      if (/select\s+count\(\*\)/i.test(sql)) return { rows: [{ n: 0 }] };
      return { rows: [] };
    }
    function FakeClient() {
      return {
        connect: async () => {},
        end: async () => {},
        query: async (sql: string, params: unknown[] = []) => {
          calls.push({ sql, params });
          return respond(sql);
        },
      };
    }
    vi.doMock("pg", () => ({ default: { Client: FakeClient } }));
    vi.resetModules();
    const { scenarioInitialVsInitial, scenarioRecoveryVsRecovery } =
      await import("../scripts/acceptance/concurrency.mjs");

    const chain = {
      studentId: "s1",
      enrolmentId: "e1",
      activationId: "a1",
      cohortId: "c1",
      versionId: "v1",
      assessmentId: "quiz1-assessment",
      attemptId: "quiz1-attempt",
      recoveryAssessmentId: "quiz2-assessment",
      recoveryAttemptId: "quiz2-attempt",
    };
    expect(chain.attemptId).not.toBe(chain.recoveryAttemptId);

    await scenarioInitialVsInitial(chain);
    await scenarioRecoveryVsRecovery(chain);

    const examinerInserts = calls.filter((c) =>
      /insert into commercial_v1_examiner_executions/i.test(c.sql),
    );
    const recoveryInserts = calls.filter((c) =>
      /insert into commercial_v1_examiner_recovery_executions/i.test(c.sql),
    );

    // scenarioInitialVsInitial's two race rows: QUIZ_1, chain.attemptId.
    const quiz1Inserts = examinerInserts.filter((c) =>
      c.sql.includes("'QUIZ_1'"),
    );
    expect(quiz1Inserts.length).toBe(2);
    for (const c of quiz1Inserts) {
      expect(c.params).toContain(chain.attemptId);
      expect(c.params).not.toContain(chain.recoveryAttemptId);
    }

    // scenarioRecoveryVsRecovery's own seed (original FAILED) row: QUIZ_2,
    // chain.recoveryAttemptId -- NEVER chain.attemptId/QUIZ_1.
    const quiz2SeedInserts = examinerInserts.filter((c) =>
      c.sql.includes("'QUIZ_2'"),
    );
    expect(quiz2SeedInserts.length).toBe(1);
    for (const c of quiz2SeedInserts) {
      expect(c.params).toContain(chain.recoveryAttemptId);
      expect(c.params).not.toContain(chain.attemptId);
    }

    // scenarioRecoveryVsRecovery's own two race rows also target QUIZ_2 /
    // chain.recoveryAttemptId only.
    expect(recoveryInserts.length).toBe(2);
    for (const c of recoveryInserts) {
      expect(c.sql).toContain("'QUIZ_2'");
      expect(c.params).toContain(chain.recoveryAttemptId);
      expect(c.params).not.toContain(chain.attemptId);
    }
  });

  it("seedOwningChain resolves two distinct bound assessments (QUIZ_1 and QUIZ_2) rather than reusing one for both attempts", async () => {
    const text = await readFile(
      new URL("../scripts/acceptance/concurrency.mjs", import.meta.url),
      "utf8",
    );
    expect(text).toMatch(/cb\.component in \('QUIZ_1','QUIZ_2'\)/);
    expect(text).toContain("recoveryAssessmentId");
    expect(text).toContain("recoveryAttemptId");
    // Two SEPARATE seedAcceptanceAttempt calls -- never a second attempt
    // fabricated against the same assessment.
    const attemptCalls = (text.match(/seedAcceptanceAttempt\(client,/g) ?? [])
      .length;
    expect(attemptCalls).toBe(2);
  });
});

describe("acceptance harness: examiner-execution timestamps satisfy migration 031/040's CHECK constraints (independent-review finding 1, v3, BLOCKER)", () => {
  // The genuine constraint-satisfaction proof lives in
  // tests/acceptance-concurrency-schema.test.ts (runs the real exported
  // scenario functions against a real migrated PGlite database, and
  // queries the real CHECK-governed columns back). These are the
  // "minimum" static/source checks the independent review additionally
  // asked for -- never a substitute for that real-schema proof, only a
  // cheap, redundant tripwire alongside it.
  it("the AUTHORIZED initial-execution insert never sets started_at (migration 2609160031's state CHECK requires it NULL)", async () => {
    const text = await readFile(
      new URL("../scripts/acceptance/concurrency.mjs", import.meta.url),
      "utf8",
    );
    const fnStart = text.indexOf(
      "export async function scenarioInitialVsInitial",
    );
    const fnEnd = text.indexOf(
      "\nexport async function scenarioRecoveryVsRecovery",
    );
    const rawFnText = text.slice(fnStart, fnEnd);
    // Strip line comments first -- this function's own explanatory
    // comment deliberately says "started_at" in prose (explaining why the
    // column is omitted), which would otherwise trip a naive substring
    // check on the comment text itself, not the actual SQL/code.
    const fnText = rawFnText
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(fnText).toContain("'AUTHORIZED'");
    expect(fnText).not.toContain("started_at");
  });

  it("every raw commercial_v1_examiner_executions/commercial_v1_examiner_recovery_executions insert derives all its timestamps from exactly ONE clock_timestamp() call per statement, via a `with stamp as (select clock_timestamp() as t)` CTE", async () => {
    const text = await readFile(
      new URL("../scripts/acceptance/concurrency.mjs", import.meta.url),
      "utf8",
    );
    // Every insert into either examiner-execution table must be preceded
    // by exactly this CTE shape -- a bare, un-CTE'd clock_timestamp() call
    // inside one of these INSERT statements is exactly the bug this fixes
    // (separate clock_timestamp() calls are not guaranteed equal, and
    // migration 031/040 require authorized_at=created_at and
    // expires_at<=created_at+20s EXACTLY).
    const insertBlocks = text.match(
      /with stamp as \(select clock_timestamp\(\) as t\)\s*\n\s*insert into commercial_v1_examiner(?:_recovery)?_executions\([\s\S]*?from stamp/g,
    );
    expect(insertBlocks).not.toBeNull();
    expect(insertBlocks!.length).toBe(3); // initial race, recovery seed, recovery race
    for (const block of insertBlocks!) {
      // Exactly one clock_timestamp() call per block -- in the CTE itself.
      const clockCalls = (block.match(/clock_timestamp\(\)/g) ?? []).length;
      expect(clockCalls).toBe(1);
      // Every other timestamp column must derive from `t` (or a fixed
      // offset of it), never a second independent call.
      expect(block).not.toMatch(/,\s*clock_timestamp\(\)/);
    }
  });

  it("behaviourally: the captured SQL for the AUTHORIZED initial-execution race never includes started_at as a target column, and issues only ONE clock_timestamp() call per insert", async () => {
    clearAcceptanceVars();
    process.env.ACCEPTANCE_DATABASE_URL =
      "postgresql://acceptance:acceptance@localhost:5432/acceptance";
    process.env.ACCEPTANCE_WRITE_ENABLED = "true";
    process.env.ACCEPTANCE_ENVIRONMENT_ID = VALID_ENV_ID;
    const calls: { sql: string; params: unknown[] }[] = [];
    function respond(sql: string) {
      if (sql.includes("acceptance_marker")) return { rows: [{ marker: "x" }] };
      if (/select\s+count\(\*\)/i.test(sql)) return { rows: [{ n: 0 }] };
      return { rows: [] };
    }
    function FakeClient() {
      return {
        connect: async () => {},
        end: async () => {},
        query: async (sql: string, params: unknown[] = []) => {
          calls.push({ sql, params });
          return respond(sql);
        },
      };
    }
    vi.doMock("pg", () => ({ default: { Client: FakeClient } }));
    vi.resetModules();
    const { scenarioInitialVsInitial } =
      await import("../scripts/acceptance/concurrency.mjs");
    await scenarioInitialVsInitial({
      studentId: "s1",
      enrolmentId: "e1",
      activationId: "a1",
      attemptId: "quiz1-attempt",
    });
    vi.doUnmock("pg");
    vi.resetModules();
    const examinerInserts = calls.filter((c) =>
      /insert into commercial_v1_examiner_executions/i.test(c.sql),
    );
    expect(examinerInserts.length).toBe(2);
    for (const c of examinerInserts) {
      expect(c.sql).not.toContain("started_at");
      expect((c.sql.match(/clock_timestamp\(\)/g) ?? []).length).toBe(1);
      expect(c.sql).toContain("with stamp as (select clock_timestamp() as t)");
    }
  });
});

describe("acceptance harness: seedAcceptanceCourse configures all five agent roles before the pre-publication test (independent-review finding, v6, BLOCKER)", () => {
  // Independent-review finding: a real hosted acceptance:concurrency run
  // (acceptance run 1790361944555-1nzbhw) confirmed the owning-chain
  // fixture stopped before any concurrency scenario ran -- the persisted
  // course_package_test_runs row recorded outcome=FAIL, failure_code=
  // CONFIGURATION_INCOMPLETE, failed_roles=PROFESSOR,TUTOR,
  // LAB_INSTRUCTOR,EXAMINER,COUNSELLOR. Migration 2609120024's
  // apply_course_package() never materialises pkg.agentConfiguration into
  // academic_agent_configs -- that requires a SEPARATE call to the
  // governed public.set_agent_config() RPC per role, which
  // seedAcceptanceCourse never made. These tests run the ACTUAL exported
  // seedAcceptanceCourse end to end (mocked admin.rpc + a minimal mocked
  // pg for its direct-DB reads/gate) and assert on the real call
  // sequence/values, never only source text.
  const COMPONENTS = [
    "QUIZ_1",
    "QUIZ_2",
    "MIDTERM",
    "QUIZ_3",
    "QUIZ_4",
    "FINAL",
  ];
  const AGENT_ROLES = [
    "PROFESSOR",
    "TUTOR",
    "LAB_INSTRUCTOR",
    "EXAMINER",
    "COUNSELLOR",
  ];

  function mockPgForCourseSeeding() {
    process.env.ACCEPTANCE_DATABASE_URL =
      "postgresql://acceptance:acceptance@localhost:5432/acceptance";
    process.env.ACCEPTANCE_WRITE_ENABLED = "true";
    process.env.ACCEPTANCE_ENVIRONMENT_ID = VALID_ENV_ID;
    function FakeClient() {
      return {
        connect: async () => {},
        end: async () => {},
        query: async (sql: string) => {
          if (sql.includes("acceptance_marker"))
            return { rows: [{ marker: "x" }] };
          if (sql.includes("select id from public.app_users"))
            return { rows: [{ id: "app-user-1" }] };
          if (sql.includes("select 1 from public.role_grants"))
            return { rows: [{ x: 1 }] };
          if (sql.includes("select 1 from public.staff_profiles"))
            return { rows: [{ x: 1 }] };
          if (
            sql.includes(
              "select assessment_id, template_key from course_assessment_bindings",
            )
          )
            return {
              rows: COMPONENTS.map((c, i) => ({
                assessment_id: `assessment-${i}`,
                template_key: c.toLowerCase(),
              })),
            };
          if (sql.includes("select id from course_practicals"))
            return { rows: [{ id: "practical-1" }] };
          throw new Error(`Unexpected SQL in mock: ${sql}`);
        },
      };
    }
    vi.doMock("pg", () => ({ default: { Client: FakeClient } }));
    vi.resetModules();
  }

  function makeMockAdmin(overrides: Record<string, () => unknown> = {}) {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const responses: Record<string, () => unknown> = {
      get_ducelio_acceptance_environment_id: () => ({
        data: VALID_ENV_ID,
        error: null,
      }),
      import_course_package: () => ({ data: "import-1", error: null }),
      mark_course_package_validated: () => ({ data: null, error: null }),
      apply_course_package: () => ({ data: "version-1", error: null }),
      set_agent_config: () => ({ data: "config-id", error: null }),
      run_course_package_test: () => ({
        data: [{ outcome: "PASS", failure_code: null, failed_roles: [] }],
        error: null,
      }),
      publish_course_package: () => ({ data: "import-1", error: null }),
      admin_create_cohort: () => ({ data: "cohort-1", error: null }),
      activate_course_package: () => ({ data: "activation-1", error: null }),
      create_enrolment: () => ({ data: "enrolment-1", error: null }),
      bind_commercial_v1_assessment_component: () => ({
        data: "binding-id",
        error: null,
      }),
      publish_commercial_v1_grading_policy: () => ({
        data: "activation-1",
        error: null,
      }),
      set_commercial_v1_lab_policy: () => ({
        data: "lab-policy-id",
        error: null,
      }),
      publish_commercial_v1_result_policy: () => ({
        data: "result-policy-id",
        error: null,
      }),
      ...overrides,
    };
    const admin = {
      auth: {
        getUser: async () => ({
          data: { user: { id: "admin-auth-id" } },
          error: null,
        }),
      },
      rpc: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        const handler = responses[name];
        if (!handler) throw new Error(`Unexpected RPC in mock: ${name}`);
        return handler();
      },
    };
    return { admin, calls };
  }

  afterEach(() => {
    vi.doUnmock("pg");
    vi.resetModules();
  });

  it("invokes set_agent_config exactly five times, once per expected role, with values copied from buildAcceptancePackage() rather than hard-coded, strictly after apply_course_package and before run_course_package_test", async () => {
    mockPgForCourseSeeding();
    const { admin, calls } = makeMockAdmin();
    const { seedAcceptanceCourse, buildAcceptancePackage } =
      await import("../scripts/acceptance/fixtures.mjs");
    const runId = "test-run-v6";
    const expectedPkg = buildAcceptancePackage(runId);

    await seedAcceptanceCourse(admin, runId, "learner-auth-id");

    const setAgentConfigCalls = calls.filter(
      (c) => c.name === "set_agent_config",
    );
    // 1 & 2: exactly five calls, exactly the five expected roles, each once.
    expect(setAgentConfigCalls.length).toBe(5);
    const calledRoles = setAgentConfigCalls.map((c) => c.args.p_role);
    expect(new Set(calledRoles)).toEqual(new Set(AGENT_ROLES));
    expect(calledRoles.length).toBe(new Set(calledRoles).size); // each once

    // 3: values copied from buildAcceptancePackage()'s own proposal, never
    // an independently drifting hard-coded configuration.
    for (const role of AGENT_ROLES) {
      const call = setAgentConfigCalls.find((c) => c.args.p_role === role)!;
      const expected = (
        expectedPkg.agentConfiguration as Record<
          string,
          {
            enabled: boolean;
            modelProfileRef: string | null;
            instructionalNotes: string | null;
            capabilities: string[];
            escalationPolicy: string;
          }
        >
      )[role];
      expect(call.args.p_enabled).toBe(expected.enabled);
      expect(call.args.p_model_profile_ref).toBe(expected.modelProfileRef);
      expect(call.args.p_instructional_notes).toBe(expected.instructionalNotes);
      expect(call.args.p_capabilities).toEqual(expected.capabilities);
      expect(call.args.p_escalation_policy).toBe(expected.escalationPolicy);
      expect(call.args.p_programme_version_id).toBe("version-1");
    }

    // 4: all five happen strictly after apply_course_package and before
    // run_course_package_test.
    const applyIndex = calls.findIndex(
      (c) => c.name === "apply_course_package",
    );
    const testIndex = calls.findIndex(
      (c) => c.name === "run_course_package_test",
    );
    const setAgentConfigIndices = calls
      .map((c, i) => (c.name === "set_agent_config" ? i : -1))
      .filter((i) => i !== -1);
    expect(applyIndex).toBeGreaterThan(-1);
    expect(testIndex).toBeGreaterThan(-1);
    expect(setAgentConfigIndices.length).toBe(5);
    for (const i of setAgentConfigIndices) {
      expect(i).toBeGreaterThan(applyIndex);
      expect(i).toBeLessThan(testIndex);
    }

    // 5: run_course_package_test happens before publish_course_package.
    const publishIndex = calls.findIndex(
      (c) => c.name === "publish_course_package",
    );
    expect(publishIndex).toBeGreaterThan(testIndex);

    // Fingerprint-order constraint: academic_agent_configs must never be
    // touched again between the passing test and publish.
    const setAgentConfigAfterTest = calls
      .slice(testIndex + 1, publishIndex)
      .filter((c) => c.name === "set_agent_config");
    expect(setAgentConfigAfterTest.length).toBe(0);
  });

  it("a FAIL response with failure_code/failed_roles produces a bounded diagnostic including those safe fields, never the fingerprint or raw package content", async () => {
    mockPgForCourseSeeding();
    const { admin } = makeMockAdmin({
      run_course_package_test: () => ({
        data: [
          {
            outcome: "FAIL",
            failure_code: "CONFIGURATION_INCOMPLETE",
            failed_roles: ["PROFESSOR", "TUTOR"],
            fingerprint: "SECRET_FINGERPRINT_VALUE",
          },
        ],
        error: null,
      }),
    });
    const { seedAcceptanceCourse } =
      await import("../scripts/acceptance/fixtures.mjs");
    await expect(
      seedAcceptanceCourse(admin, "test-run-v6-fail", "learner-auth-id"),
    ).rejects.toThrow(
      /outcome=FAIL.*failure_code=CONFIGURATION_INCOMPLETE.*failed_roles=PROFESSOR,TUTOR/,
    );
    await expect(
      seedAcceptanceCourse(admin, "test-run-v6-fail-2", "learner-auth-id"),
    ).rejects.not.toThrow(/SECRET_FINGERPRINT_VALUE/);
  });

  it("never inserts directly into academic_agent_configs -- only through the governed set_agent_config RPC", async () => {
    const text = await readFile(
      new URL("../scripts/acceptance/fixtures.mjs", import.meta.url),
      "utf8",
    );
    expect(text).not.toContain("insert into academic_agent_configs");
    expect(text).not.toContain('.from("academic_agent_configs")');
    expect(text).toContain('call("set_agent_config"');
  });

  it("existing acceptance write gates remain fail-closed for seedAcceptanceCourse even with the new set_agent_config step", async () => {
    // The Supabase same-environment gate is still checked FIRST, before
    // set_agent_config or any other RPC -- a mismatch must still reach
    // zero product RPC calls, exactly as the pre-existing DANGEROUS
    // MISMATCH test already proves for the rest of the function.
    clearAcceptanceVars();
    process.env.ACCEPTANCE_ENVIRONMENT_ID = VALID_ENV_ID;
    const { seedAcceptanceCourse } =
      await import("../scripts/acceptance/fixtures.mjs");
    const { AcceptanceWriteNotAuthorizedError } =
      await import("../scripts/acceptance/db.mjs");
    const calledRpcNames: string[] = [];
    const fakeAdmin = {
      rpc: async (name: string) => {
        if (name === "get_ducelio_acceptance_environment_id")
          return { data: "00000000-0000-4000-8000-000000000000", error: null }; // mismatch
        calledRpcNames.push(name);
        return { data: null, error: null };
      },
    };
    await expect(
      seedAcceptanceCourse(fakeAdmin, "test-run-gate", "learner-auth-id"),
    ).rejects.toThrow(AcceptanceWriteNotAuthorizedError);
    expect(calledRpcNames).toEqual([]);
    expect(calledRpcNames).not.toContain("set_agent_config");
  });

  it("no migration file was changed to accommodate this fix -- set_agent_config's governed signature/validation is used exactly as already deployed", async () => {
    const migrationText = await readFile(
      new URL(
        "../supabase/migrations/202609170036_commercial_v1_examiner_config_authority.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(migrationText).toContain(
      "create or replace function public.set_agent_config(",
    );
    expect(migrationText).toContain("p_programme_version_id uuid");
    expect(migrationText).toContain("p_role text");
    expect(migrationText).toContain("p_enabled boolean");
    expect(migrationText).toContain("p_model_profile_ref text");
    expect(migrationText).toContain("p_instructional_notes text");
    expect(migrationText).toContain("p_capabilities text[]");
    expect(migrationText).toContain("p_escalation_policy text");
    expect(migrationText).toContain("p_reason text");
  });
});

describe("acceptance harness: the cohort is created through the governed admin_create_cohort RPC, never privileged SQL (migration 202610010044)", () => {
  afterEach(() => {
    vi.doUnmock("pg");
    vi.resetModules();
  });

  it("seedAcceptanceCourse issues no direct cohort write of any kind", async () => {
    const raw = await readFile(
      new URL("../scripts/acceptance/fixtures.mjs", import.meta.url),
      "utf8",
    );
    // Comments are stripped: the header documents the removed shapes.
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toContain('.from("cohorts")');
    expect(code.toLowerCase()).not.toMatch(
      /insert\s+into\s+(public\.)?cohorts/,
    );
  });

  it("behaviourally: creates exactly one cohort through admin_create_cohort after publication and activates that cohort", async () => {
    clearAcceptanceVars();
    process.env.ACCEPTANCE_DATABASE_URL =
      "postgresql://acceptance:acceptance@localhost:5432/acceptance";
    process.env.ACCEPTANCE_WRITE_ENABLED = "true";
    process.env.ACCEPTANCE_ENVIRONMENT_ID = VALID_ENV_ID;
    const sql: string[] = [];
    function FakeClient() {
      return {
        connect: async () => {},
        end: async () => {},
        query: async (text: string) => {
          sql.push(text);
          if (text.includes("acceptance_marker"))
            return { rows: [{ marker: "x" }] };
          if (text.includes("select id from public.app_users"))
            return { rows: [{ id: "app-user-1" }] };
          if (text.includes("select 1 from public.role_grants"))
            return { rows: [{ x: 1 }] };
          if (text.includes("select 1 from public.staff_profiles"))
            return { rows: [{ x: 1 }] };
          if (text.includes("from course_assessment_bindings"))
            return {
              rows: [
                "QUIZ_1",
                "QUIZ_2",
                "MIDTERM",
                "QUIZ_3",
                "QUIZ_4",
                "FINAL",
              ].map((c, i) => ({
                assessment_id: `assessment-${i}`,
                template_key: c.toLowerCase(),
              })),
            };
          if (text.includes("from course_practicals"))
            return { rows: [{ id: "practical-1" }] };
          return { rows: [] };
        },
      };
    }
    vi.doMock("pg", () => ({ default: { Client: FakeClient } }));
    vi.resetModules();
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const admin = {
      auth: {
        getUser: async () => ({
          data: { user: { id: "admin-auth-id" } },
          error: null,
        }),
      },
      rpc: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        const data: Record<string, unknown> = {
          get_ducelio_acceptance_environment_id: VALID_ENV_ID,
          import_course_package: "import-1",
          apply_course_package: "version-1",
          run_course_package_test: [
            { outcome: "PASS", failure_code: null, failed_roles: [] },
          ],
          admin_create_cohort: "governed-cohort-1",
          activate_course_package: "activation-1",
          create_enrolment: "enrolment-1",
        };
        return { data: data[name] ?? null, error: null };
      },
    };
    const { seedAcceptanceCourse } =
      await import("../scripts/acceptance/fixtures.mjs");
    await seedAcceptanceCourse(admin, "governed-run", "learner-auth-id");
    const names = calls.map((c) => c.name);
    const create = calls.filter((c) => c.name === "admin_create_cohort");
    expect(create).toHaveLength(1);
    expect(create[0].args).toMatchObject({
      p_programme_version_id: "version-1",
      p_title: "Acceptance cohort governed-run",
      p_ends_on: null,
      p_capacity: null,
    });
    expect(create[0].args.p_starts_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(names.indexOf("publish_course_package")).toBeLessThan(
      names.indexOf("admin_create_cohort"),
    );
    expect(names.indexOf("admin_create_cohort")).toBeLessThan(
      names.indexOf("activate_course_package"),
    );
    expect(
      calls.find((c) => c.name === "activate_course_package")!.args.p_cohort_id,
    ).toBe("governed-cohort-1");
    expect(sql.some((text) => /insert\s+into\s+cohorts/i.test(text))).toBe(
      false,
    );
  });
});

describe("acceptance harness: brittle PostgREST instructor/binding/practical discovery removed (independent-review finding 3, this pass)", () => {
  it("seedAcceptanceCourse no longer uses the staff_profiles/role_grants PostgREST embed -- there is no FK between them for PostgREST to resolve", async () => {
    const raw = await readFile(
      new URL("../scripts/acceptance/fixtures.mjs", import.meta.url),
      "utf8",
    );
    // Strip comments first -- the function's own JSDoc deliberately
    // documents the OLD, rejected `.from("staff_profiles")`/
    // `role_grants!inner` shape as prose explaining why it was removed.
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toContain('.from("staff_profiles")');
    expect(code).not.toContain("role_grants!inner");
    expect(code).toMatch(
      /appUserHasRole\(client, resolvedInstructorId, "INSTRUCTOR"\)/,
    );
    expect(code).toContain(
      "appUserHasStaffProfile(client, resolvedInstructorId)",
    );
    expect(code).toContain("p_instructor_id: instructorId");
  });

  it("seedAcceptanceCourse resolves the admin's OWN app_users id via admin.auth.getUser() + resolveAppUserId -- never an arbitrary instructor row", async () => {
    const text = await readFile(
      new URL("../scripts/acceptance/fixtures.mjs", import.meta.url),
      "utf8",
    );
    expect(text).toContain("admin.auth.getUser()");
    expect(text).toMatch(
      /resolveAppUserId\(\s*client,\s*adminUser\.user\.id,?\s*\)/,
    );
  });

  it("fails closed with an explicit error if the admin lacks INSTRUCTOR or a staff_profiles row -- never picks a different arbitrary instructor", async () => {
    const text = await readFile(
      new URL("../scripts/acceptance/fixtures.mjs", import.meta.url),
      "utf8",
    );
    expect(text).toMatch(
      /if\s*\(\s*!\(await appUserHasRole\(client, resolvedInstructorId, "INSTRUCTOR"\)\)\)\s*\n?\s*throw new Error/,
    );
    expect(text).toMatch(
      /if\s*\(\s*!\(await appUserHasStaffProfile\(client, resolvedInstructorId\)\)\)\s*\n?\s*throw new Error/,
    );
  });

  it("seedAcceptanceCourse no longer reads course_assessment_bindings or course_practicals through PostgREST -- migration 2609140027's self-verifying DO block revokes every privilege, including SELECT, for that whole table set", async () => {
    const text = await readFile(
      new URL("../scripts/acceptance/fixtures.mjs", import.meta.url),
      "utf8",
    );
    expect(text).not.toContain('.from("course_assessment_bindings")');
    expect(text).not.toContain('.from("course_practicals")');
    expect(text).toMatch(
      /select assessment_id, template_key from course_assessment_bindings/,
    );
    expect(text).toMatch(
      /select id from course_practicals where import_id=\$1 and kind='PRACTICAL_LAB'/,
    );
  });

  it("appUserHasRole and appUserHasStaffProfile (db.mjs) query the correct tables/columns and never throw on a genuine absence", async () => {
    const { appUserHasRole, appUserHasStaffProfile } =
      await import("../scripts/acceptance/db.mjs");
    let lastSql = "";
    let lastParams: unknown[] = [];
    const fakeClient = {
      query: async (sql: string, params: unknown[]) => {
        lastSql = sql;
        lastParams = params;
        return { rows: [] };
      },
    };
    expect(await appUserHasRole(fakeClient, "u1", "INSTRUCTOR")).toBe(false);
    expect(lastSql.toLowerCase()).toContain("role_grants");
    expect(lastParams).toEqual(["u1", "INSTRUCTOR"]);

    expect(await appUserHasStaffProfile(fakeClient, "u1")).toBe(false);
    expect(lastSql.toLowerCase()).toContain("staff_profiles");
    expect(lastParams).toEqual(["u1"]);
  });

  it("appUserHasRole and appUserHasStaffProfile return true when a matching row exists", async () => {
    const { appUserHasRole, appUserHasStaffProfile } =
      await import("../scripts/acceptance/db.mjs");
    const fakeClient = { query: async () => ({ rows: [{ x: 1 }] }) };
    expect(await appUserHasRole(fakeClient, "u1", "INSTRUCTOR")).toBe(true);
    expect(await appUserHasStaffProfile(fakeClient, "u1")).toBe(true);
  });
});

describe("acceptance harness: result seeding populates real question marks, asserts real validity, and is transactional (independent-review finding 2, v3, BLOCKER)", () => {
  // The genuine validity proof lives in
  // tests/acceptance-results-schema.test.ts (runs the real exported
  // seedAcceptanceResults against a real migrated PGlite database and
  // calls the real assessment_result_is_valid()/lab_result_is_valid()
  // functions). These are source-level checks for the ordering/
  // transaction-safety contract alongside that real-schema proof.
  it("reads real assessment_questions, derives max_marks_total from them, and inserts one commercial_v1_assessment_question_marks row per question BEFORE calling derive_and_insert_objective_outcomes", async () => {
    const text = await readFile(
      new URL("../scripts/acceptance/fixtures.mjs", import.meta.url),
      "utf8",
    );
    const fnStart = text.indexOf("export async function seedAcceptanceResults");
    const fnText = text.slice(fnStart);
    expect(fnText).toContain(
      "select id, max_marks from assessment_questions where assessment_id=$1",
    );
    expect(fnText).not.toContain("max_marks_total,10,"); // the old hard-coded literal
    const marksInsertIndex = fnText.indexOf(
      "insert into commercial_v1_assessment_question_marks(",
    );
    const deriveCallIndex = fnText.indexOf(
      "commercial_v1_private.derive_and_insert_objective_outcomes($1)",
    );
    expect(marksInsertIndex).toBeGreaterThan(-1);
    expect(deriveCallIndex).toBeGreaterThan(-1);
    expect(marksInsertIndex).toBeLessThan(deriveCallIndex);
  });

  it("asserts commercial_v1_private.assessment_result_is_valid/lab_result_is_valid explicitly and throws rather than returning silently on an invalid revision", async () => {
    const text = await readFile(
      new URL("../scripts/acceptance/fixtures.mjs", import.meta.url),
      "utf8",
    );
    const fnStart = text.indexOf("export async function seedAcceptanceResults");
    const fnText = text.slice(fnStart);
    expect(fnText).toContain(
      "commercial_v1_private.assessment_result_is_valid($1) as valid",
    );
    expect(fnText).toContain(
      "commercial_v1_private.lab_result_is_valid($1) as valid",
    );
    expect(fnText).toMatch(
      /if\s*\(\s*!validRows\[0\]\?\.valid\)\s*\n?\s*throw new Error/,
    );
    expect(fnText).toMatch(
      /if\s*\(\s*!labValidRows\[0\]\?\.valid\)\s*\n?\s*throw new Error/,
    );
  });

  it("wraps the entire result-seeding operation in begin/commit, with rollback on any error -- these tables are append-only, so a defect without a transaction could leave permanent, unrepairable incomplete history", async () => {
    const text = await readFile(
      new URL("../scripts/acceptance/fixtures.mjs", import.meta.url),
      "utf8",
    );
    const fnStart = text.indexOf("export async function seedAcceptanceResults");
    const fnEnd = text.indexOf(
      "\n/**",
      fnStart + "export async function seedAcceptanceResults".length,
    );
    const fnText = text.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
    expect(fnText).toMatch(/await client\.query\("begin"\)/);
    expect(fnText).toMatch(/await client\.query\("commit"\)/);
    expect(fnText).toMatch(
      /catch \(error\) \{\s*\n\s*await client\.query\("rollback"\);\s*\n\s*throw error;/,
    );
  });

  it("behaviourally: a failure partway through (e.g. the lab step) rolls back -- no commit is ever issued", async () => {
    clearAcceptanceVars();
    process.env.ACCEPTANCE_DATABASE_URL =
      "postgresql://acceptance:acceptance@localhost:5432/acceptance";
    process.env.ACCEPTANCE_WRITE_ENABLED = "true";
    process.env.ACCEPTANCE_ENVIRONMENT_ID = VALID_ENV_ID;
    const calls: string[] = [];
    function FakeClient() {
      return {
        connect: async () => {},
        end: async () => {},
        query: async (sql: string) => {
          calls.push(sql);
          if (sql.includes("acceptance_marker"))
            return { rows: [{ marker: "x" }] };
          if (sql.toLowerCase().includes("begin")) return { rows: [] };
          if (sql.toLowerCase().includes("commit")) return { rows: [] };
          if (sql.toLowerCase().includes("rollback")) return { rows: [] };
          // Every real query (bindings, questions, inserts, ...) fails --
          // simulates a defect discovered partway through the operation.
          throw new Error("simulated failure partway through result seeding");
        },
      };
    }
    vi.doMock("pg", () => ({ default: { Client: FakeClient } }));
    vi.resetModules();
    const { seedAcceptanceResults } =
      await import("../scripts/acceptance/fixtures.mjs");
    await expect(
      seedAcceptanceResults(
        {
          activationId: "a1",
          enrolmentId: "e1",
          studentId: "s1",
          cohortId: "c1",
          programmeVersionId: "v1",
          practicalId: "p1",
        },
        true,
      ),
    ).rejects.toThrow();
    vi.doUnmock("pg");
    vi.resetModules();
    expect(calls.some((s) => s.toLowerCase().includes("begin"))).toBe(true);
    expect(calls.some((s) => s.toLowerCase().includes("rollback"))).toBe(true);
    expect(calls.some((s) => s.toLowerCase().includes("commit"))).toBe(false);
  });
});

describe("acceptance harness: Supabase/PostgREST same-environment gate (independent-review finding 1)", () => {
  it("fails closed when ACCEPTANCE_ENVIRONMENT_ID is missing", async () => {
    clearAcceptanceVars();
    const {
      assertAcceptanceSupabaseWriteAuthorized,
      AcceptanceWriteNotAuthorizedError,
    } = await import("../scripts/acceptance/supabase.mjs");
    const fakeClient = {
      rpc: async () => ({ data: VALID_ENV_ID, error: null }),
    };
    await expect(
      assertAcceptanceSupabaseWriteAuthorized(fakeClient),
    ).rejects.toThrow(AcceptanceWriteNotAuthorizedError);
  });

  it("fails closed when the hosted marker RPC does not exist (or is denied)", async () => {
    clearAcceptanceVars();
    process.env.ACCEPTANCE_ENVIRONMENT_ID = VALID_ENV_ID;
    const {
      assertAcceptanceSupabaseWriteAuthorized,
      AcceptanceWriteNotAuthorizedError,
    } = await import("../scripts/acceptance/supabase.mjs");
    const fakeClient = {
      rpc: async () => ({
        data: null,
        error: { message: "function does not exist" },
      }),
    };
    await expect(
      assertAcceptanceSupabaseWriteAuthorized(fakeClient),
    ).rejects.toThrow(AcceptanceWriteNotAuthorizedError);
  });

  it("fails closed when the RPC call itself throws", async () => {
    clearAcceptanceVars();
    process.env.ACCEPTANCE_ENVIRONMENT_ID = VALID_ENV_ID;
    const {
      assertAcceptanceSupabaseWriteAuthorized,
      AcceptanceWriteNotAuthorizedError,
    } = await import("../scripts/acceptance/supabase.mjs");
    const fakeClient = {
      rpc: async () => {
        throw new Error("network error");
      },
    };
    await expect(
      assertAcceptanceSupabaseWriteAuthorized(fakeClient),
    ).rejects.toThrow(AcceptanceWriteNotAuthorizedError);
  });

  it("THE DANGEROUS MISMATCH: local ACCEPTANCE_ENVIRONMENT_ID differs from the hosted Supabase marker's own id -- BLOCKED", async () => {
    clearAcceptanceVars();
    process.env.ACCEPTANCE_ENVIRONMENT_ID = VALID_ENV_ID;
    const {
      assertAcceptanceSupabaseWriteAuthorized,
      AcceptanceWriteNotAuthorizedError,
    } = await import("../scripts/acceptance/supabase.mjs");
    const fakeClient = {
      rpc: async () => ({ data: OTHER_ENV_ID, error: null }),
    };
    await expect(
      assertAcceptanceSupabaseWriteAuthorized(fakeClient),
    ).rejects.toThrow(AcceptanceWriteNotAuthorizedError);
  });

  it("succeeds only when the hosted marker id exactly matches ACCEPTANCE_ENVIRONMENT_ID", async () => {
    clearAcceptanceVars();
    process.env.ACCEPTANCE_ENVIRONMENT_ID = VALID_ENV_ID;
    const { assertAcceptanceSupabaseWriteAuthorized } =
      await import("../scripts/acceptance/supabase.mjs");
    const fakeClient = {
      rpc: async () => ({ data: VALID_ENV_ID, error: null }),
    };
    await expect(
      assertAcceptanceSupabaseWriteAuthorized(fakeClient),
    ).resolves.toBeUndefined();
  });

  it("comparison is case-insensitive (Postgres uuid canonical form vs an uppercase env value)", async () => {
    clearAcceptanceVars();
    process.env.ACCEPTANCE_ENVIRONMENT_ID = VALID_ENV_ID.toUpperCase();
    const { assertAcceptanceSupabaseWriteAuthorized } =
      await import("../scripts/acceptance/supabase.mjs");
    const fakeClient = {
      rpc: async () => ({ data: VALID_ENV_ID, error: null }),
    };
    await expect(
      assertAcceptanceSupabaseWriteAuthorized(fakeClient),
    ).resolves.toBeUndefined();
  });

  it("seedAcceptanceCourse: THE DANGEROUS MISMATCH end to end -- Supabase marker disagrees, zero product write RPCs are ever called", async () => {
    clearAcceptanceVars();
    process.env.ACCEPTANCE_ENVIRONMENT_ID = VALID_ENV_ID;
    // seedAcceptanceCourse checks the Supabase gate FIRST (see fixtures.mjs's
    // own comment on why), so this proves the mismatch is caught -- and no
    // product RPC is ever reached -- without needing a real database
    // connection for the direct-DB gate at all.
    const { seedAcceptanceCourse } =
      await import("../scripts/acceptance/fixtures.mjs");
    const { AcceptanceWriteNotAuthorizedError } =
      await import("../scripts/acceptance/db.mjs");
    const calledRpcNames: string[] = [];
    const fakeAdmin = {
      rpc: async (name: string) => {
        if (name === "get_ducelio_acceptance_environment_id")
          return { data: OTHER_ENV_ID, error: null }; // the mismatch
        calledRpcNames.push(name);
        return { data: null, error: null };
      },
      from: () => {
        throw new Error(
          "seedAcceptanceCourse must never reach a table write after a gate mismatch",
        );
      },
    };
    await expect(
      seedAcceptanceCourse(
        fakeAdmin,
        "test-run",
        "10000000-0000-4000-8000-000000000009",
      ),
    ).rejects.toThrow(AcceptanceWriteNotAuthorizedError);
    expect(calledRpcNames).toEqual([]);
  });

  it("never includes the actual environment id, database url or a password in any thrown error message", async () => {
    clearAcceptanceVars();
    const secretEnvId = "c0000000-0000-4000-8000-0000deadbeef";
    process.env.ACCEPTANCE_ENVIRONMENT_ID = secretEnvId;
    process.env.ACCEPTANCE_DATABASE_URL =
      "postgres://acceptance:super-secret-password@db.internal.example.com:5432/acceptance_db";
    const { assertAcceptanceSupabaseWriteAuthorized } =
      await import("../scripts/acceptance/supabase.mjs");
    const { assertAcceptanceDatabaseWriteAuthorized } =
      await import("../scripts/acceptance/db.mjs");
    const mismatchedSupabase = {
      rpc: async () => ({ data: OTHER_ENV_ID, error: null }),
    };
    let supabaseMessage = "";
    try {
      await assertAcceptanceSupabaseWriteAuthorized(mismatchedSupabase);
    } catch (error) {
      supabaseMessage = error instanceof Error ? error.message : String(error);
    }
    expect(supabaseMessage).not.toContain(secretEnvId);
    expect(supabaseMessage).not.toContain("super-secret-password");
    expect(supabaseMessage).not.toContain("db.internal.example.com");

    process.env.ACCEPTANCE_WRITE_ENABLED = "true";
    const noRowClient = { query: async () => ({ rows: [] }) };
    let dbMessage = "";
    try {
      await assertAcceptanceDatabaseWriteAuthorized(noRowClient);
    } catch (error) {
      dbMessage = error instanceof Error ? error.message : String(error);
    }
    expect(dbMessage).not.toContain(secretEnvId);
    expect(dbMessage).not.toContain("super-secret-password");
    expect(dbMessage).not.toContain("db.internal.example.com");
  });
});

describe("acceptance harness: enrolAcceptanceLearner independently asserts the Supabase same-environment gate (independent review V2, blocker 4)", () => {
  afterEach(() => {
    vi.doUnmock("pg");
    vi.resetModules();
  });

  it("a Supabase environment mismatch blocks BEFORE create_enrolment is ever called -- the direct-DB gate alone is not enough", async () => {
    clearAcceptanceVars();
    process.env.ACCEPTANCE_ENVIRONMENT_ID = VALID_ENV_ID;
    // Deliberately does NOT set ACCEPTANCE_WRITE_ENABLED or
    // ACCEPTANCE_DATABASE_URL -- if enrolAcceptanceLearner reached the
    // direct-DB gate at all here, it would throw for an UNRELATED reason
    // (no database configured), which would make this test pass for the
    // wrong reason. The Supabase gate must reject first, on its own.
    const { enrolAcceptanceLearner } =
      await import("../scripts/acceptance/fixtures.mjs");
    const { AcceptanceWriteNotAuthorizedError } =
      await import("../scripts/acceptance/db.mjs");
    const calledRpcNames: string[] = [];
    const fakeAdmin = {
      rpc: async (name: string) => {
        if (name === "get_ducelio_acceptance_environment_id")
          return { data: OTHER_ENV_ID, error: null }; // the mismatch
        calledRpcNames.push(name);
        return { data: null, error: null };
      },
    };
    await expect(
      enrolAcceptanceLearner(
        fakeAdmin,
        "cohort-1",
        "10000000-0000-4000-8000-000000000009",
      ),
    ).rejects.toThrow(AcceptanceWriteNotAuthorizedError);
    expect(calledRpcNames).toEqual([]);
  });

  it("a direct-database gate denial ALSO blocks before create_enrolment is called, even when the Supabase gate agrees", async () => {
    clearAcceptanceVars();
    process.env.ACCEPTANCE_ENVIRONMENT_ID = VALID_ENV_ID;
    process.env.ACCEPTANCE_DATABASE_URL =
      "postgres://acceptance:secret@db.example.com:5432/acceptance_db";
    // Deliberately does NOT set ACCEPTANCE_WRITE_ENABLED=true -- the
    // Supabase gate (checked first) agrees, but the direct-database gate
    // must still independently reject before resolveAppUserId ever runs
    // a query, and before create_enrolment is ever called.
    class FakeClient {
      async connect() {}
      async end() {}
      async query() {
        throw new Error(
          "the direct-database gate must reject before any query runs",
        );
      }
    }
    vi.doMock("pg", () => ({ default: { Client: FakeClient } }));
    vi.resetModules();
    const { enrolAcceptanceLearner } =
      await import("../scripts/acceptance/fixtures.mjs");
    const { AcceptanceWriteNotAuthorizedError } =
      await import("../scripts/acceptance/db.mjs");
    const calledRpcNames: string[] = [];
    const fakeAdmin = {
      rpc: async (name: string) => {
        if (name === "get_ducelio_acceptance_environment_id")
          return { data: VALID_ENV_ID, error: null }; // the Supabase gate agrees
        calledRpcNames.push(name);
        return { data: null, error: null };
      },
    };
    await expect(
      enrolAcceptanceLearner(
        fakeAdmin,
        "cohort-1",
        "10000000-0000-4000-8000-000000000009",
      ),
    ).rejects.toThrow(AcceptanceWriteNotAuthorizedError);
    expect(calledRpcNames).toEqual([]);
  });

  it("neither gate can be omitted -- fixtures.mjs's source calls assertAcceptanceSupabaseWriteAuthorized as enrolAcceptanceLearner's own first action, ahead of withAcceptanceWriteConnection", async () => {
    const text = await readFile(
      new URL("../scripts/acceptance/fixtures.mjs", import.meta.url),
      "utf8",
    );
    const fnStart = text.indexOf(
      "export async function enrolAcceptanceLearner(",
    );
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = text.indexOf("\n/**", fnStart + 1);
    const fnText = text.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
    const supabaseGateIndex = fnText.indexOf(
      "assertAcceptanceSupabaseWriteAuthorized(admin)",
    );
    const dbGateIndex = fnText.indexOf("withAcceptanceWriteConnection(");
    const createEnrolmentIndex = fnText.indexOf('"create_enrolment"');
    expect(supabaseGateIndex).toBeGreaterThan(-1);
    expect(dbGateIndex).toBeGreaterThan(-1);
    expect(createEnrolmentIndex).toBeGreaterThan(-1);
    expect(supabaseGateIndex).toBeLessThan(dbGateIndex);
    expect(dbGateIndex).toBeLessThan(createEnrolmentIndex);
  });

  it("the successful path calls create_enrolment only after both gates pass", async () => {
    clearAcceptanceVars();
    process.env.ACCEPTANCE_ENVIRONMENT_ID = VALID_ENV_ID;
    process.env.ACCEPTANCE_DATABASE_URL =
      "postgres://acceptance:secret@db.example.com:5432/acceptance_db";
    process.env.ACCEPTANCE_WRITE_ENABLED = "true";
    const { ACCEPTANCE_MARKER_TABLE } =
      await import("../scripts/acceptance/db.mjs");
    class FakeClient {
      async connect() {}
      async end() {}
      async query(sql: string) {
        if (sql.includes(ACCEPTANCE_MARKER_TABLE)) return { rows: [{ x: 1 }] }; // direct-DB gate agrees
        if (sql.includes("app_users"))
          return { rows: [{ id: "resolved-student-id" }] };
        return { rows: [] };
      }
    }
    vi.doMock("pg", () => ({ default: { Client: FakeClient } }));
    vi.resetModules();
    const { enrolAcceptanceLearner } =
      await import("../scripts/acceptance/fixtures.mjs");
    const rpcCallOrder: string[] = [];
    const fakeAdmin = {
      rpc: async (name: string) => {
        rpcCallOrder.push(name);
        if (name === "get_ducelio_acceptance_environment_id")
          return { data: VALID_ENV_ID, error: null };
        if (name === "create_enrolment")
          return { data: "new-enrolment-id", error: null };
        return { data: null, error: null };
      },
    };
    const result = await enrolAcceptanceLearner(
      fakeAdmin,
      "cohort-1",
      "10000000-0000-4000-8000-000000000009",
    );
    expect(result.enrolmentId).toBe("new-enrolment-id");
    expect(rpcCallOrder).toEqual([
      "get_ducelio_acceptance_environment_id",
      "create_enrolment",
    ]);
  });
});

describe("acceptance harness: TLS is never unconditionally insecure (independent-review finding 4)", () => {
  it("connect() does not pass ssl:{rejectUnauthorized:false} by default", async () => {
    clearAcceptanceVars();
    const text = await readFile(
      new URL("../scripts/acceptance/db.mjs", import.meta.url),
      "utf8",
    );
    // The insecure shape must appear only inside a conditional spread keyed
    // to the explicit opt-in, never as an unconditional client option.
    expect(text).not.toMatch(
      /ssl:\s*\{\s*rejectUnauthorized:\s*false\s*\}\s*,?\s*\n\s*\}\);/,
    );
    expect(text).toContain("ACCEPTANCE_DATABASE_INSECURE_TLS");
    expect(text).toContain(
      "insecureTls ? { ssl: { rejectUnauthorized: false } } : {}",
    );
  });

  it("ACCEPTANCE_DATABASE_INSECURE_TLS is a known acceptance-tooling-only preflight variable", async () => {
    clearAcceptanceVars();
    const { statusOf } = await import("../scripts/acceptance/env.mjs");
    expect(statusOf("ACCEPTANCE_DATABASE_INSECURE_TLS")).toBe("missing");
    process.env.ACCEPTANCE_DATABASE_INSECURE_TLS = "true";
    expect(statusOf("ACCEPTANCE_DATABASE_INSECURE_TLS")).toBe("configured");
    process.env.ACCEPTANCE_DATABASE_INSECURE_TLS = "yes";
    expect(statusOf("ACCEPTANCE_DATABASE_INSECURE_TLS")).toBe("malformed");
  });
});

describe("acceptance harness: checkJwtPostgrest prerequisite gating (docs/38 section 3 completion)", () => {
  function setBaselineIdentityEnv() {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "publishable-key";
    process.env.ACCEPTANCE_ADMIN_EMAIL = "admin@example.com";
    process.env.ACCEPTANCE_ADMIN_PASSWORD = "password";
    process.env.ACCEPTANCE_LEARNER_EMAIL = "learner@example.com";
    process.env.ACCEPTANCE_LEARNER_PASSWORD = "password";
    process.env.ACCEPTANCE_FOREIGN_LEARNER_EMAIL = "foreign@example.com";
    process.env.ACCEPTANCE_FOREIGN_LEARNER_PASSWORD = "password";
  }

  it("BLOCKED when ACCEPTANCE_DATABASE_URL is not configured, even with every hosted identity present", async () => {
    clearAcceptanceVars();
    setBaselineIdentityEnv();
    process.env.ACCEPTANCE_UNRELATED_STAFF_EMAIL = "staff@example.com";
    process.env.ACCEPTANCE_UNRELATED_STAFF_PASSWORD = "password";
    process.env.ACCEPTANCE_EXPIRED_LEARNER_JWT = makeFakeJwt(-3600);
    const { checkJwtPostgrest } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkJwtPostgrest();
    expect(result.status).toBe("BLOCKED");
    expect(result.reason.toLowerCase()).toContain("acceptance_database_url");
  });

  it("BLOCKED when the unrelated-staff credential pair is incomplete (only the email is configured)", async () => {
    clearAcceptanceVars();
    setBaselineIdentityEnv();
    process.env.ACCEPTANCE_DATABASE_URL =
      "postgres://acceptance:secret@db.example.com:5432/acceptance_db";
    process.env.ACCEPTANCE_UNRELATED_STAFF_EMAIL = "staff@example.com";
    process.env.ACCEPTANCE_EXPIRED_LEARNER_JWT = makeFakeJwt(-3600);
    const { checkJwtPostgrest } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkJwtPostgrest();
    expect(result.status).toBe("BLOCKED");
    expect(result.reason.toLowerCase()).toContain("unrelated-staff");
  });

  it("BLOCKED when the unrelated-staff credential pair is incomplete (only the password is configured)", async () => {
    clearAcceptanceVars();
    setBaselineIdentityEnv();
    process.env.ACCEPTANCE_DATABASE_URL =
      "postgres://acceptance:secret@db.example.com:5432/acceptance_db";
    process.env.ACCEPTANCE_UNRELATED_STAFF_PASSWORD = "password";
    process.env.ACCEPTANCE_EXPIRED_LEARNER_JWT = makeFakeJwt(-3600);
    const { checkJwtPostgrest } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkJwtPostgrest();
    expect(result.status).toBe("BLOCKED");
  });

  it("unrelatedStaffIdentityConfigured requires the complete pair", async () => {
    clearAcceptanceVars();
    const { unrelatedStaffIdentityConfigured } =
      await import("../scripts/acceptance/supabase.mjs");
    expect(unrelatedStaffIdentityConfigured()).toBe(false);
    process.env.ACCEPTANCE_UNRELATED_STAFF_EMAIL = "staff@example.com";
    expect(unrelatedStaffIdentityConfigured()).toBe(false);
    process.env.ACCEPTANCE_UNRELATED_STAFF_PASSWORD = "password";
    expect(unrelatedStaffIdentityConfigured()).toBe(true);
  });

  it("BLOCKED when ACCEPTANCE_EXPIRED_LEARNER_JWT is not configured -- a malformed token alone is not evidence that expiry enforcement itself works", async () => {
    clearAcceptanceVars();
    setBaselineIdentityEnv();
    process.env.ACCEPTANCE_DATABASE_URL =
      "postgres://acceptance:secret@db.example.com:5432/acceptance_db";
    process.env.ACCEPTANCE_UNRELATED_STAFF_EMAIL = "staff@example.com";
    process.env.ACCEPTANCE_UNRELATED_STAFF_PASSWORD = "password";
    const { checkJwtPostgrest } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkJwtPostgrest();
    expect(result.status).toBe("BLOCKED");
    expect(result.reason).toContain("ACCEPTANCE_EXPIRED_LEARNER_JWT");
    expect(result.reason.toLowerCase()).toContain("is not configured");
  });

  it("BLOCKED when ACCEPTANCE_EXPIRED_LEARNER_JWT is not structurally JWT-shaped -- reported as an unconfigured (malformed) prerequisite, never treated as a valid expired token", async () => {
    clearAcceptanceVars();
    setBaselineIdentityEnv();
    process.env.ACCEPTANCE_DATABASE_URL =
      "postgres://acceptance:secret@db.example.com:5432/acceptance_db";
    process.env.ACCEPTANCE_UNRELATED_STAFF_EMAIL = "staff@example.com";
    process.env.ACCEPTANCE_UNRELATED_STAFF_PASSWORD = "password";
    process.env.ACCEPTANCE_EXPIRED_LEARNER_JWT = "not-a-jwt-at-all";
    const { checkJwtPostgrest } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkJwtPostgrest();
    expect(result.status).toBe("BLOCKED");
    expect(result.reason).toContain("ACCEPTANCE_EXPIRED_LEARNER_JWT");
  });

  it("BLOCKED when ACCEPTANCE_EXPIRED_LEARNER_JWT's exp claim is NOT actually in the past -- refuses to claim expired-token evidence dishonestly", async () => {
    clearAcceptanceVars();
    setBaselineIdentityEnv();
    process.env.ACCEPTANCE_DATABASE_URL =
      "postgres://acceptance:secret@db.example.com:5432/acceptance_db";
    process.env.ACCEPTANCE_UNRELATED_STAFF_EMAIL = "staff@example.com";
    process.env.ACCEPTANCE_UNRELATED_STAFF_PASSWORD = "password";
    process.env.ACCEPTANCE_EXPIRED_LEARNER_JWT = makeFakeJwt(3600);
    const { checkJwtPostgrest } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkJwtPostgrest();
    expect(result.status).toBe("BLOCKED");
    expect(result.reason.toLowerCase()).toContain("exp claim");
  });
});

describe("acceptance harness: checkJwtPostgrest full docs/38 section 3 evidence (JWT_POSTGREST completion)", () => {
  afterEach(() => {
    vi.doUnmock("../scripts/acceptance/supabase.mjs");
    vi.doUnmock("../scripts/acceptance/fixtures.mjs");
    vi.resetModules();
  });

  type RpcResult = {
    data: unknown;
    error: { message: string; code?: string } | null;
    status?: number;
  };
  type RpcHandlers = Record<
    string,
    (args?: unknown) => RpcResult | Promise<RpcResult>
  >;
  type FromSelectResult = {
    data: unknown;
    error: { message: string; code?: string } | null;
    status?: number;
  };
  function ok(data: unknown): RpcResult {
    return { data, error: null };
  }
  function denied(message = "denied", status?: number): RpcResult {
    return { data: null, error: { message }, status };
  }
  function postgrestError(
    code: string,
    message: string,
    status?: number,
  ): RpcResult {
    return { data: null, error: { code, message }, status };
  }
  function makeClient(
    handlers: RpcHandlers,
    opts: {
      authUserId?: string;
      authUserError?: string;
      fromSelectResult?: FromSelectResult;
    } = {},
  ) {
    return {
      rpc: async (name: string, args?: unknown) => {
        const handler = handlers[name];
        if (!handler) throw new Error(`Unexpected RPC in test mock: ${name}`);
        return handler(args);
      },
      auth: {
        getUser: async () =>
          opts.authUserError
            ? { data: { user: null }, error: { message: opts.authUserError } }
            : {
                data: { user: { id: opts.authUserId ?? "auth-id" } },
                error: null,
              },
      },
      from: () => ({
        select: async () =>
          opts.fromSelectResult ?? {
            data: null,
            error: {
              message: "permission denied for table assessment_answer_keys",
              code: "42501",
            },
            status: 403,
          },
      }),
    };
  }

  function setFullyConfiguredEnv() {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "publishable-key";
    process.env.ACCEPTANCE_DATABASE_URL =
      "postgres://acceptance:secret@db.example.com:5432/acceptance_db";
    process.env.ACCEPTANCE_ADMIN_EMAIL = "admin@example.com";
    process.env.ACCEPTANCE_ADMIN_PASSWORD = "password";
    process.env.ACCEPTANCE_LEARNER_EMAIL = "learner@example.com";
    process.env.ACCEPTANCE_LEARNER_PASSWORD = "password";
    process.env.ACCEPTANCE_FOREIGN_LEARNER_EMAIL = "foreign@example.com";
    process.env.ACCEPTANCE_FOREIGN_LEARNER_PASSWORD = "password";
    process.env.ACCEPTANCE_UNRELATED_STAFF_EMAIL = "staff@example.com";
    process.env.ACCEPTANCE_UNRELATED_STAFF_PASSWORD = "password";
    process.env.ACCEPTANCE_EXPIRED_LEARNER_JWT = makeFakeJwt(-3600);
  }

  // A fully-passing baseline covering every docs/38 section 3 subcheck;
  // each test below overrides exactly the ONE handler/result it means to
  // break, proving that single failure is what the surface actually
  // reports -- never a coincidental, unrelated failure. `hasActiveAttempt`
  // models the REAL get_active_assessment_questions contract: it denies
  // with the documented P0001 error until start_assessment_attempt has
  // genuinely run, then releases the learner-safe projection, then denies
  // again once submit_assessment_attempt tears the attempt back down --
  // exactly the state machine surfaces.mjs's own start->release->submit
  // sequence walks through.
  type IdentityKey = "admin" | "learner" | "foreign" | "unrelatedStaff";
  function mockDeps(
    overrides: Partial<{
      learnerHandlers: RpcHandlers;
      adminHandlers: RpcHandlers;
      foreignHandlers: RpcHandlers;
      staffHandlers: RpcHandlers;
      anonHandlers: RpcHandlers;
      learnerFromSelectResult: FromSelectResult;
      // Blocker 4 (V3): lets a test make two identities resolve to the
      // SAME hosted Auth user id, or make one identity's auth.getUser()
      // itself error/return no user -- defaults are four distinct ids.
      authUserIds: Partial<Record<IdentityKey, string>>;
      authUserErrors: Partial<Record<IdentityKey, string>>;
      invalidJwtResult: Record<string, unknown>;
      expiredJwtResult: Record<string, unknown>;
      staffVerification: { verified: boolean; reason?: string };
      seedAcceptanceCourseImpl: (...args: unknown[]) => Promise<unknown>;
      enrolAcceptanceLearnerImpl: (...args: unknown[]) => Promise<unknown>;
    }> = {},
  ) {
    let hasActiveAttempt = false;
    const learnerHandlers: RpcHandlers = {
      list_practical_enrolments: () => ok([{ id: "primary-enrolment" }]),
      list_commercial_v1_activations: () =>
        postgrestError("42501", "FORBIDDEN", 403),
      get_commercial_v1_course_progress: () =>
        ok({ code: "NOT_FOUND_OR_FORBIDDEN" }),
      start_assessment_attempt: () => {
        hasActiveAttempt = true;
        return ok("attempt-1");
      },
      get_active_assessment_questions: () =>
        hasActiveAttempt
          ? ok([{ id: "q1", position: 1, prompt: "...", max_marks: 10 }])
          : postgrestError(
              "P0001",
              "Protected assessment content requires an active attempt",
            ),
      submit_assessment_attempt: () => {
        hasActiveAttempt = false;
        return ok("attempt-1");
      },
      govern_commercial_v1_examiner_recovery: () => ok({ code: "FORBIDDEN" }),
      ...overrides.learnerHandlers,
    };
    const adminHandlers: RpcHandlers = {
      list_commercial_v1_activations: () => ok([{ id: "a1" }]),
      govern_commercial_v1_examiner_recovery: () =>
        ok({ code: "UNTRUSTED_EXECUTION" }),
      ...overrides.adminHandlers,
    };
    const foreignHandlers: RpcHandlers = {
      list_practical_enrolments: () => ok([{ id: "foreign-enrolment" }]),
      get_commercial_v1_course_progress: () =>
        ok({ code: "NOT_FOUND_OR_FORBIDDEN" }),
      ...overrides.foreignHandlers,
    };
    const staffHandlers: RpcHandlers = {
      govern_commercial_v1_examiner_recovery: () => ok({ code: "FORBIDDEN" }),
      ...overrides.staffHandlers,
    };
    const anonHandlers: RpcHandlers = {
      list_practical_enrolments: () =>
        postgrestError(
          "42501",
          "permission denied for function list_practical_enrolments",
          401,
        ),
      ...overrides.anonHandlers,
    };

    let protectedRpcCall = 0;
    // V2 correction (blockers 1 & 2): a genuine hosted rejection carries a
    // recognised PGRST3XX code AND HTTP 401; the expired-token default
    // additionally carries a message that specifically identifies expiry
    // (never merely "invalid").
    const invalidJwtResult = overrides.invalidJwtResult ?? {
      networkError: false,
      status: 401,
      ok: false,
      code: "PGRST301",
      message: "JWT invalid",
    };
    const expiredJwtResult = overrides.expiredJwtResult ?? {
      networkError: false,
      status: 401,
      ok: false,
      code: "PGRST301",
      message: "JWT expired",
    };

    // Blocker 4 (V3): four DISTINCT hosted Auth user ids by default -- a
    // test overrides one to collide with another to prove the
    // pairwise-distinctness check actually fires.
    const authUserIds: Record<IdentityKey, string> = {
      admin: "admin-auth-id",
      learner: "learner-auth-id",
      foreign: "foreign-auth-id",
      unrelatedStaff: "staff-auth-id",
      ...overrides.authUserIds,
    };
    const authUserErrors = overrides.authUserErrors ?? {};

    vi.doMock("../scripts/acceptance/supabase.mjs", () => ({
      hostedSupabaseConfigured: () => true,
      acceptanceIdentitiesConfigured: () => true,
      foreignLearnerIdentityConfigured: () => true,
      unrelatedStaffIdentityConfigured: () => true,
      anonClient: () => makeClient(anonHandlers, { authUserId: "anon" }),
      acceptanceIdentities: {
        admin: async () =>
          makeClient(adminHandlers, {
            authUserId: authUserIds.admin,
            authUserError: authUserErrors.admin,
          }),
        learner: async () =>
          makeClient(learnerHandlers, {
            authUserId: authUserIds.learner,
            authUserError: authUserErrors.learner,
            fromSelectResult: overrides.learnerFromSelectResult,
          }),
        foreignLearner: async () =>
          makeClient(foreignHandlers, {
            authUserId: authUserIds.foreign,
            authUserError: authUserErrors.foreign,
          }),
        unrelatedStaff: async () =>
          makeClient(staffHandlers, {
            authUserId: authUserIds.unrelatedStaff,
            authUserError: authUserErrors.unrelatedStaff,
          }),
      },
      verifyNonAdminStaffRole: async () =>
        overrides.staffVerification ?? { verified: true },
      // The REAL implementations (captured by the static import at the
      // top of this file) -- only callProtectedRpcWithBearerToken itself
      // is mocked here, so this block genuinely exercises surfaces.mjs's
      // use of the real classifiers against a controlled raw response
      // shape, never a hand-rolled duplicate that could drift from it.
      isJwtAuthRejection: realIsJwtAuthRejection,
      isJwtExpiryRejection: realIsJwtExpiryRejection,
      isAnonInsufficientPrivilegeRejection:
        realIsAnonInsufficientPrivilegeRejection,
      isAuthenticatedInsufficientPrivilegeRejection:
        realIsAuthenticatedInsufficientPrivilegeRejection,
      // The invalid-JWT check always runs before the expired-JWT check
      // (surfaces.mjs's own fixed order) -- a call counter mirrors that
      // without needing to inspect the raw token this harness never logs.
      callProtectedRpcWithBearerToken: async () => {
        protectedRpcCall += 1;
        return protectedRpcCall === 1 ? invalidJwtResult : expiredJwtResult;
      },
    }));
    vi.doMock("../scripts/acceptance/fixtures.mjs", () => ({
      seedAcceptanceCourse:
        overrides.seedAcceptanceCourseImpl ??
        (async () => ({
          enrolmentId: "primary-enrolment",
          cohortId: "cohort-1",
          quiz1AssessmentId: "quiz-1-assessment",
        })),
      enrolAcceptanceLearner:
        overrides.enrolAcceptanceLearnerImpl ??
        (async () => ({
          enrolmentId: "foreign-enrolment",
          studentId: "foreign-student",
        })),
      seedAcceptanceResults: async () => ({}),
      cleanupAcceptanceRun: async () => {},
    }));
    vi.resetModules();
  }

  it("PASS only when every docs/38 section 3 subcheck genuinely succeeds -- and the PASS text is explicit that this is not proof of successful recovery", async () => {
    clearAcceptanceVars();
    setFullyConfiguredEnv();
    mockDeps();
    const { checkJwtPostgrest } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkJwtPostgrest();
    expect(result.status).toBe("PASS");
    expect(result.reason.toLowerCase()).toContain("not proof of successful");
  });

  it("FAIL when the anon caller is NOT denied list_practical_enrolments at all", async () => {
    clearAcceptanceVars();
    setFullyConfiguredEnv();
    mockDeps({ anonHandlers: { list_practical_enrolments: () => ok([]) } });
    const { checkJwtPostgrest } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkJwtPostgrest();
    expect(result.status).toBe("FAIL");
  });

  it.each([
    ["400 bad request, no 42501 code", { status: 400, code: null }],
    ["404 schema-cache miss", { status: 404, code: "PGRST205" }],
    ["429 rate limited", { status: 429, code: null }],
    ["500 internal server error", { status: 500, code: null }],
    ["503 database outage", { status: 503, code: null }],
    ["401 with an unrelated code", { status: 401, code: "PGRST116" }],
    // Even a 403 (the AUTHENTICATED shape) must not satisfy the ANON check.
    [
      "403 (the authenticated shape, not anon's)",
      { status: 403, code: "42501" },
    ],
  ])(
    "FAIL (blocker 1), never a PASS-worthy anon denial, for %s",
    async (_label, shape) => {
      clearAcceptanceVars();
      setFullyConfiguredEnv();
      mockDeps({
        anonHandlers: {
          list_practical_enrolments: () =>
            postgrestError(
              shape.code ?? "UNKNOWN",
              "unrelated failure",
              shape.status,
            ),
        },
      });
      const { checkJwtPostgrest } =
        await import("../scripts/acceptance/surfaces.mjs");
      const result = await checkJwtPostgrest();
      expect(result.status).toBe("FAIL");
    },
  );

  it("FAIL when the learner is NOT denied the admin-only activation-discovery RPC at all", async () => {
    clearAcceptanceVars();
    setFullyConfiguredEnv();
    mockDeps({
      learnerHandlers: { list_commercial_v1_activations: () => ok([]) },
    });
    const { checkJwtPostgrest } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkJwtPostgrest();
    expect(result.status).toBe("FAIL");
  });

  it.each([
    ["400 bad request, no 42501 code", { status: 400, code: null }],
    ["404 schema-cache miss (PGRST202)", { status: 404, code: "PGRST202" }],
    ["429 rate limited", { status: 429, code: null }],
    ["500 internal server error", { status: 500, code: null }],
    ["503 database outage", { status: 503, code: null }],
    // Even a 401 (the ANON shape) must not satisfy the AUTHENTICATED check.
    [
      "401 (the anon shape, not authenticated's)",
      { status: 401, code: "42501" },
    ],
  ])(
    "FAIL (blocker 2), never a PASS-worthy learner admin-RPC denial, for %s",
    async (_label, shape) => {
      clearAcceptanceVars();
      setFullyConfiguredEnv();
      mockDeps({
        learnerHandlers: {
          list_commercial_v1_activations: () =>
            postgrestError(
              shape.code ?? "UNKNOWN",
              "unrelated failure",
              shape.status,
            ),
        },
      });
      const { checkJwtPostgrest } =
        await import("../scripts/acceptance/surfaces.mjs");
      const result = await checkJwtPostgrest();
      expect(result.status).toBe("FAIL");
    },
  );

  it("FAIL when the invalid-JWT check gets back a 2xx response instead of a recognised JWT rejection", async () => {
    clearAcceptanceVars();
    setFullyConfiguredEnv();
    mockDeps({
      invalidJwtResult: { networkError: false, status: 200, ok: true },
    });
    const { checkJwtPostgrest } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkJwtPostgrest();
    expect(result.status).toBe("FAIL");
    expect(result.reason.toLowerCase()).toContain("malformed bearer jwt");
  });

  it.each([
    ["400 with no recognised auth code", { status: 400, code: null }],
    ["403 forbidden (RLS, not JWT/auth)", { status: 403, code: "42501" }],
    ["404 schema-cache miss", { status: 404, code: "PGRST205" }],
    ["429 rate limited", { status: 429, code: null }],
    ["500 internal server error", { status: 500, code: null }],
    ["503 database outage", { status: 503, code: null }],
    ["401 with no recognised code at all", { status: 401, code: null }],
  ])(
    "FAIL, never a PASS-worthy invalid-JWT rejection, for %s",
    async (_label, shape) => {
      clearAcceptanceVars();
      setFullyConfiguredEnv();
      mockDeps({
        invalidJwtResult: {
          networkError: false,
          ok: false,
          status: shape.status,
          code: shape.code,
          message: "unrelated failure",
        },
      });
      const { checkJwtPostgrest } =
        await import("../scripts/acceptance/surfaces.mjs");
      const result = await checkJwtPostgrest();
      expect(result.status).toBe("FAIL");
    },
  );

  it("FAIL, never treated as a denial, when the invalid-JWT check hits a network error", async () => {
    clearAcceptanceVars();
    setFullyConfiguredEnv();
    mockDeps({
      invalidJwtResult: {
        networkError: true,
        status: null,
        ok: false,
        networkErrorMessage: "ECONNREFUSED",
      },
    });
    const { checkJwtPostgrest } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkJwtPostgrest();
    expect(result.status).toBe("FAIL");
    expect(result.reason.toLowerCase()).toContain("network error");
  });

  it("FAIL (blocker 3, integration), never a PASS-worthy invalid-JWT rejection, for HTTP 401 + PGRST302 -- 'no Bearer header' is not evidence the SUPPLIED malformed token was inspected", async () => {
    clearAcceptanceVars();
    setFullyConfiguredEnv();
    mockDeps({
      invalidJwtResult: {
        networkError: false,
        status: 401,
        ok: false,
        code: "PGRST302",
        message: "Anonymous access is disabled",
      },
    });
    const { checkJwtPostgrest } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkJwtPostgrest();
    expect(result.status).toBe("FAIL");
  });

  it("FAIL when the expired-JWT check gets back a 2xx response instead of a rejection", async () => {
    clearAcceptanceVars();
    setFullyConfiguredEnv();
    mockDeps({
      expiredJwtResult: { networkError: false, status: 200, ok: true },
    });
    const { checkJwtPostgrest } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkJwtPostgrest();
    expect(result.status).toBe("FAIL");
    expect(result.reason.toLowerCase()).toContain("expired");
  });

  it("FAIL (blocker 2) when a structurally-expired token gets back only a GENERIC invalid-JWT rejection -- a bad signature with an old exp claim must not count as expiry evidence", async () => {
    clearAcceptanceVars();
    setFullyConfiguredEnv();
    mockDeps({
      expiredJwtResult: {
        networkError: false,
        status: 401,
        ok: false,
        code: "PGRST301",
        message: "JWT invalid",
      },
    });
    const { checkJwtPostgrest } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkJwtPostgrest();
    expect(result.status).toBe("FAIL");
    expect(result.reason.toLowerCase()).toContain(
      "does not establish that expiry enforcement",
    );
  });

  it.each([
    ["400 with no recognised auth code", { status: 400, code: null }],
    ["404 schema-cache miss", { status: 404, code: "PGRST205" }],
    ["500 internal server error", { status: 500, code: null }],
    ["503 database outage", { status: 503, code: null }],
  ])(
    "FAIL, never PASS-worthy expired-JWT evidence, for %s",
    async (_label, shape) => {
      clearAcceptanceVars();
      setFullyConfiguredEnv();
      mockDeps({
        expiredJwtResult: {
          networkError: false,
          ok: false,
          status: shape.status,
          code: shape.code,
          message: "JWT expired", // even a matching message is not enough without the right code/status
        },
      });
      const { checkJwtPostgrest } =
        await import("../scripts/acceptance/surfaces.mjs");
      const result = await checkJwtPostgrest();
      expect(result.status).toBe("FAIL");
    },
  );

  it("FAIL, never treated as a denial, when the expired-JWT check hits a network error", async () => {
    clearAcceptanceVars();
    setFullyConfiguredEnv();
    mockDeps({
      expiredJwtResult: {
        networkError: true,
        status: null,
        ok: false,
        networkErrorMessage: "ETIMEDOUT",
      },
    });
    const { checkJwtPostgrest } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkJwtPostgrest();
    expect(result.status).toBe("FAIL");
    expect(result.reason.toLowerCase()).toContain("network error");
  });

  it("BLOCKED, not silently trusted, when the configured 'unrelated staff' identity fails independent role verification", async () => {
    clearAcceptanceVars();
    setFullyConfiguredEnv();
    mockDeps({
      staffVerification: {
        verified: false,
        reason:
          "The configured 'unrelated staff' identity actually carries ACADEMIC_ADMIN or PLATFORM_ADMIN -- refusing to use it as a non-admin denial fixture.",
      },
    });
    const { checkJwtPostgrest } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkJwtPostgrest();
    expect(result.status).toBe("BLOCKED");
    expect(result.reason).toContain("ACADEMIC_ADMIN");
  });

  it("FAIL, never a vacuous PASS, when the learner's own enrolment list does not include the real, known enrolment this run just seeded", async () => {
    clearAcceptanceVars();
    setFullyConfiguredEnv();
    mockDeps({
      learnerHandlers: { list_practical_enrolments: () => ok([]) },
    });
    const { checkJwtPostgrest } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkJwtPostgrest();
    expect(result.status).toBe("FAIL");
  });

  it("FAIL when either learner's enrolment list includes the other's known-owned enrolment", async () => {
    clearAcceptanceVars();
    setFullyConfiguredEnv();
    mockDeps({
      foreignHandlers: {
        list_practical_enrolments: () => ok([{ id: "primary-enrolment" }]),
      },
    });
    const { checkJwtPostgrest } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkJwtPostgrest();
    expect(result.status).toBe("FAIL");
  });

  it("FAIL when a foreign learner supplying the primary learner's real enrolment id does NOT receive the documented NOT_FOUND_OR_FORBIDDEN denial", async () => {
    clearAcceptanceVars();
    setFullyConfiguredEnv();
    mockDeps({
      foreignHandlers: {
        get_commercial_v1_course_progress: () =>
          ok({ code: "OK", enrolment: {} }),
      },
    });
    const { checkJwtPostgrest } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkJwtPostgrest();
    expect(result.status).toBe("FAIL");
    expect(result.reason).toContain("NOT_FOUND_OR_FORBIDDEN");
  });

  it("FAIL when the primary learner supplying the foreign learner's real enrolment id does NOT receive the documented NOT_FOUND_OR_FORBIDDEN denial", async () => {
    clearAcceptanceVars();
    setFullyConfiguredEnv();
    mockDeps({
      learnerHandlers: {
        get_commercial_v1_course_progress: () => ok({ code: "OK" }),
      },
    });
    const { checkJwtPostgrest } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkJwtPostgrest();
    expect(result.status).toBe("FAIL");
  });

  it("FAIL when a learner's direct PostgREST read of assessment_answer_keys is NOT denied", async () => {
    clearAcceptanceVars();
    setFullyConfiguredEnv();
    mockDeps({
      learnerFromSelectResult: {
        data: [{ expected_answer: "42" }],
        error: null,
        status: 200,
      },
    });
    const { checkJwtPostgrest } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkJwtPostgrest();
    expect(result.status).toBe("FAIL");
    expect(result.reason.toLowerCase()).toContain("assessment_answer_keys");
  });

  it("FAIL (blocker 3A) when the assessment_answer_keys denial is not the documented insufficient-privilege shape (e.g. a 404 schema-cache miss, not HTTP 403/42501)", async () => {
    clearAcceptanceVars();
    setFullyConfiguredEnv();
    mockDeps({
      learnerFromSelectResult: {
        data: null,
        error: { message: "relation not found" },
        status: 404,
      },
    });
    const { checkJwtPostgrest } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkJwtPostgrest();
    expect(result.status).toBe("FAIL");
  });

  it("FAIL when get_active_assessment_questions releases content to a learner with no active attempt", async () => {
    clearAcceptanceVars();
    setFullyConfiguredEnv();
    mockDeps({
      learnerHandlers: {
        get_active_assessment_questions: () =>
          ok([{ id: "q1", position: 1, prompt: "...", max_marks: 5 }]),
      },
    });
    const { checkJwtPostgrest } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkJwtPostgrest();
    expect(result.status).toBe("FAIL");
  });

  it("FAIL (blocker 3B) when the 'no active attempt' denial is an unrelated RPC error, not the documented P0001 contract", async () => {
    clearAcceptanceVars();
    setFullyConfiguredEnv();
    mockDeps({
      learnerHandlers: {
        get_active_assessment_questions: () => denied("schema cache error"),
      },
    });
    const { checkJwtPostgrest } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkJwtPostgrest();
    expect(result.status).toBe("FAIL");
    expect(result.reason.toLowerCase()).toContain(
      "did not receive the documented",
    );
  });

  it("FAIL (blocker 3C) when the learner cannot start the seeded, in-window QUIZ_1 attempt", async () => {
    clearAcceptanceVars();
    setFullyConfiguredEnv();
    mockDeps({
      learnerHandlers: {
        start_assessment_attempt: () => denied("could not start"),
      },
    });
    const { checkJwtPostgrest } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkJwtPostgrest();
    expect(result.status).toBe("FAIL");
  });

  it("FAIL (blocker 3C) when a genuinely active attempt's released question leaks a protected field (expected_answer)", async () => {
    clearAcceptanceVars();
    setFullyConfiguredEnv();
    // Stateful, like mockDeps's own default -- the "no active attempt"
    // denial (the FIRST call, before start_assessment_attempt) must still
    // behave normally; only the POST-start release leaks the field this
    // test means to catch. A static always-succeeding override would trip
    // the earlier no-active-attempt check instead, never reaching start/
    // submit at all -- which is exactly the mistake this shape avoids.
    let hasActiveAttempt = false;
    const submitSpy = vi.fn(() => {
      hasActiveAttempt = false;
      return ok("attempt-1");
    });
    mockDeps({
      learnerHandlers: {
        start_assessment_attempt: () => {
          hasActiveAttempt = true;
          return ok("attempt-1");
        },
        get_active_assessment_questions: () =>
          hasActiveAttempt
            ? ok([
                {
                  id: "q1",
                  position: 1,
                  prompt: "...",
                  max_marks: 10,
                  expected_answer: "leaked",
                },
              ])
            : postgrestError(
                "P0001",
                "Protected assessment content requires an active attempt",
              ),
        submit_assessment_attempt: submitSpy,
      },
    });
    const { checkJwtPostgrest } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkJwtPostgrest();
    expect(result.status).toBe("FAIL");
    // Even though the projection itself failed, the started attempt must
    // still be terminalized -- the finally block runs regardless.
    expect(submitSpy).toHaveBeenCalled();
  });

  it("FAIL (blocker 3C) when a genuinely active attempt's release is empty", async () => {
    clearAcceptanceVars();
    setFullyConfiguredEnv();
    let hasActiveAttempt = false;
    mockDeps({
      learnerHandlers: {
        start_assessment_attempt: () => {
          hasActiveAttempt = true;
          return ok("attempt-1");
        },
        get_active_assessment_questions: () =>
          hasActiveAttempt
            ? ok([])
            : postgrestError(
                "P0001",
                "Protected assessment content requires an active attempt",
              ),
      },
    });
    const { checkJwtPostgrest } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkJwtPostgrest();
    expect(result.status).toBe("FAIL");
  });

  it("FAIL (blocker 3C), never a stranded ACTIVE attempt, when terminalization itself fails", async () => {
    clearAcceptanceVars();
    setFullyConfiguredEnv();
    const submitSpy = vi.fn(() => denied("cannot submit"));
    mockDeps({
      learnerHandlers: { submit_assessment_attempt: submitSpy },
    });
    const { checkJwtPostgrest } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkJwtPostgrest();
    expect(result.status).toBe("FAIL");
    expect(result.reason.toLowerCase()).toContain("terminaliz");
    expect(submitSpy).toHaveBeenCalled();
  });

  it("FAIL (blocker 3C), and both the original defect and the termination failure are recorded, when the projection fails AND terminalization also fails", async () => {
    clearAcceptanceVars();
    setFullyConfiguredEnv();
    let hasActiveAttempt = false;
    mockDeps({
      learnerHandlers: {
        start_assessment_attempt: () => {
          hasActiveAttempt = true;
          return ok("attempt-1");
        },
        get_active_assessment_questions: () =>
          hasActiveAttempt
            ? ok([])
            : postgrestError(
                "P0001",
                "Protected assessment content requires an active attempt",
              ),
        submit_assessment_attempt: () => denied("cannot submit either"),
      },
    });
    const { checkJwtPostgrest } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkJwtPostgrest();
    expect(result.status).toBe("FAIL");
    expect(JSON.stringify(result.details ?? [])).toContain(
      "could not be terminalized",
    );
  });

  it("FAIL when the learner's recovery role-gate call does not return the documented FORBIDDEN code", async () => {
    clearAcceptanceVars();
    setFullyConfiguredEnv();
    mockDeps({
      learnerHandlers: {
        govern_commercial_v1_examiner_recovery: () =>
          ok({ code: "UNTRUSTED_EXECUTION" }),
      },
    });
    const { checkJwtPostgrest } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkJwtPostgrest();
    expect(result.status).toBe("FAIL");
    expect(result.reason.toLowerCase()).toContain("learner");
  });

  it("FAIL when the unrelated (verified non-admin) staff identity's recovery role-gate call does not return FORBIDDEN", async () => {
    clearAcceptanceVars();
    setFullyConfiguredEnv();
    mockDeps({
      staffHandlers: {
        govern_commercial_v1_examiner_recovery: () =>
          ok({ code: "UNTRUSTED_EXECUTION" }),
      },
    });
    const { checkJwtPostgrest } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkJwtPostgrest();
    expect(result.status).toBe("FAIL");
  });

  it("FAIL when the authorized admin's deliberately non-authoritative recovery call is incorrectly denied at the role gate (FORBIDDEN) -- the role check itself would be broken", async () => {
    clearAcceptanceVars();
    setFullyConfiguredEnv();
    mockDeps({
      adminHandlers: {
        govern_commercial_v1_examiner_recovery: () => ok({ code: "FORBIDDEN" }),
      },
    });
    const { checkJwtPostgrest } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkJwtPostgrest();
    expect(result.status).toBe("FAIL");
    expect(result.reason.toLowerCase()).toContain(
      "role check itself appears broken",
    );
  });

  it("FAIL when the authorized admin's deliberately non-authoritative recovery call is incorrectly denied at the role gate (UNAUTHENTICATED)", async () => {
    clearAcceptanceVars();
    setFullyConfiguredEnv();
    mockDeps({
      adminHandlers: {
        govern_commercial_v1_examiner_recovery: () =>
          ok({ code: "UNAUTHENTICATED" }),
      },
    });
    const { checkJwtPostgrest } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkJwtPostgrest();
    expect(result.status).toBe("FAIL");
  });

  it("FAIL when the authorized admin's deliberately non-authoritative recovery call does not reach the expected post-role HMAC boundary result -- and this is explicitly NOT evidence of successful recovery either way", async () => {
    clearAcceptanceVars();
    setFullyConfiguredEnv();
    mockDeps({
      adminHandlers: {
        govern_commercial_v1_examiner_recovery: () =>
          ok({ code: "SOMETHING_ELSE" }),
      },
    });
    const { checkJwtPostgrest } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkJwtPostgrest();
    expect(result.status).toBe("FAIL");
    expect(result.reason.toLowerCase()).toContain(
      "not evidence of successful recovery",
    );
  });

  it("BLOCKED (never FAIL) when the same-environment write gate rejects the run while seeding the course", async () => {
    clearAcceptanceVars();
    setFullyConfiguredEnv();
    // The thrown error's class must come from the SAME db.mjs module
    // instance surfaces.mjs's own `instanceof` check resolves against --
    // vi.resetModules() (inside mockDeps) means a class reference captured
    // BEFORE that reset would be a different, unequal class. Importing
    // db.mjs lazily, inside the mocked implementation itself, guarantees
    // both resolve the same post-reset module instance.
    mockDeps({
      seedAcceptanceCourseImpl: async () => {
        const { AcceptanceWriteNotAuthorizedError } =
          await import("../scripts/acceptance/db.mjs");
        throw new AcceptanceWriteNotAuthorizedError("environment mismatch");
      },
    });
    const { checkJwtPostgrest } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkJwtPostgrest();
    expect(result.status).toBe("BLOCKED");
  });

  it("PASS's own evidence explicitly records that all four identities resolved to pairwise-distinct hosted Auth user ids (blocker 4)", async () => {
    clearAcceptanceVars();
    setFullyConfiguredEnv();
    mockDeps();
    const { checkJwtPostgrest } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkJwtPostgrest();
    expect(result.status).toBe("PASS");
    expect(JSON.stringify(result.details ?? [])).toContain("pairwise-distinct");
  });

  it("BLOCKED when the configured 'unrelated staff' identity resolves to the SAME hosted Auth user id as the learner (blocker 4)", async () => {
    clearAcceptanceVars();
    setFullyConfiguredEnv();
    mockDeps({ authUserIds: { unrelatedStaff: "learner-auth-id" } });
    const { checkJwtPostgrest } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkJwtPostgrest();
    expect(result.status).toBe("BLOCKED");
    expect(result.reason.toLowerCase()).toContain("same hosted supabase");
  });

  it("BLOCKED when the configured 'unrelated staff' identity resolves to the SAME hosted Auth user id as the foreign learner (blocker 4)", async () => {
    clearAcceptanceVars();
    setFullyConfiguredEnv();
    mockDeps({ authUserIds: { unrelatedStaff: "foreign-auth-id" } });
    const { checkJwtPostgrest } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkJwtPostgrest();
    expect(result.status).toBe("BLOCKED");
  });

  it("BLOCKED when the configured 'unrelated staff' identity resolves to the SAME hosted Auth user id as the admin (blocker 4)", async () => {
    clearAcceptanceVars();
    setFullyConfiguredEnv();
    mockDeps({ authUserIds: { unrelatedStaff: "admin-auth-id" } });
    const { checkJwtPostgrest } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkJwtPostgrest();
    expect(result.status).toBe("BLOCKED");
  });

  it("BLOCKED when the learner and the foreign learner happen to resolve to the SAME hosted Auth user id (blocker 4, any pair, not only staff)", async () => {
    clearAcceptanceVars();
    setFullyConfiguredEnv();
    mockDeps({ authUserIds: { foreign: "learner-auth-id" } });
    const { checkJwtPostgrest } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkJwtPostgrest();
    expect(result.status).toBe("BLOCKED");
  });

  it("FAIL, never PASS, when an identity's own auth.getUser() call errors before the distinctness check can even run (blocker 4)", async () => {
    clearAcceptanceVars();
    setFullyConfiguredEnv();
    mockDeps({ authUserErrors: { learner: "session invalid" } });
    const { checkJwtPostgrest } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkJwtPostgrest();
    expect(result.status).toBe("FAIL");
    expect(result.status).not.toBe("PASS");
  });

  it("FAIL, never PASS, when an identity's auth.getUser() returns no user id at all", async () => {
    clearAcceptanceVars();
    setFullyConfiguredEnv();
    mockDeps({ authUserIds: { admin: "" } });
    const { checkJwtPostgrest } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkJwtPostgrest();
    expect(result.status).not.toBe("PASS");
  });
});

describe("acceptance harness: JWT_POSTGREST completion -- structural JWT helpers (jwt.mjs) never verify a signature", () => {
  it("decodeJwtPayloadStructurally decodes a real base64url JWT payload without touching its signature", async () => {
    const { decodeJwtPayloadStructurally } =
      await import("../scripts/acceptance/jwt.mjs");
    const payload = decodeJwtPayloadStructurally(makeFakeJwt(3600)) as {
      exp: number;
    };
    expect(payload).not.toBeNull();
    expect(typeof payload.exp).toBe("number");
  });

  it("decodeJwtPayloadStructurally returns null for anything not three dot-separated, non-empty segments", async () => {
    const { decodeJwtPayloadStructurally } =
      await import("../scripts/acceptance/jwt.mjs");
    expect(decodeJwtPayloadStructurally("not-a-jwt")).toBeNull();
    expect(decodeJwtPayloadStructurally("a.b")).toBeNull();
    expect(decodeJwtPayloadStructurally("a..c")).toBeNull();
    expect(
      decodeJwtPayloadStructurally(undefined as unknown as string),
    ).toBeNull();
  });

  it("isStructurallyExpiredJwt is true only when exp is a genuinely past timestamp", async () => {
    const { isStructurallyExpiredJwt } =
      await import("../scripts/acceptance/jwt.mjs");
    expect(isStructurallyExpiredJwt(makeFakeJwt(-3600))).toBe(true);
    expect(isStructurallyExpiredJwt(makeFakeJwt(3600))).toBe(false);
    expect(isStructurallyExpiredJwt("not-a-jwt")).toBe(false);
  });

  it("isStructurallyExpiredJwt's optional skewSeconds requires the expiry to be COMFORTABLY in the past, not merely in the past (blocker 2)", async () => {
    const { isStructurallyExpiredJwt } =
      await import("../scripts/acceptance/jwt.mjs");
    // Expired 30s ago: past with no skew, but NOT comfortably past a
    // 300s clock-skew allowance.
    const barelyExpired = makeFakeJwt(-30);
    expect(isStructurallyExpiredJwt(barelyExpired)).toBe(true);
    expect(isStructurallyExpiredJwt(barelyExpired, 300)).toBe(false);
    // Expired 3600s ago comfortably clears any ordinary skew allowance.
    const comfortablyExpired = makeFakeJwt(-3600);
    expect(isStructurallyExpiredJwt(comfortablyExpired, 300)).toBe(true);
  });

  it("jwt.mjs never imports a signature-verification or JWT-signing library -- structural decoding only", async () => {
    const text = await readFile(
      new URL("../scripts/acceptance/jwt.mjs", import.meta.url),
      "utf8",
    );
    expect(text).not.toMatch(/createHmac|createVerify|jsonwebtoken|jose/);
  });
});

describe("acceptance harness: JWT_POSTGREST completion -- callProtectedRpcWithBearerToken distinguishes network errors from denials", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    vi.resetModules();
  });

  it("networkError: true when fetch itself throws -- never mistaken for a denial", async () => {
    clearAcceptanceVars();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "publishable-key";
    global.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const { callProtectedRpcWithBearerToken } =
      await import("../scripts/acceptance/supabase.mjs");
    const result = await callProtectedRpcWithBearerToken(
      "list_practical_enrolments",
      "bad-token",
    );
    expect(result.networkError).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.networkErrorMessage).toContain("ECONNREFUSED");
  });

  it("networkError: false with the real HTTP status when fetch completes (a rejection, not a network failure)", async () => {
    clearAcceptanceVars();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "publishable-key";
    global.fetch = (async () =>
      new Response(null, { status: 401 })) as typeof fetch;
    const { callProtectedRpcWithBearerToken } =
      await import("../scripts/acceptance/supabase.mjs");
    const result = await callProtectedRpcWithBearerToken(
      "list_practical_enrolments",
      "bad-token",
    );
    expect(result.networkError).toBe(false);
    expect(result.status).toBe(401);
    expect(result.ok).toBe(false);
  });

  it("parses the bounded PostgREST JSON error envelope into ONLY code/message -- never the raw body itself", async () => {
    clearAcceptanceVars();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "publishable-key";
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          code: "PGRST301",
          message: "JWT expired",
          details: "some-internal-detail-never-surfaced",
          hint: "some-internal-hint-never-surfaced",
        }),
        { status: 401 },
      )) as typeof fetch;
    const { callProtectedRpcWithBearerToken } =
      await import("../scripts/acceptance/supabase.mjs");
    const result = await callProtectedRpcWithBearerToken(
      "list_practical_enrolments",
      "expired-token",
    );
    expect(result.code).toBe("PGRST301");
    expect(result.message).toBe("JWT expired");
    expect(result.bodyParseError).toBe(false);
    expect(Object.keys(result).sort()).toEqual(
      [
        "bodyParseError",
        "code",
        "message",
        "networkError",
        "ok",
        "status",
      ].sort(),
    );
  });

  it("honestly reports bodyParseError, never a fabricated code/message, when the response body is not the expected JSON envelope", async () => {
    clearAcceptanceVars();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "publishable-key";
    global.fetch = (async () =>
      new Response("<html>not json</html>", { status: 401 })) as typeof fetch;
    const { callProtectedRpcWithBearerToken } =
      await import("../scripts/acceptance/supabase.mjs");
    const result = await callProtectedRpcWithBearerToken(
      "list_practical_enrolments",
      "bad-token",
    );
    expect(result.networkError).toBe(false);
    expect(result.bodyParseError).toBe(true);
    expect(result.code).toBeNull();
    expect(result.message).toBeNull();
  });

  it("never returns the raw token or a response body -- only the bounded code/message/status classification fields", async () => {
    clearAcceptanceVars();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "publishable-key";
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          code: "PGRST301",
          message: "JWT expired",
          details: "super-secret-response-body-detail",
        }),
        { status: 401 },
      )) as typeof fetch;
    const { callProtectedRpcWithBearerToken } =
      await import("../scripts/acceptance/supabase.mjs");
    const result = await callProtectedRpcWithBearerToken(
      "list_practical_enrolments",
      "the-raw-bearer-token-value",
    );
    expect(JSON.stringify(result)).not.toContain(
      "super-secret-response-body-detail",
    );
    expect(JSON.stringify(result)).not.toContain("the-raw-bearer-token-value");
  });
});

describe("acceptance harness: JWT_POSTGREST completion -- isJwtAuthRejection/isJwtExpiryRejection never accept an arbitrary non-2xx status or an unrelated PGRST3XX code (blockers 1, 2 & 3)", () => {
  function response(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      networkError: false,
      status: 401,
      ok: false,
      code: "PGRST301",
      message: "JWT invalid",
      bodyParseError: false,
      ...overrides,
    };
  }

  it.each([
    ["401 + PGRST301 (JWT invalid)", { status: 401, code: "PGRST301" }],
    ["401 + PGRST303", { status: 401, code: "PGRST303" }],
  ])(
    "isJwtAuthRejection is true for a genuine hosted rejection: %s",
    async (_label, shape) => {
      const { isJwtAuthRejection } =
        await import("../scripts/acceptance/supabase.mjs");
      expect(isJwtAuthRejection(response(shape))).toBe(true);
    },
  );

  it.each([
    ["400 bad request, no PGRST3XX code", { status: 400, code: null }],
    ["403 forbidden (RLS, not JWT/auth)", { status: 403, code: "42501" }],
    ["404 schema-cache miss", { status: 404, code: "PGRST205" }],
    ["429 rate limited", { status: 429, code: null }],
    ["500 internal server error", { status: 500, code: null }],
    ["503 database outage", { status: 503, code: null }],
    ["401 with no recognised code", { status: 401, code: null }],
    ["401 with an unrelated code", { status: 401, code: "PGRST116" }],
    ["2xx success", { status: 200, ok: true, code: null }],
    // Blocker 3: PGRST302 ("Bearer header missing while anon role is
    // disabled") is NOT eligible even though it is in the PGRST3XX
    // family -- this harness's checks always send a Bearer token, so a
    // "no Bearer header at all" rejection could never mean the SUPPLIED
    // token was inspected and rejected.
    [
      "401 + PGRST302 (no Bearer header at all)",
      { status: 401, code: "PGRST302" },
    ],
    // An arbitrary/unknown PGRST3XX suffix must not be automatically
    // eligible either -- only the exact PGRST301/PGRST303 pair is.
    [
      "401 + an arbitrary unknown PGRST3XX code",
      { status: 401, code: "PGRST399" },
    ],
  ])(
    "isJwtAuthRejection is false for an unrelated failure: %s",
    async (_label, shape) => {
      const { isJwtAuthRejection } =
        await import("../scripts/acceptance/supabase.mjs");
      expect(isJwtAuthRejection(response(shape))).toBe(false);
    },
  );

  it("isJwtAuthRejection is false for HTTP 401 + PGRST302 specifically (blocker 3) -- the harness always sends a Bearer token, so 'no Bearer header' is never evidence it was inspected", async () => {
    const { isJwtAuthRejection } =
      await import("../scripts/acceptance/supabase.mjs");
    expect(
      isJwtAuthRejection(response({ status: 401, code: "PGRST302" })),
    ).toBe(false);
  });

  it("isJwtAuthRejection is true for HTTP 401 + PGRST301, and true for HTTP 401 + PGRST303 (blocker 3 regression)", async () => {
    const { isJwtAuthRejection } =
      await import("../scripts/acceptance/supabase.mjs");
    expect(
      isJwtAuthRejection(response({ status: 401, code: "PGRST301" })),
    ).toBe(true);
    expect(
      isJwtAuthRejection(response({ status: 401, code: "PGRST303" })),
    ).toBe(true);
  });

  it.each([400, 403, 404, 429, 500, 503])(
    "isJwtAuthRejection is false for HTTP %i even with an otherwise-eligible PGRST301 code -- every non-401 status is ineligible",
    async (status) => {
      const { isJwtAuthRejection } =
        await import("../scripts/acceptance/supabase.mjs");
      expect(isJwtAuthRejection(response({ status, code: "PGRST301" }))).toBe(
        false,
      );
    },
  );

  it("isJwtAuthRejection is false for a network error, regardless of any status/code fields left over", async () => {
    const { isJwtAuthRejection } =
      await import("../scripts/acceptance/supabase.mjs");
    expect(
      isJwtAuthRejection({
        networkError: true,
        status: 401,
        code: "PGRST301",
        message: "JWT invalid",
      }),
    ).toBe(false);
  });

  it("isJwtExpiryRejection is true only when isJwtAuthRejection is ALSO true AND the message specifically identifies expiry (case-insensitive)", async () => {
    const { isJwtExpiryRejection } =
      await import("../scripts/acceptance/supabase.mjs");
    expect(isJwtExpiryRejection(response({ message: "JWT expired" }))).toBe(
      true,
    );
    expect(
      isJwtExpiryRejection(response({ message: "jwt EXPIRED for user" })),
    ).toBe(true);
  });

  it("isJwtExpiryRejection is false for a GENERIC invalid-JWT rejection -- the same shape a merely malformed token gets (blocker 2)", async () => {
    const { isJwtExpiryRejection } =
      await import("../scripts/acceptance/supabase.mjs");
    expect(isJwtExpiryRejection(response({ message: "JWT invalid" }))).toBe(
      false,
    );
    expect(isJwtExpiryRejection(response({ message: null }))).toBe(false);
  });

  it("isJwtExpiryRejection is false whenever isJwtAuthRejection is false, even if the message happens to mention 'expired'", async () => {
    const { isJwtExpiryRejection } =
      await import("../scripts/acceptance/supabase.mjs");
    expect(
      isJwtExpiryRejection(
        response({ status: 500, code: null, message: "session expired" }),
      ),
    ).toBe(false);
  });
});

describe("acceptance harness: JWT_POSTGREST completion -- verifyNonAdminStaffRole never trusts the identity by label", () => {
  it("verified: false when the identity does not actually carry the wanted staff role", async () => {
    const { verifyNonAdminStaffRole } =
      await import("../scripts/acceptance/supabase.mjs");
    const fakeClient = {
      rpc: async () => ({ data: false, error: null }),
    };
    const result = await verifyNonAdminStaffRole(fakeClient, "INSTRUCTOR");
    expect(result.verified).toBe(false);
  });

  it("verified: false when the identity actually carries ACADEMIC_ADMIN, even though it also carries the wanted staff role", async () => {
    const { verifyNonAdminStaffRole } =
      await import("../scripts/acceptance/supabase.mjs");
    const fakeClient = {
      rpc: async (name: string, args: { wanted: string }) => ({
        data: args.wanted === "INSTRUCTOR" || args.wanted === "ACADEMIC_ADMIN",
        error: null,
      }),
    };
    const result = await verifyNonAdminStaffRole(fakeClient, "INSTRUCTOR");
    expect(result.verified).toBe(false);
    expect(result.reason).toContain("ACADEMIC_ADMIN");
  });

  it("verified: false when the identity actually carries PLATFORM_ADMIN", async () => {
    const { verifyNonAdminStaffRole } =
      await import("../scripts/acceptance/supabase.mjs");
    const fakeClient = {
      rpc: async (name: string, args: { wanted: string }) => ({
        data: args.wanted === "INSTRUCTOR" || args.wanted === "PLATFORM_ADMIN",
        error: null,
      }),
    };
    const result = await verifyNonAdminStaffRole(fakeClient, "INSTRUCTOR");
    expect(result.verified).toBe(false);
  });

  it("verified: true only when has_role confirms the staff role AND both admin roles are confirmed absent", async () => {
    const { verifyNonAdminStaffRole } =
      await import("../scripts/acceptance/supabase.mjs");
    const fakeClient = {
      rpc: async (name: string, args: { wanted: string }) => ({
        data: args.wanted === "INSTRUCTOR",
        error: null,
      }),
    };
    const result = await verifyNonAdminStaffRole(fakeClient, "INSTRUCTOR");
    expect(result.verified).toBe(true);
  });

  it("fails closed (verified: false) if any has_role RPC call itself errors", async () => {
    const { verifyNonAdminStaffRole } =
      await import("../scripts/acceptance/supabase.mjs");
    const fakeClient = {
      rpc: async () => ({
        data: null,
        error: { message: "function does not exist" },
      }),
    };
    const result = await verifyNonAdminStaffRole(fakeClient, "INSTRUCTOR");
    expect(result.verified).toBe(false);
  });
});

describe("acceptance harness: JWT_POSTGREST completion -- no HMAC signing implementation exists anywhere in the acceptance scripts", () => {
  it("surfaces.mjs's recovery invocation uses a fixed, obviously non-authoritative p_mac placeholder -- never a computed signature", async () => {
    const text = await readFile(
      new URL("../scripts/acceptance/surfaces.mjs", import.meta.url),
      "utf8",
    );
    expect(text).not.toMatch(/createHmac/);
    expect(text).toContain('p_mac: "0".repeat(64)');
  });

  it("no acceptance script imports node:crypto's createHmac or a JWT-signing library", async () => {
    const filenames = [
      "surfaces.mjs",
      "supabase.mjs",
      "fixtures.mjs",
      "jwt.mjs",
      "env.mjs",
      "db.mjs",
    ];
    for (const filename of filenames) {
      const text = await readFile(
        new URL(`../scripts/acceptance/${filename}`, import.meta.url),
        "utf8",
      );
      expect(text).not.toMatch(/createHmac|jsonwebtoken|jose\//);
    }
  });
});

describe("acceptance harness: JWT_POSTGREST completion -- new acceptance-only env vars are never read by application source", () => {
  it("ACCEPTANCE_EXPIRED_LEARNER_JWT and ACCEPTANCE_UNRELATED_STAFF_EMAIL/PASSWORD never appear anywhere under src/**", async () => {
    const forbidden = [
      "ACCEPTANCE_EXPIRED_LEARNER_JWT",
      "ACCEPTANCE_UNRELATED_STAFF_EMAIL",
      "ACCEPTANCE_UNRELATED_STAFF_PASSWORD",
    ];
    const srcRoot = fileURLToPath(new URL("../src/", import.meta.url));
    async function walk(dir: string): Promise<string[]> {
      const entries = await readdir(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) files.push(...(await walk(full)));
        else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) files.push(full);
      }
      return files;
    }
    const files = await walk(srcRoot);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = await readFile(file, "utf8");
      for (const name of forbidden) expect(text).not.toContain(name);
    }
  });
});

describe("acceptance harness: JWT_POSTGREST completion -- preflight never prints the new credential/JWT values", () => {
  it("ACCEPTANCE_EXPIRED_LEARNER_JWT's report carries no value field, and the raw token never appears in it", async () => {
    clearAcceptanceVars();
    const token = makeFakeJwt(-3600);
    process.env.ACCEPTANCE_EXPIRED_LEARNER_JWT = token;
    const { preflightReport } = await import("../scripts/acceptance/env.mjs");
    const report = (preflightReport() as VarReport[]).find(
      (r) => r.name === "ACCEPTANCE_EXPIRED_LEARNER_JWT",
    )!;
    expect(Object.keys(report).sort()).toEqual(["name", "scope", "status"]);
    expect(report.status).toBe("configured");
    expect(JSON.stringify(report)).not.toContain(token);
  });

  it("ACCEPTANCE_UNRELATED_STAFF_EMAIL/PASSWORD reports carry no value field", async () => {
    clearAcceptanceVars();
    process.env.ACCEPTANCE_UNRELATED_STAFF_EMAIL = "staff@example.com";
    process.env.ACCEPTANCE_UNRELATED_STAFF_PASSWORD = "top-secret-password";
    const { preflightReport } = await import("../scripts/acceptance/env.mjs");
    const reports = preflightReport() as VarReport[];
    const emailReport = reports.find(
      (r) => r.name === "ACCEPTANCE_UNRELATED_STAFF_EMAIL",
    )!;
    const passwordReport = reports.find(
      (r) => r.name === "ACCEPTANCE_UNRELATED_STAFF_PASSWORD",
    )!;
    expect(Object.keys(emailReport).sort()).toEqual([
      "name",
      "scope",
      "status",
    ]);
    expect(Object.keys(passwordReport).sort()).toEqual([
      "name",
      "scope",
      "status",
    ]);
    expect(JSON.stringify(reports)).not.toContain("top-secret-password");
    expect(JSON.stringify(reports)).not.toContain("staff@example.com");
  });

  it("ACCEPTANCE_EXPIRED_LEARNER_JWT is reported malformed when not structurally JWT-shaped", async () => {
    clearAcceptanceVars();
    process.env.ACCEPTANCE_EXPIRED_LEARNER_JWT = "not-a-jwt-at-all";
    const { statusOf } = await import("../scripts/acceptance/env.mjs");
    expect(statusOf("ACCEPTANCE_EXPIRED_LEARNER_JWT")).toBe("malformed");
  });
});

describe("acceptance harness: Stripe live-key detection", () => {
  it("flags an sk_live_ key as live, never sk_test_", async () => {
    clearAcceptanceVars();
    process.env.STRIPE_SECRET_KEY = "sk_live_abcdef";
    const { stripeLooksLive } = await import("../scripts/acceptance/env.mjs");
    expect(stripeLooksLive()).toBe(true);
  });
  it("does not flag a test-mode key as live", async () => {
    clearAcceptanceVars();
    process.env.STRIPE_SECRET_KEY = "sk_test_abcdef";
    const { stripeLooksLive } = await import("../scripts/acceptance/env.mjs");
    expect(stripeLooksLive()).toBe(false);
  });
  it("does not flag an absent key as live", async () => {
    clearAcceptanceVars();
    const { stripeLooksLive } = await import("../scripts/acceptance/env.mjs");
    expect(stripeLooksLive()).toBe(false);
  });
});

describe("acceptance harness: live-provider gating", () => {
  it("never opts in merely because native provider credentials exist", async () => {
    clearAcceptanceVars();
    process.env.OPENAI_API_KEY = "sk-openai-sentinel";
    process.env.ANTHROPIC_API_KEY = "sk-ant-sentinel";
    const { liveProviderOptedIn } =
      await import("../scripts/acceptance/env.mjs");
    expect(liveProviderOptedIn()).toBe(false);
  });
  it("requires the opt-in flag to be exactly the string 'true'", async () => {
    clearAcceptanceVars();
    const { liveProviderOptedIn } =
      await import("../scripts/acceptance/env.mjs");
    for (const value of ["yes", "TRUE", " true", "true ", "1"]) {
      process.env.ACCEPTANCE_LIVE_PROVIDER_OPT_IN = value;
      expect(liveProviderOptedIn()).toBe(false);
    }
    process.env.ACCEPTANCE_LIVE_PROVIDER_OPT_IN = "true";
    expect(liveProviderOptedIn()).toBe(true);
  });
  it("preflight knows the current native keys and labels ACADEMIC_PROVIDER_* as legacy", async () => {
    clearAcceptanceVars();
    process.env.OPENAI_API_KEY = "sk-openai-sentinel";
    const { preflightReport, KNOWN_VARS } =
      await import("../scripts/acceptance/env.mjs");
    const byName = Object.fromEntries(
      (preflightReport() as VarReport[]).map((r) => [r.name, r]),
    );
    expect(byName.OPENAI_API_KEY.status).toBe("configured");
    expect(byName.ANTHROPIC_API_KEY.status).toBe("missing");
    expect(JSON.stringify(preflightReport())).not.toContain(
      "sk-openai-sentinel",
    );
    const notes = Object.fromEntries(
      (KNOWN_VARS as { name: string; note: string }[]).map((v) => [
        v.name,
        v.note,
      ]),
    );
    expect(notes.ACADEMIC_PROVIDER_BASE_URL).toMatch(/^LEGACY/);
    expect(notes.ACADEMIC_PROVIDER_API_KEY).toMatch(/^LEGACY/);
  });
  it("the broad LIVE_PROVIDER surface is always BLOCKED and points at the dedicated command, even fully configured and opted in", async () => {
    clearAcceptanceVars();
    process.env.OPENAI_API_KEY = "sk-openai-sentinel";
    process.env.ANTHROPIC_API_KEY = "sk-ant-sentinel";
    process.env.ACCEPTANCE_LIVE_PROVIDER_OPT_IN = "true";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const { checkLiveProvider } =
        await import("../scripts/acceptance/surfaces.mjs");
      const result = await checkLiveProvider();
      expect(result.status).toBe("BLOCKED");
      expect(result.reason).toContain("npm run acceptance:live-provider");
      expect(result.details).toContain("OPENAI_API_KEY: configured");
      expect(result.details).toContain("ANTHROPIC_API_KEY: configured");
      expect(JSON.stringify(result)).not.toMatch(/sentinel/);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("the broad LIVE_PROVIDER surface no longer depends on the legacy ACADEMIC_PROVIDER_* pair", async () => {
    clearAcceptanceVars();
    process.env.ACADEMIC_PROVIDER_BASE_URL = "https://provider.example.com";
    process.env.ACADEMIC_PROVIDER_API_KEY = "legacy-sentinel";
    const { checkLiveProvider } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkLiveProvider();
    expect(result.status).toBe("BLOCKED");
    expect(result.reason).not.toContain("ACADEMIC_PROVIDER");
    expect(JSON.stringify(result)).not.toContain("legacy-sentinel");
  });
});

describe("acceptance harness: the broad STRIPE_TEST_MODE surface never calls Stripe (K)", () => {
  async function checkWithSpies() {
    const fetchSpy = vi.fn();
    const stripeConstructed = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.doMock("stripe", () => ({ default: stripeConstructed }));
    vi.resetModules();
    try {
      const { checkStripeTestMode } =
        await import("../scripts/acceptance/surfaces.mjs");
      return {
        result: await checkStripeTestMode(),
        fetchSpy,
        stripeConstructed,
      };
    } finally {
      vi.doUnmock("stripe");
      vi.unstubAllGlobals();
    }
  }

  it("fully configured and opted in: still BLOCKED (never a connectivity-only PASS) and points at the dedicated command", async () => {
    clearAcceptanceVars();
    process.env.STRIPE_SECRET_KEY = "sk_test_stripe-sentinel";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_webhook-sentinel";
    process.env.COMMERCE_CONTROLLER_KEY_ID =
      "b0000000-0000-4000-8000-000000000003";
    process.env.COMMERCE_CONTROLLER_HMAC_KEY_HEX = "d".repeat(64);
    process.env.ACCEPTANCE_STRIPE_TEST_OPT_IN = "true";
    const { result, fetchSpy, stripeConstructed } = await checkWithSpies();
    expect(result.status).toBe("BLOCKED");
    expect(result.reason).toContain(
      "npm run acceptance:stripe -- --authorize-stripe-test",
    );
    expect(result.details).toContain(
      "STRIPE_SECRET_KEY: sk_test_ prefix detected; the dedicated command performs strict test-key validation",
    );
    expect(result.details).toContain("STRIPE_WEBHOOK_SECRET: configured");
    expect(result.details).toContain(
      "ACCEPTANCE_STRIPE_TEST_OPT_IN: exactly 'true'",
    );
    expect(JSON.stringify(result)).not.toMatch(/sentinel|d{64}/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stripeConstructed).not.toHaveBeenCalled();
  });

  it("BLOCKED, never FAIL or PASS, and labels a live-mode key shape without calling Stripe", async () => {
    clearAcceptanceVars();
    process.env.STRIPE_SECRET_KEY = "sk_live_abcdef";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_abcdef";
    const { result, fetchSpy, stripeConstructed } = await checkWithSpies();
    expect(result.status).toBe("BLOCKED");
    expect(result.details.join(" ")).toContain(
      "sk_live_ prefix detected (LIVE mode)",
    );
    expect(JSON.stringify(result)).not.toContain("test-mode shape");
    expect(JSON.stringify(result)).not.toContain("sk_live_abcdef");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stripeConstructed).not.toHaveBeenCalled();
  });

  it("BLOCKED when Stripe credentials are absent entirely", async () => {
    clearAcceptanceVars();
    const { result } = await checkWithSpies();
    expect(result.status).toBe("BLOCKED");
    expect(result.details).toContain("STRIPE_SECRET_KEY: missing or malformed");
  });

  it("the surface source no longer imports or constructs the Stripe SDK", async () => {
    const source = await readFile(
      new URL("../scripts/acceptance/surfaces.mjs", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/import\(["']stripe["']\)|from ["']stripe["']/);
    expect(source).not.toContain("balance.retrieve");
  });

  it("ACCEPTANCE_STRIPE_TEST_OPT_IN is a known acceptance variable and must be exactly 'true'", async () => {
    clearAcceptanceVars();
    const { statusOf, stripeTestOptedIn } =
      await import("../scripts/acceptance/env.mjs");
    process.env.ACCEPTANCE_STRIPE_TEST_OPT_IN = "yes";
    expect(statusOf("ACCEPTANCE_STRIPE_TEST_OPT_IN")).toBe("malformed");
    expect(stripeTestOptedIn()).toBe(false);
    process.env.ACCEPTANCE_STRIPE_LIVE_OPT_IN = "true";
    expect(stripeTestOptedIn()).toBe(false);
    process.env.ACCEPTANCE_STRIPE_TEST_OPT_IN = "true";
    expect(stripeTestOptedIn()).toBe(true);
  });
});

describe("acceptance harness: hosted-only surfaces block honestly without a database", () => {
  it("HOSTED_DATABASE, MIGRATIONS, RLS_ACL and POSTGRES_CONCURRENCY-adjacent RESULT_PROGRESS_COMPLETION all report BLOCKED, never PASS or FAIL, without ACCEPTANCE_DATABASE_URL", async () => {
    clearAcceptanceVars();
    const surfaces = await import("../scripts/acceptance/surfaces.mjs");
    for (const check of [
      surfaces.checkHostedDatabase,
      surfaces.checkMigrations,
      surfaces.checkRlsAcl,
      surfaces.checkResultProgressCompletion,
    ]) {
      const result = await check();
      expect(result.status).toBe("BLOCKED");
    }
  });
  it("JWT_POSTGREST and SUPABASE_AUTH_EMAIL report BLOCKED without hosted Supabase configuration", async () => {
    clearAcceptanceVars();
    const surfaces = await import("../scripts/acceptance/surfaces.mjs");
    expect((await surfaces.checkJwtPostgrest()).status).toBe("BLOCKED");
    expect((await surfaces.checkSupabaseAuthEmail()).status).toBe("BLOCKED");
  });
  it("GRADING/INITIAL_RECOVERY/REGRADE are always BLOCKED by design, never PASS, regardless of configuration", async () => {
    clearAcceptanceVars();
    process.env.ACADEMIC_EXECUTION_KEY_ID =
      "10000000-0000-4000-8000-000000000001";
    process.env.ACADEMIC_EXECUTION_HMAC_KEY_HEX = "a".repeat(64);
    const surfaces = await import("../scripts/acceptance/surfaces.mjs");
    for (const check of [
      surfaces.checkGrading,
      surfaces.checkInitialRecovery,
      surfaces.checkRegrade,
    ]) {
      const result = await check();
      expect(result.status).toBe("BLOCKED");
      expect(result.reason).toMatch(/real Ducelio application server/);
    }
  });
  it("MONITORING and BACKUP_RESTORE are always BLOCKED -- never fabricated evidence", async () => {
    clearAcceptanceVars();
    const surfaces = await import("../scripts/acceptance/surfaces.mjs");
    expect((await surfaces.checkMonitoring()).status).toBe("BLOCKED");
    expect((await surfaces.checkBackupRestore()).status).toBe("BLOCKED");
  });
  it("FULL_CUSTOMER_JOURNEY is always NOT_RUN in the broad matrix, pointing to acceptance:journey -- never inferred from other surfaces", async () => {
    clearAcceptanceVars();
    const surfaces = await import("../scripts/acceptance/surfaces.mjs");
    const result = await surfaces.checkFullCustomerJourney();
    expect(result.status).toBe("NOT_RUN");
    expect(result.reason).toContain("npm run acceptance:journey");
    // Even an all-PASS prerequisite set cannot turn it into a journey claim.
    const allPass = [
      "HOSTED_DATABASE",
      "MIGRATIONS",
      "GRADING",
      "RESULT_PROGRESS_COMPLETION",
      "STRIPE_TEST_MODE",
    ].map((surface) => ({ surface, status: "PASS", reason: "x" }));
    expect(
      (
        await (
          surfaces.checkFullCustomerJourney as (
            r?: unknown,
          ) => Promise<{ status: string }>
        )(allPass)
      ).status,
    ).toBe("NOT_RUN");
    const hosted = await readFile(
      new URL("../scripts/acceptance/hosted.mjs", import.meta.url),
      "utf8",
    );
    expect(hosted).not.toMatch(/customer-journey/);
  });
});

describe("acceptance harness: report.mjs status semantics", () => {
  it("exitCodeFor is non-zero only when at least one FAIL exists", async () => {
    const { exitCodeFor, pass, blocked, notRun, fail } =
      await import("../scripts/acceptance/report.mjs");
    expect(
      exitCodeFor([pass("A", "ok"), blocked("B", "x"), notRun("C", "x")]),
    ).toBe(0);
    expect(exitCodeFor([pass("A", "ok"), fail("B", "broken")])).toBe(1);
  });
  it("blocked/notRun are never silently treated as pass", async () => {
    const { blocked, notRun } =
      await import("../scripts/acceptance/report.mjs");
    expect(blocked("X", "missing prereq").status).toBe("BLOCKED");
    expect(notRun("X", "not attempted").status).toBe("NOT_RUN");
  });
});

describe("acceptance harness: synthetic fixture run ids are scoped", () => {
  it("buildAcceptancePackage embeds the runId in its package key, never a fixed/shared key", async () => {
    const { buildAcceptancePackage } =
      await import("../scripts/acceptance/fixtures.mjs");
    const a = buildAcceptancePackage("run-alpha");
    const b = buildAcceptancePackage("run-beta");
    expect(a.packageKey).toBe("acceptance-run-alpha");
    expect(b.packageKey).toBe("acceptance-run-beta");
    expect(a.packageKey).not.toBe(b.packageKey);
  });
});

describe("acceptance harness: no destructive SQL pattern appears in acceptance helpers", () => {
  it("db.mjs, fixtures.mjs and concurrency.mjs never contain TRUNCATE, DROP, or an unscoped DELETE", async () => {
    for (const file of ["db.mjs", "fixtures.mjs", "concurrency.mjs"]) {
      const raw = await readFile(
        new URL(`../scripts/acceptance/${file}`, import.meta.url),
        "utf8",
      );
      // Code only -- strips /** ... */ and // comments (which legitimately
      // discuss these SQL keywords in prose, e.g. "never issues TRUNCATE")
      // before scanning for the keywords actually appearing in executable
      // code/SQL.
      const code = raw
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n");
      expect(code.toUpperCase()).not.toMatch(/\bTRUNCATE\b/);
      expect(code.toUpperCase()).not.toMatch(
        /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/,
      );
      // Every DELETE in the code must carry a WHERE clause naming a
      // specific id/column -- a bare "delete from x" with nothing else on
      // the line (no "where") would be a broad, unscoped delete.
      const deleteLines = code
        .split("\n")
        .filter((line) => /\bdelete\s+from\b/i.test(line));
      for (const line of deleteLines) {
        expect(line.toLowerCase()).toContain("where");
      }
    }
  });
});
