import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  examEnginePrerequisites,
  assertExamEngineSchedulePlan,
  classifyExamEngineSetupFailure,
  migration059Applied,
  runExamEngineAcceptance,
  SURFACES,
} from "../scripts/acceptance/exam-engine.mjs";

// LOCAL verification of the CP2 hosted exam-engine driver's gates: with any
// prerequisite unmet, nothing signs in, seeds or writes, and every surface is
// BLOCKED -- never PASS. (The hosted journey itself is NOT exercised here.)

const CHROME = process.execPath; // any existing executable path
const OUTSIDE = join(tmpdir(), "cp2-evidence-outside-repo");
const READY_ENV: Record<string, string> = {
  ACCEPTANCE_DATABASE_URL:
    "postgres://postgres.example:secret@127.0.0.1:5432/postgres",
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
    "sb_publishable_example_example_example",
  ACCEPTANCE_ADMIN_EMAIL: "admin@example.test",
  ACCEPTANCE_ADMIN_PASSWORD: "example-password",
  ACCEPTANCE_LEARNER_EMAIL: "learner@example.test",
  ACCEPTANCE_LEARNER_PASSWORD: "example-password",
  ACCEPTANCE_FOREIGN_LEARNER_EMAIL: "foreign@example.test",
  ACCEPTANCE_FOREIGN_LEARNER_PASSWORD: "example-password",
  ACCEPTANCE_UNRELATED_STAFF_EMAIL: "staff@example.test",
  ACCEPTANCE_UNRELATED_STAFF_PASSWORD: "example-password",
  ACCEPTANCE_ENVIRONMENT_ID: "a0000000-0000-4000-8000-000000000001",
  ACCEPTANCE_WRITE_ENABLED: "true",
  ACADEMIC_EXECUTION_KEY_ID: "b0000000-0000-4000-8000-000000000001",
  ACADEMIC_EXECUTION_HMAC_KEY_HEX: "ab".repeat(32),
};
function stubEnv(env: Record<string, string>) {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
}
afterEach(() => vi.unstubAllEnvs());

