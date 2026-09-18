import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/202609180038_commercial_v1_launch_foundation.sql",
  "utf8",
);

describe("PR21 launch-foundation static safety proof", () => {
  it("does not introduce a learner redemption or automatic grant RPC", () => {
    expect(migration).not.toMatch(/create function public\.redeem_/i);
    expect(migration).not.toMatch(/create function public\.grant_/i);
  });

  it("keeps the three delivery-plan identities explicit", () => {
    for (const plan of [
      "ACCELERATED_2_WEEK",
      "INTENSIVE_4_WEEK",
      "STANDARD_6_WEEK",
    ]) {
      expect(migration).toContain(plan);
    }
  });

  it("keeps campaign and redemption tables behind RLS with no direct grants", () => {
    expect(migration).toMatch(
      /alter table public\.commercial_v1_campaigns enable row level security/i,
    );
    expect(migration).toMatch(
      /revoke all on public\.commercial_v1_campaigns from public,anon,authenticated,service_role/i,
    );
    expect(migration).toMatch(
      /alter table public\.commercial_v1_campaign_redemptions enable row level security/i,
    );
    expect(migration).toMatch(
      /revoke all on public\.commercial_v1_campaign_redemptions from public,anon,authenticated,service_role/i,
    );
  });

  it("never represents free reviewer access as a fake paid order", () => {
    expect(migration).toMatch(
      /source in \('PAID_ORDER','PROMOTIONAL','REVIEWER'\)/,
    );
    expect(migration).toMatch(
      /source='PAID_ORDER' and order_id is not null and campaign_redemption_id is null/,
    );
    expect(migration).toMatch(
      /source in \('PROMOTIONAL','REVIEWER'\) and order_id is null and campaign_redemption_id is not null/,
    );
  });
});
