import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveRuntimeProfile } from "@/server/academic-runtime/profile-registry";

// Hosted incident 2026-10-28: a Professor execution received a complete
// OpenAI answer after 10.6 s, but its FINALIZE reached the database 10.7 s
// later and arrived 3 s after the 20 s execution lease had expired
// (TIMEOUT / EXECUTION_TIMEOUT). Between the provider call and FINALIZE the
// governed flow makes ~45 sequential Supabase requests (principal and
// firewall rechecks, nested release closes, attestation), and Vercel ran
// them from iad1 (US East) against a Supabase project in eu-west-2
// (London). Functions are pinned next to the database instead of loosening
// any lease, deadline, recheck or ceiling.
const vercel = JSON.parse(readFileSync("vercel.json", "utf8")) as {
  regions?: string[];
};

describe("deployment region stays beside the eu-west-2 database", () => {
  it("runs every function in London only", () => {
    expect(vercel.regions).toEqual(["lhr1"]);
  });

  it("does not trade the latency fix for looser execution timing", () => {
    // Database lease (migration 025 and later): expires_at <= created_at +
    // 20 s, also capped by the content release's own expiry.
    const lease = readFileSync(
      "supabase/migrations/202609130025_commercial_v1_live_professor_execution.sql",
      "utf8",
    );
    expect(lease).toContain(
      "check(expires_at>created_at and expires_at<=created_at+interval '20 seconds')",
    );
    expect(lease).toContain(
      "deadline := least(stamp+interval '20 seconds',release_record.expires_at);",
    );
    // The provider deadline is unchanged and inside the lease.
    const professor = resolveRuntimeProfile("PROFESSOR_COMMERCIAL_V1");
    expect(professor?.budgetPolicy.totalDeadlineMs).toBe(15_000);
    expect(professor?.budgetPolicy.maxAttempts).toBe(1);
  });
});
