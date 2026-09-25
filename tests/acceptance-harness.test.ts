import { readFile } from "node:fs/promises";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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
      key.startsWith("NEXT_PUBLIC_SUPABASE_")
    )
      delete process.env[key];
  }
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
    expect(text).toContain(
      'import { seedAcceptanceCourse, seedAcceptanceAttempt } from "./fixtures.mjs"',
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
    // NEVER_TWO_REVISION_ONES (v5) reads the admitted row's real id via
    // `select id from ...` and checks `rows.length === 1`; the other
    // three still use `select count(*) as n` and `rows[0].n === 1` --
    // both are an equally valid "exactly one admitted row" check.
    const passConditions = text.match(
      /if \(\s*\n\s*fulfilled === 1 &&\s*\n\s*uniqueRejected === 1 &&\s*\n\s*otherRejections\.length === 0 &&\s*\n\s*(rows\[0\]\.n === 1|rows\.length === 1)\s*\n\s*\)/g,
    );
    expect(passConditions).not.toBeNull();
    // INITIAL_VS_INITIAL, RECOVERY_VS_RECOVERY, NEVER_TWO_REVISION_ONES,
    // COMPLETION_VS_COMPLETION -- all four races.
    expect(passConditions!.length).toBe(4);
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

describe("acceptance harness: NEVER_TWO_REVISION_ONES derives real max marks and completes/validates the admitted revision (independent-review findings 3 & B, v4/v5, BLOCKER)", () => {
  it("reads SUM(assessment_questions.max_marks) for the QUIZ_1 assessment instead of a literal 10, races full marks (actualMax/actualMax), and completes the admitted revision with real question marks before returning PASS or FAIL", async () => {
    const text = await readFile(
      new URL("../scripts/acceptance/concurrency.mjs", import.meta.url),
      "utf8",
    );
    const neverTwoStart = text.indexOf(
      "export async function scenarioNeverTwoRevisionOnes",
    );
    const completionStart = text.indexOf(
      "export async function scenarioCompletionVsCompletion",
    );
    const neverTwoFn = text.slice(neverTwoStart, completionStart);
    expect(neverTwoFn).toContain(
      "select coalesce(sum(max_marks),0)::int as total from assessment_questions where assessment_id=$1",
    );
    // v5: full marks (actualMax/actualMax), never 0/actualMax and never
    // the old hard-coded 5/10.
    expect(neverTwoFn).toContain("1,$6,$6,500)");
    expect(neverTwoFn).not.toContain("1,0,$6,500)");
    expect(neverTwoFn).not.toContain("1,5,10,500)");
    // v5, BLOCKER: whenever exactly one admitted revision exists, it is
    // completed (real question marks -> derive objective outcomes ->
    // assert validity) BEFORE the pass/fail decision -- never only on
    // the PASS path, and never left as permanent invalid history.
    expect(neverTwoFn).toContain("if (rows.length === 1) {");
    expect(neverTwoFn).toContain(
      "insert into commercial_v1_assessment_question_marks(",
    );
    expect(neverTwoFn).toContain(
      "commercial_v1_private.derive_and_insert_objective_outcomes($1)",
    );
    expect(neverTwoFn).toContain(
      "commercial_v1_private.assessment_result_is_valid($1) as valid",
    );
    const completionBlockIndex = neverTwoFn.indexOf(
      "insert into commercial_v1_assessment_question_marks(",
    );
    const passFailIndex = neverTwoFn.indexOf("if (\n      fulfilled === 1");
    expect(completionBlockIndex).toBeGreaterThan(-1);
    expect(passFailIndex).toBeGreaterThan(-1);
    expect(completionBlockIndex).toBeLessThan(passFailIndex);
  });
});

describe("acceptance harness: COMPLETION_VS_COMPLETION no longer duplicates NEVER_TWO_REVISION_ONES's result setup (independent-review finding C, v5)", () => {
  it("no longer inserts into commercial_v1_assessment_result_revisions or looks up actualMax -- only the raw commercial_v1_completion_receipts race remains", async () => {
    const text = await readFile(
      new URL("../scripts/acceptance/concurrency.mjs", import.meta.url),
      "utf8",
    );
    const completionStart = text.indexOf(
      "export async function scenarioCompletionVsCompletion",
    );
    const nextFnStart = text.indexOf(
      "\n// Independent-review finding 4:",
      completionStart,
    );
    const rawCompletionFn = text.slice(
      completionStart,
      nextFnStart === -1 ? undefined : nextFnStart,
    );
    // Strip line comments first -- this function's own explanatory
    // comment deliberately says "actualMax" in prose (explaining why the
    // lookup was removed), which would otherwise trip a naive substring
    // check on the comment text itself, not the actual code.
    const completionFn = rawCompletionFn
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(completionFn).not.toContain(
      "insert into commercial_v1_assessment_result_revisions(",
    );
    expect(completionFn).not.toContain(
      "select coalesce(sum(max_marks),0)::int as total from assessment_questions where assessment_id=$1",
    );
    expect(completionFn).not.toContain("actualMax");
    expect(completionFn).toContain(
      "insert into commercial_v1_completion_receipts(",
    );
    // The PASS description must stay explicitly bounded -- never implying
    // this proves governed course-completion eligibility.
    expect(completionFn).toContain(
      "bounded EXACTLY to the raw unique(enrolment_id) constraint",
    );
    expect(completionFn).toContain(
      "never proof that a real completion would actually be eligible",
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
          if (sql.includes("insert into cohorts(")) return { rows: [] };
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

describe("acceptance harness: hosted admin cannot write cohorts through PostgREST (independent-review finding 2, this pass, BLOCKER)", () => {
  it('seedAcceptanceCourse no longer calls .from("cohorts").insert(...) through the authenticated client', async () => {
    // Independent-review finding: migration 2609080001 revokes all
    // cohorts access from `authenticated`; migration 2609080003 grants
    // only SELECT with only a SELECT policy; no later migration through
    // 2609250042 grants INSERT. A real hosted ACCEPTANCE_ADMIN cannot
    // create a cohort via PostgREST.
    const raw = await readFile(
      new URL("../scripts/acceptance/fixtures.mjs", import.meta.url),
      "utf8",
    );
    // Strip block/line comments first -- the function's own JSDoc
    // deliberately documents the OLD, rejected `.from("cohorts")` shape as
    // prose explaining why it was removed, which would otherwise trip a
    // naive substring check on the comment text itself, not the code.
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toContain('.from("cohorts")');
    expect(code).not.toMatch(/from\("cohorts"\)\s*\.\s*insert/);
    expect(code).toMatch(/insert into cohorts\(/);
    expect(code).toContain("withAcceptanceWriteConnection(async (client) => {");
  });

  it("the cohort insert runs on a connection gated by withAcceptanceWriteConnection, after the Supabase same-environment gate already ran", async () => {
    const text = await readFile(
      new URL("../scripts/acceptance/fixtures.mjs", import.meta.url),
      "utf8",
    );
    const fnStart = text.indexOf("export async function seedAcceptanceCourse");
    const cohortInsertIndex = text.indexOf("insert into cohorts(", fnStart);
    const supabaseGateIndex = text.indexOf(
      "assertAcceptanceSupabaseWriteAuthorized(admin)",
      fnStart,
    );
    expect(cohortInsertIndex).toBeGreaterThan(-1);
    expect(supabaseGateIndex).toBeGreaterThan(-1);
    expect(supabaseGateIndex).toBeLessThan(cohortInsertIndex);
    // The cohort insert's own enclosing call must be
    // withAcceptanceWriteConnection, not a bare withConnection.
    const precedingCall = text.slice(
      cohortInsertIndex - 400,
      cohortInsertIndex,
    );
    expect(precedingCall).toContain("withAcceptanceWriteConnection(");
  });

  it("behaviourally: the cohort insert is issued only on a client the direct-database gate has already authorized", async () => {
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
          return { rows: [] };
        },
      };
    }
    vi.doMock("pg", () => ({ default: { Client: FakeClient } }));
    vi.resetModules();
    const { withAcceptanceWriteConnection } =
      await import("../scripts/acceptance/db.mjs");
    await withAcceptanceWriteConnection(
      (client: {
        query: (sql: string, params: unknown[]) => Promise<unknown>;
      }) =>
        client.query(
          "insert into cohorts(id, programme_version_id, title, starts_on) values($1,$2,$3,current_date)",
          ["cohort-1", "version-1", "Acceptance cohort test"],
        ),
    );
    vi.doUnmock("pg");
    vi.resetModules();
    expect(calls[0]).toContain("acceptance_marker");
    expect(calls[1]).toContain("insert into cohorts");
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

describe("acceptance harness: foreign-learner pair is a hard JWT_POSTGREST prerequisite (independent-review finding 3)", () => {
  it("BLOCKED when neither foreign credential is configured", async () => {
    clearAcceptanceVars();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "publishable-key";
    process.env.ACCEPTANCE_ADMIN_EMAIL = "admin@example.com";
    process.env.ACCEPTANCE_ADMIN_PASSWORD = "password";
    process.env.ACCEPTANCE_LEARNER_EMAIL = "learner@example.com";
    process.env.ACCEPTANCE_LEARNER_PASSWORD = "password";
    const surfaces = await import("../scripts/acceptance/surfaces.mjs");
    const result = await surfaces.checkJwtPostgrest();
    expect(result.status).toBe("BLOCKED");
    expect(result.reason.toLowerCase()).toContain("foreign-learner");
  });

  it("BLOCKED when only the foreign email is configured", async () => {
    clearAcceptanceVars();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "publishable-key";
    process.env.ACCEPTANCE_ADMIN_EMAIL = "admin@example.com";
    process.env.ACCEPTANCE_ADMIN_PASSWORD = "password";
    process.env.ACCEPTANCE_LEARNER_EMAIL = "learner@example.com";
    process.env.ACCEPTANCE_LEARNER_PASSWORD = "password";
    process.env.ACCEPTANCE_FOREIGN_LEARNER_EMAIL = "foreign@example.com";
    const surfaces = await import("../scripts/acceptance/surfaces.mjs");
    const result = await surfaces.checkJwtPostgrest();
    expect(result.status).toBe("BLOCKED");
  });

  it("BLOCKED when only the foreign password is configured", async () => {
    clearAcceptanceVars();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "publishable-key";
    process.env.ACCEPTANCE_ADMIN_EMAIL = "admin@example.com";
    process.env.ACCEPTANCE_ADMIN_PASSWORD = "password";
    process.env.ACCEPTANCE_LEARNER_EMAIL = "learner@example.com";
    process.env.ACCEPTANCE_LEARNER_PASSWORD = "password";
    process.env.ACCEPTANCE_FOREIGN_LEARNER_PASSWORD = "password";
    const surfaces = await import("../scripts/acceptance/surfaces.mjs");
    const result = await surfaces.checkJwtPostgrest();
    expect(result.status).toBe("BLOCKED");
  });

  it("foreignLearnerIdentityConfigured requires the complete pair", async () => {
    clearAcceptanceVars();
    const { foreignLearnerIdentityConfigured } =
      await import("../scripts/acceptance/supabase.mjs");
    expect(foreignLearnerIdentityConfigured()).toBe(false);
    process.env.ACCEPTANCE_FOREIGN_LEARNER_EMAIL = "foreign@example.com";
    expect(foreignLearnerIdentityConfigured()).toBe(false);
    process.env.ACCEPTANCE_FOREIGN_LEARNER_PASSWORD = "password";
    expect(foreignLearnerIdentityConfigured()).toBe(true);
  });

  it("checkJwtPostgrest's source always executes the foreign-learner isolation assertion once past its guards -- never conditionally skipped", async () => {
    const text = await readFile(
      new URL("../scripts/acceptance/surfaces.mjs", import.meta.url),
      "utf8",
    );
    // The prior conditional wrapper (`if (isConfigured("ACCEPTANCE_FOREIGN_LEARNER_EMAIL"))`)
    // around the isolation assertion must be gone.
    expect(text).not.toMatch(
      /if\s*\(\s*isConfigured\("ACCEPTANCE_FOREIGN_LEARNER_EMAIL"\)\s*\)\s*\{/,
    );
    expect(text).toContain("foreignLearnerIdentityConfigured()");
  });
});

describe("acceptance harness: checkJwtPostgrest RPC-error handling and non-vacuous isolation (independent-review findings 2 and 3, this pass)", () => {
  afterEach(() => {
    vi.doUnmock("../scripts/acceptance/supabase.mjs");
    vi.resetModules();
  });

  type RpcResult = { data: unknown; error: { message: string } | null };
  function client(rpc: (name: string) => RpcResult | Promise<RpcResult>) {
    return { rpc: async (name: string) => rpc(name) };
  }
  function ok(data: unknown): RpcResult {
    return { data, error: null };
  }
  function denied(): RpcResult {
    return { data: null, error: { message: "denied" } };
  }

  // A fully-passing baseline: anon denied; learner has one real, known
  // owned enrolment; learner denied the admin RPC; admin permitted; the
  // foreign learner's own list does not include the learner's enrolment.
  function mockSupabase({
    anonRpc = () => denied(),
    learnerFirstRpc = () => ok([{ id: "e1" }]),
    learnerAdminRpc = () => denied(),
    adminRpc = () => ok([{ id: "a1" }]),
    foreignRpc = () => ok([]),
    learnerSecondRpc,
  }: Partial<{
    anonRpc: () => RpcResult;
    learnerFirstRpc: () => RpcResult;
    learnerAdminRpc: () => RpcResult;
    adminRpc: () => RpcResult;
    foreignRpc: () => RpcResult;
    learnerSecondRpc: () => RpcResult;
  }> = {}) {
    let learnerCall = 0;
    const learnerClient = client((name) => {
      if (name === "list_commercial_v1_activations") return learnerAdminRpc();
      learnerCall += 1;
      if (learnerCall === 1) return learnerFirstRpc();
      return (learnerSecondRpc ?? learnerFirstRpc)();
    });
    vi.doMock("../scripts/acceptance/supabase.mjs", () => ({
      hostedSupabaseConfigured: () => true,
      acceptanceIdentitiesConfigured: () => true,
      foreignLearnerIdentityConfigured: () => true,
      anonClient: () => client(anonRpc),
      acceptanceIdentities: {
        admin: async () => client(adminRpc),
        learner: async () => learnerClient,
        foreignLearner: async () => client(foreignRpc),
      },
    }));
    vi.resetModules();
  }

  it("returns BLOCKED, never PASS, even when every core identity/role/isolation check succeeds", async () => {
    clearAcceptanceVars();
    mockSupabase();
    const { checkJwtPostgrest } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkJwtPostgrest();
    expect(result.status).toBe("BLOCKED");
    expect(result.status).not.toBe("PASS");
    expect(result.reason).toContain(
      "Core hosted identity/role/cross-learner-isolation sample passed",
    );
    expect(result.reason.toLowerCase()).toContain("expired/invalid jwt");
  });

  it("a foreign-learner enrolment-list RPC error is FAIL, never a silently-empty list that lets isolation appear to pass", async () => {
    clearAcceptanceVars();
    mockSupabase({ foreignRpc: () => denied() });
    const { checkJwtPostgrest } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkJwtPostgrest();
    expect(result.status).toBe("FAIL");
  });

  it("a second (re-fetch) learner enrolment-list RPC error is FAIL, never a silently-empty list", async () => {
    clearAcceptanceVars();
    mockSupabase({ learnerSecondRpc: () => denied() });
    const { checkJwtPostgrest } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkJwtPostgrest();
    expect(result.status).toBe("FAIL");
  });

  it("an empty primary-learner enrolment set is BLOCKED with a clear prerequisite, never a vacuous PASS", async () => {
    clearAcceptanceVars();
    mockSupabase({ learnerFirstRpc: () => ok([]) });
    const { checkJwtPostgrest } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkJwtPostgrest();
    expect(result.status).toBe("BLOCKED");
    expect(result.status).not.toBe("PASS");
    expect(result.reason.toLowerCase()).toContain("no owned enrolment");
  });

  it("a real cross-learner overlap is still FAIL, not masked by the new BLOCKED-on-success behaviour", async () => {
    clearAcceptanceVars();
    mockSupabase({ foreignRpc: () => ok([{ id: "e1" }]) });
    const { checkJwtPostgrest } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkJwtPostgrest();
    expect(result.status).toBe("FAIL");
  });

  it("surfaces.mjs's source checks the error on both the foreign-learner and second-learner RPC calls, never destructuring only `data`", async () => {
    const text = await readFile(
      new URL("../scripts/acceptance/surfaces.mjs", import.meta.url),
      "utf8",
    );
    expect(text).toContain("error: foreignListError");
    expect(text).toContain("if (foreignListError)");
    expect(text).toContain("error: learnerRecheckError");
    expect(text).toContain("if (learnerRecheckError)");
    expect(text).not.toContain(
      "const { data: foreignEnrolments } = await foreign.rpc(",
    );
  });

  it("checkJwtPostgrest never returns a PASS status at all -- the full documented contract is not yet implemented", async () => {
    const text = await readFile(
      new URL("../scripts/acceptance/surfaces.mjs", import.meta.url),
      "utf8",
    );
    const fnStart = text.indexOf("export async function checkJwtPostgrest()");
    const fnEnd = text.indexOf(
      "\n// ---",
      fnStart + "export async function checkJwtPostgrest()".length,
    );
    const fnText = text.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
    expect(fnText).not.toMatch(/return pass\(/);
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
  it("never opts in merely because provider credentials exist", async () => {
    clearAcceptanceVars();
    process.env.ACADEMIC_PROVIDER_BASE_URL = "https://provider.example.com";
    process.env.ACADEMIC_PROVIDER_API_KEY = "a-real-looking-key";
    const { liveProviderOptedIn } =
      await import("../scripts/acceptance/env.mjs");
    expect(liveProviderOptedIn()).toBe(false);
  });
  it("requires the opt-in flag to be exactly the string 'true'", async () => {
    clearAcceptanceVars();
    process.env.ACADEMIC_PROVIDER_BASE_URL = "https://provider.example.com";
    process.env.ACADEMIC_PROVIDER_API_KEY = "a-real-looking-key";
    process.env.ACCEPTANCE_LIVE_PROVIDER_OPT_IN = "yes";
    const { liveProviderOptedIn } =
      await import("../scripts/acceptance/env.mjs");
    expect(liveProviderOptedIn()).toBe(false);
    process.env.ACCEPTANCE_LIVE_PROVIDER_OPT_IN = "true";
    expect(liveProviderOptedIn()).toBe(true);
  });
  it("the LIVE_PROVIDER surface still refuses without operatorAuthorized, even fully opted in", async () => {
    clearAcceptanceVars();
    process.env.ACADEMIC_PROVIDER_BASE_URL = "https://provider.example.com";
    process.env.ACADEMIC_PROVIDER_API_KEY = "a-real-looking-key";
    process.env.ACCEPTANCE_LIVE_PROVIDER_OPT_IN = "true";
    const { checkLiveProvider } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkLiveProvider({ operatorAuthorized: false });
    expect(result.status).toBe("BLOCKED");
    expect(result.reason).toContain("EXPLICIT_AUTHORIZATION_REQUIRED");
  });
  it("still reports BLOCKED (never runs) without credentials, even with operatorAuthorized true", async () => {
    clearAcceptanceVars();
    const { checkLiveProvider } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkLiveProvider({ operatorAuthorized: true });
    expect(result.status).toBe("BLOCKED");
  });
});

describe("acceptance harness: Stripe test-mode surface refuses live-looking credentials", () => {
  it("BLOCKED, not FAIL or PASS, when the key looks live-mode", async () => {
    clearAcceptanceVars();
    process.env.STRIPE_SECRET_KEY = "sk_live_abcdef";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_abcdef";
    const { checkStripeTestMode } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkStripeTestMode();
    expect(result.status).toBe("BLOCKED");
    expect(result.reason.toLowerCase()).toContain("live");
  });
  it("BLOCKED when Stripe credentials are absent entirely", async () => {
    clearAcceptanceVars();
    const { checkStripeTestMode } =
      await import("../scripts/acceptance/surfaces.mjs");
    const result = await checkStripeTestMode();
    expect(result.status).toBe("BLOCKED");
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
  it("FULL_CUSTOMER_JOURNEY is BLOCKED when any prerequisite surface has not PASSed", async () => {
    clearAcceptanceVars();
    const surfaces = await import("../scripts/acceptance/surfaces.mjs");
    const result = await surfaces.checkFullCustomerJourney([
      { surface: "HOSTED_DATABASE", status: "BLOCKED", reason: "x" },
    ]);
    expect(result.status).toBe("BLOCKED");
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
