import { describe, expect, it } from "vitest";
import {
  COMMERCIAL_V1_LAUNCH_POLICY,
  DELIVERY_PLAN_DEFINITIONS,
  archiveCommercialV1CampaignInputSchema,
  calculateCampaignPrice,
  campaignCodeSchema,
  commercialV1EntitlementSourceSchema,
  createCommercialV1CampaignInputSchema,
  deliveryPlanSchema,
} from "@/domain/commercial-v1-launch";

describe("Commercial V1 launch foundation domain", () => {
  it("fixes the launch policy and exactly three delivery plans", () => {
    expect(COMMERCIAL_V1_LAUNCH_POLICY).toBe("COMMERCIAL_V1_LAUNCH_V1");
    expect(deliveryPlanSchema.options).toEqual([
      "ACCELERATED_2_WEEK",
      "INTENSIVE_4_WEEK",
      "STANDARD_6_WEEK",
    ]);
    expect(DELIVERY_PLAN_DEFINITIONS.ACCELERATED_2_WEEK.durationDays).toBe(14);
    expect(DELIVERY_PLAN_DEFINITIONS.INTENSIVE_4_WEEK.durationDays).toBe(28);
    expect(DELIVERY_PLAN_DEFINITIONS.STANDARD_6_WEEK.durationDays).toBe(42);
  });

  it("normalises campaign codes to uppercase and rejects unsafe shapes", () => {
    expect(campaignCodeSchema.parse(" reviewer-50 ")).toBe("REVIEWER-50");
    for (const bad of [
      "abc",
      "-ABCD",
      "ABCD-",
      "AB--CD",
      "AB CD",
      "AB_CD",
      "",
    ]) {
      expect(campaignCodeSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("calculates percent pricing entirely in integer minor units", () => {
    // £29.99 less 15%: floor(2999*15/100)=449p discount => £25.50.
    expect(
      calculateCampaignPrice(2999, { kind: "PERCENT_OFF", percentOff: 15 }),
    ).toBe(2550);
    expect(
      calculateCampaignPrice(2999, { kind: "PERCENT_OFF", percentOff: 100 }),
    ).toBe(0);
  });

  it("allows a lower fixed campaign price but never a price increase", () => {
    expect(
      calculateCampaignPrice(2999, {
        kind: "FIXED_PRICE",
        fixedPriceAmountMinor: 1999,
      }),
    ).toBe(1999);
    expect(() =>
      calculateCampaignPrice(2999, {
        kind: "FIXED_PRICE",
        fixedPriceAmountMinor: 3000,
      }),
    ).toThrow(/cannot increase/i);
  });

  it("makes reviewer complimentary pricing exactly zero", () => {
    expect(
      calculateCampaignPrice(2999, { kind: "REVIEWER_COMPLIMENTARY" }),
    ).toBe(0);
  });

  it("requires bounded campaign windows and rejects contradictory fields", () => {
    const base = {
      offerSlug: "security-plus-sy0-701",
      code: "FOUNDING-50",
      maxRedemptions: 50,
      startsAt: "2026-09-20T00:00:00Z",
      endsAt: "2026-10-20T00:00:00Z",
      reason: "Founding launch pricing",
    };

    expect(
      createCommercialV1CampaignInputSchema.safeParse({
        ...base,
        kind: "PERCENT_OFF",
        percentOff: 50,
      }).success,
    ).toBe(true);

    expect(
      createCommercialV1CampaignInputSchema.safeParse({
        ...base,
        kind: "REVIEWER_COMPLIMENTARY",
        percentOff: 100,
      }).success,
    ).toBe(false);

    expect(
      createCommercialV1CampaignInputSchema.safeParse({
        ...base,
        kind: "FIXED_PRICE",
        fixedPriceAmountMinor: 2999,
        endsAt: base.startsAt,
      }).success,
    ).toBe(false);
  });

  it("keeps entitlement provenance vocabulary explicit", () => {
    expect(commercialV1EntitlementSourceSchema.options).toEqual([
      "PAID_ORDER",
      "PROMOTIONAL",
      "REVIEWER",
    ]);
    expect(
      archiveCommercialV1CampaignInputSchema.safeParse({
        code: "reviewer-50",
        reason: "Campaign completed",
      }).success,
    ).toBe(true);
  });
});
