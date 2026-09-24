import { readFile } from "node:fs/promises";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

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
