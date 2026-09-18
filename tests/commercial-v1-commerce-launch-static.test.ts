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
    expect(coursePage).toContain("DELIVERY_PLAN_DEFINITIONS[offer.deliveryPlan]");
  });

  it("requires a code when card commerce is unavailable but keeps it optional otherwise", () => {
    expect(buyForm).toContain("required={!paymentAvailable}");
    expect(buyForm).toContain("Apply complimentary code");
    expect(buyForm).toContain("Continue to secure checkout");
  });

  it("never rewrites an existing order amount during campaign redemption", () => {
    expect(migration).not.toMatch(
      /update\s+public\.commercial_v1_orders\s+set\s+amount_minor/i,
    );
    expect(migration).toMatch(
      /amount_minor,currency,campaign_redemption_id/,
    );
  });

  it("keeps zero-price access explicitly orderless", () => {
    expect(migration).toContain(
      "Complimentary/promo-zero access creates academic enrolment and",
    );
    expect(migration).toContain(
      "values(actor,o.id,o.activation_id,null,enrolment_id,source_kind,redemption_id)",
    );
  });
});
