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

describe("acceptance harness: every cleanup write connection is gated (independent-review finding 1, this pass)", () => {
  it("concurrency.mjs's cleanup() call site and both scenarioRecoveryVsRecovery post-race DELETEs use withAcceptanceWriteConnection, never bare withConnection", async () => {
    const text = await readFile(
      new URL("../scripts/acceptance/concurrency.mjs", import.meta.url),
      "utf8",
    );
    expect(text).not.toContain("withConnection((c) => cleanup(c, chain))");
    expect(text).toContain(
      "withAcceptanceWriteConnection((c) => cleanup(c, chain))",
    );
    expect(text).toContain(
      "delete from commercial_v1_examiner_recovery_executions where source_execution_id=$1",
    );
    expect(text).toContain(
      "delete from commercial_v1_examiner_executions where id=$1",
    );
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