describe("CP2 exam-engine driver gates (local, no hosted calls)", () => {
  it("with nothing configured every surface is BLOCKED and no session or migration check is attempted", async () => {
    for (const k of Object.keys(READY_ENV)) vi.stubEnv(k, "");
    const openSession = vi.fn();
    const checkMigration = vi.fn();
    const { results } = await runExamEngineAcceptance({
      chromePath: CHROME,
      evidenceDir: OUTSIDE,
      openSession,
      checkMigration,
    });
    expect(
      results.map(
        (r: { status: string; surface: string; reason: string }) => r.surface,
      ),
    ).toEqual([...SURFACES]);
    expect(
      results.every(
        (r: { status: string; surface: string; reason: string }) =>
          r.status === "BLOCKED",
      ),
    ).toBe(true);
    expect(openSession).not.toHaveBeenCalled();
    expect(checkMigration).not.toHaveBeenCalled();
  });

  it("refuses an evidence directory inside the repository and a missing Chrome", () => {
    stubEnv(READY_ENV);
    expect(
      examEnginePrerequisites(process.env, {
        chromePath: CHROME,
        evidenceDir: "work/evidence",
      }),
    ).toContain("--evidence must be outside this repository.");
    expect(
      examEnginePrerequisites(process.env, {
        chromePath: join(tmpdir(), "no-such-chrome.exe"),
        evidenceDir: OUTSIDE,
      }),
    ).toContain("--chrome must name an installed Chrome executable.");
    expect(
      examEnginePrerequisites(process.env, {
        chromePath: CHROME,
        evidenceDir: OUTSIDE,
      }),
    ).toEqual([]);
  });

  it("without ACCEPTANCE_WRITE_ENABLED=true nothing is opened", async () => {
    stubEnv({ ...READY_ENV, ACCEPTANCE_WRITE_ENABLED: "yes" });
    const openSession = vi.fn();
    const { results } = await runExamEngineAcceptance({
      chromePath: CHROME,
      evidenceDir: OUTSIDE,
      openSession,
      checkMigration: vi.fn(async () => true),
    });
    expect(
      results.every(
        (r: { status: string; surface: string; reason: string }) =>
          r.status === "BLOCKED",
      ),
    ).toBe(true);
    expect(openSession).not.toHaveBeenCalled();
  });

  it("refuses to sign in or seed when migration 059 is not applied (or the check fails)", async () => {
    stubEnv(READY_ENV);
    for (const [checkMigration, reason] of [
      [vi.fn(async () => false), /^Migration 059 is not applied/],
      [
        vi.fn(async () => {
          throw new Error("connection refused");
        }),
        /^The read-only migration check failed/,
      ],
    ] as const) {
      const openSession = vi.fn();
      const { results } = await runExamEngineAcceptance({
        chromePath: CHROME,
        evidenceDir: OUTSIDE,
        openSession,
        checkMigration,
      });
      expect(
        results.every(
          (r: { status: string; surface: string; reason: string }) =>
            r.status === "BLOCKED",
        ),
      ).toBe(true);
      expect(results[0].reason).toMatch(reason);
      expect(checkMigration).toHaveBeenCalledTimes(1);
      expect(openSession).not.toHaveBeenCalled();
    }
  });

  it("a refused app session (e.g. sign-in or controller key) blocks every surface", async () => {
    stubEnv(READY_ENV);
    const close = vi.fn();
    const { results } = await runExamEngineAcceptance({
      chromePath: CHROME,
      evidenceDir: OUTSIDE,
      checkMigration: vi.fn(async () => true),
      openSession: vi.fn(async () => ({
        refusal: {
          reason: "No active hosted controller key matches.",
          details: [],
        },
        close,
      })),
    });
    expect(
      results.every(
        (r: { status: string; surface: string; reason: string }) =>
          r.status === "BLOCKED",
      ),
    ).toBe(true);
    expect(results[0].reason).toBe("No active hosted controller key matches.");
  });

  it("the migration check requires both the ledger row and the schema", async () => {
    const q = (row: Record<string, boolean>) => async () => [row];
    expect(await migration059Applied(q({ ledger: true, schema: true }))).toBe(
      true,
    );
    expect(await migration059Applied(q({ ledger: true, schema: false }))).toBe(
      false,
    );
    expect(await migration059Applied(q({ ledger: false, schema: true }))).toBe(
      false,
    );
  });
  it("rejects any overlong assessment template before an Auth session or hosted lookup", async () => {
    stubEnv(READY_ENV);
    expect(assertExamEngineSchedulePlan()).toBe(true);
    const openSession = vi.fn();
    const checkMigration = vi.fn();
    const { results } = await runExamEngineAcceptance({
      chromePath: CHROME,
      evidenceDir: OUTSIDE,
      openSession,
      checkMigration,
      checkSchedule: () => {
        throw new Error("EXAM_ENGINE_SCHEDULE_INVALID");
      },
    });
    expect(results).toHaveLength(11);
    expect(
      results.every(
        (result: { status: string }) => result.status === "BLOCKED",
      ),
    ).toBe(true);
    expect(results[0].reason).toContain("nothing was written");
    expect(openSession).not.toHaveBeenCalled();
    expect(checkMigration).not.toHaveBeenCalled();
  });

  it("reports fixture RPC failure by allowlisted operation only", () => {
    const diagnostic = classifyExamEngineSetupFailure(
      new Error(
        "publish_commercial_v1_grading_policy failed: sensitive-token-123",
      ),
    );
    expect(diagnostic).toBe("RPC_REFUSED:publish_commercial_v1_grading_policy");
    expect(diagnostic).not.toContain("sensitive-token");
    expect(
      classifyExamEngineSetupFailure(new Error("arbitrary private detail")),
    ).toBe("SETUP_EXCEPTION");
  });
});
