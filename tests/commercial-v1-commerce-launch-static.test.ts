import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const adminForms = readFileSync(
  "src/components/commerce-offer-forms.tsx",
  "utf8",
);
const coursePage = readFileSync("src/app/courses/[slug]/page.tsx", "utf8");
const buyForm = readFileSync("src/components/buy-course-form.tsx", "utf8");
const migration = readFileSync(
  "supabase/migrations/202609180039_commercial_v1_campaign_redemption.sql",
  "utf8",
);

describe("PR24 launch UX static boundaries", () => {
  it("makes £29.99 GBP a transparent admin launch default, not a fabricated markdown", () => {
    expect(adminForms).toContain("defaultValue={2999}");
    expect(adminForms).toContain('defaultValue="GBP"');
    expect(adminForms).toContain("Security+ founding launch default");
    expect(coursePage).not.toMatch(/£249|was £|save \d+%|limited places/i);
  });

  it("exposes all three immutable delivery plans in administration and renders the database plan on the course page", () => {
    for (const plan of [
      "ACCELERATED_2_WEEK",
      "INTENSIVE_4_WEEK",
      "STANDARD_6_WEEK",
    ])
      expect(adminForms).toContain(plan);
    expect(coursePage).toContain(
      "DELIVERY_PLAN_DEFINITIONS[offer.deliveryPlan]",
    );
  });

  it("reserves free campaign creation for the explicit reviewer kind", () => {
    expect(adminForms).toContain('max={99}');
    expect(adminForms).toContain('name="fixedPriceAmountMinor"');
    expect(adminForms).toContain('min={1}');
    expect(adminForms).toContain("Reviewer complimentary");
  });

  it("requires a code when card commerce is unavailable but keeps it optional otherwise", () => {
    expect(buyForm).toContain("required={!paymentAvailable}");
    expect(buyForm).toContain("Apply complimentary code");
    expect(buyForm).toContain("Continue to secure checkout");
    expect(coursePage.replace(/\s+/g, " ")).toContain(
      "Only a valid complimentary reviewer code can grant access",
    );
  });

  it("never rewrites an existing order amount during campaign redemption", () => {
    expect(migration).not.toMatch(
      /update\s+public\.commercial_v1_orders\s+set\s+amount_minor/i,
    );
    expect(migration).toMatch(/amount_minor,currency,campaign_redemption_id/);
  });

  it("keeps reviewer complimentary access explicitly orderless", () => {
    expect(migration).toContain(
      "Reviewer complimentary access creates enrolment + entitlement directly.",
    );
    expect(migration).toMatch(
      /insert into public\.commercial_v1_entitlements\([\s\S]*?values\([\s\S]*?actor,o\.id,o\.activation_id,null,enrolment_id,'REVIEWER',redemption_id[\s\S]*?\)/,
    );
  });
});
