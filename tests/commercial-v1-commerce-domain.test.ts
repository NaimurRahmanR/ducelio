import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COMMERCIAL_V1_COMMERCE_POLICY,
  currencyCodeSchema,
  offerSlugSchema,
  commercialV1OfferSchema,
  commercialV1OfferResultSchema,
  commercialV1CampaignPreviewSchema,
  commercialV1CampaignRedemptionSchema,
  commercialV1CampaignAdminSchema,
  publishCommercialV1OfferInputSchema,
  archiveCommercialV1OfferInputSchema,
  createCommercialV1OrderResultSchema,
  commercialV1OrderProjectionSchema,
  fulfillCommercialV1OrderResultSchema,
  reconcileCommercialV1OrderResultSchema,
  viewerEnrolmentStatusSchema,
  verifiedCheckoutSchema,
} from "@/domain/commercial-v1-commerce";

const activationId = "aaaaaaaa-0000-4000-8000-000000000001";
const orderId = "bbbbbbbb-0000-4000-8000-000000000001";
const entitlementId = "cccccccc-0000-4000-8000-000000000001";
const enrolmentId = "dddddddd-0000-4000-8000-000000000001";

describe("Policy identity", () => {
  it("is the fixed COMMERCIAL_V1_COMMERCE_V1 string", () => {
    expect(COMMERCIAL_V1_COMMERCE_POLICY).toBe("COMMERCIAL_V1_COMMERCE_V1");
  });
});

describe("Currency and slug primitives", () => {
  it("normalises a lowercase currency to uppercase and rejects a non-3-letter code", () => {
    expect(currencyCodeSchema.parse("gbp")).toBe("GBP");
    expect(currencyCodeSchema.safeParse("GB").success).toBe(false);
    expect(currencyCodeSchema.safeParse("GBPX").success).toBe(false);
    expect(currencyCodeSchema.safeParse("123").success).toBe(false);
  });
  it("only accepts a bounded lowercase-hyphen slug shape", () => {
    expect(offerSlugSchema.safeParse("cybersecurity-foundations").success).toBe(
      true,
    );
    for (const bad of ["ab", "-abc", "abc-", "abc--def", "a b", "a_b", ""]) {
      expect(offerSlugSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("Public offer projection contract", () => {
  const base = {
    ok: true as const,
    slug: "cybersecurity-foundations",
    title: "Cybersecurity Foundations",
    examinationBody: "ISC2",
    qualificationName: "Certified in Cybersecurity",
    priceAmountMinor: 19900,
    currency: "GBP",
    summary: "A hands-on introduction.",
    cohortStartsOn: "2026-09-01",
    viewerAuthenticated: false,
    viewerEntitled: false,
    viewerEnrolmentId: null,
    viewerEnrolmentStatus: "NONE" as const,
  };
  it("accepts the bounded public-safe shape and defaults historical projections to the 6-week plan", () => {
    const parsed = commercialV1OfferSchema.parse(base);
    expect(parsed.deliveryPlan).toBe("STANDARD_6_WEEK");
  });
  it("V2 correction (item 4): viewerEnrolmentStatus only accepts the four real academic statuses plus NONE", () => {
    expect(viewerEnrolmentStatusSchema.options).toEqual([
      "NONE",
      "ACTIVE",
      "PAUSED",
      "COMPLETED",
      "WITHDRAWN",
    ]);
    expect(
      commercialV1OfferSchema.safeParse({
        ...base,
        viewerEnrolmentStatus: "SOMETHING_MADE_UP",
      }).success,
    ).toBe(false);
  });
  it("rejects protected/unexpected fields -- no answer key, marking guidance, agent config or internal identifiers", () => {
    for (const extra of [
      { expectedAnswer: "leak" },
      { markingGuidance: "leak" },
      { agentConfiguration: {} },
      { activationId },
      { offerId: activationId },
      { createdBy: activationId },
    ]) {
      expect(
        commercialV1OfferSchema.safeParse({ ...base, ...extra }).success,
      ).toBe(false);
    }
  });
  it("the result union also accepts a bounded not-found denial", () => {
    expect(
      commercialV1OfferResultSchema.safeParse({ ok: false, code: "NOT_FOUND" })
        .success,
    ).toBe(true);
    expect(
      commercialV1OfferResultSchema.safeParse({ ok: false, code: "OTHER" })
        .success,
    ).toBe(false);
  });
});

describe("Publish/archive offer input contracts", () => {
  it("publish requires activationId/slug/price/currency/reason -- rejects a caller-supplied offer id or viewer state", () => {
    const base = {
      activationId,
      slug: "cybersecurity-foundations",
      priceAmountMinor: 19900,
      currency: "GBP",
      reason: "Publish the first cohort",
    };
    expect(publishCommercialV1OfferInputSchema.safeParse(base).success).toBe(
      true,
    );
    for (const extra of [
      { offerId: activationId },
      { viewerEntitled: true },
      { publishedAt: "2026-01-01T00:00:00Z" },
    ]) {
      expect(
        publishCommercialV1OfferInputSchema.safeParse({ ...base, ...extra })
          .success,
      ).toBe(false);
    }
  });
  it("accepts only one of the three reviewed immutable delivery plans", () => {
    const base = {
      activationId,
      slug: "security-plus-sy0-701",
      priceAmountMinor: 2999,
      currency: "GBP",
      reason: "Publish founding cohort",
    };
    expect(
      publishCommercialV1OfferInputSchema.parse(base).deliveryPlan,
    ).toBe("STANDARD_6_WEEK");
    expect(
      publishCommercialV1OfferInputSchema.safeParse({
        ...base,
        deliveryPlan: "INTENSIVE_4_WEEK",
      }).success,
    ).toBe(true);
    expect(
      publishCommercialV1OfferInputSchema.safeParse({
        ...base,
        deliveryPlan: "UNBOUNDED",
      }).success,
    ).toBe(false);
  });

  it("archive is SLUG-based (V2 correction, item 10) -- not an internal offer id", () => {
    expect(
      archiveCommercialV1OfferInputSchema.safeParse({
        slug: "cybersecurity-foundations",
        reason: "Re-pricing for the next cohort",
      }).success,
    ).toBe(true);
    expect(
      archiveCommercialV1OfferInputSchema.safeParse({
        offerId: activationId,
        reason: "Re-pricing for the next cohort",
      }).success,
    ).toBe(false);
  });
});

describe("PR24 campaign purchase contracts", () => {
  it("accepts bounded preview, paid-checkout and direct-access shapes", () => {
    expect(
      commercialV1CampaignPreviewSchema.safeParse({
        ok: true,
        effectivePriceAmountMinor: 2400,
        currency: "gbp",
        kind: "PERCENT_OFF",
        reused: false,
      }).success,
    ).toBe(true);
    expect(
      commercialV1CampaignRedemptionSchema.safeParse({
        ok: true,
        path: "PAID_CHECKOUT",
        reused: false,
        orderId,
        offerSlug: "security-plus-sy0-701",
        activationId,
        effectivePriceAmountMinor: 2400,
        currency: "GBP",
      }).success,
    ).toBe(true);
    expect(
      commercialV1CampaignRedemptionSchema.safeParse({
        ok: true,
        path: "ACCESS_GRANTED",
        reused: false,
        offerSlug: "security-plus-sy0-701",
        activationId,
        effectivePriceAmountMinor: 0,
        currency: "GBP",
        entitlementId,
        enrolmentId,
      }).success,
    ).toBe(true);
  });

  it("rejects invented campaign denial codes and negative prices", () => {
    expect(
      commercialV1CampaignPreviewSchema.safeParse({
        ok: false,
        code: "FREE_FOR_EVERYONE",
      }).success,
    ).toBe(false);
    expect(
      commercialV1CampaignPreviewSchema.safeParse({
        ok: true,
        effectivePriceAmountMinor: -1,
        currency: "GBP",
        kind: "FIXED_PRICE",
        reused: false,
      }).success,
    ).toBe(false);
  });

  it("parses the bounded admin campaign summary only", () => {
    expect(
      commercialV1CampaignAdminSchema.safeParse({
        code: "FOUNDING-20",
        offerSlug: "security-plus-sy0-701",
        kind: "PERCENT_OFF",
        effectivePriceAmountMinor: 2400,
        currency: "GBP",
        maxRedemptions: 50,
        redemptionCount: 4,
        startsAt: "2026-09-20T00:00:00Z",
        endsAt: "2026-10-20T00:00:00Z",
        state: "ACTIVE",
      }).success,
    ).toBe(true);
  });
});

describe("Order creation result contract", () => {
  it("V2 correction (item 4): accepts the ALREADY_ENROLLED / ENROLMENT_REQUIRES_SUPPORT denial codes derived from the canonical enrolments table", () => {
    for (const code of ["ALREADY_ENROLLED", "ENROLMENT_REQUIRES_SUPPORT"]) {
      expect(
        createCommercialV1OrderResultSchema.safeParse({ ok: false, code })
          .success,
      ).toBe(true);
    }
  });
  it("rejects a caller-supplied amount/currency/entitlement", () => {
    const base = {
      ok: true,
      orderId,
      amountMinor: 19900,
      currency: "GBP",
      offerSlug: "cybersecurity-foundations",
      activationId,
      reused: false,
    };
    expect(createCommercialV1OrderResultSchema.safeParse(base).success).toBe(
      true,
    );
    expect(
      createCommercialV1OrderResultSchema.safeParse({
        ...base,
        entitlementId,
      }).success,
    ).toBe(false);
  });
});

describe("Order projection contract", () => {
  it("accepts the bounded self-or-admin order shape", () => {
    expect(
      commercialV1OrderProjectionSchema.safeParse({
        ok: true,
        order: {
          id: orderId,
          state: "PENDING",
          offerSlug: "cybersecurity-foundations",
          activationId,
          amountMinor: 19900,
          currency: "GBP",
          fulfilledAt: null,
        },
      }).success,
    ).toBe(true);
  });
});

describe("Fulfillment result contract", () => {
  it("a fulfilled result always requires entitlementId/enrolmentId (V2 correction, item 11 -- never nullable)", () => {
    expect(
      fulfillCommercialV1OrderResultSchema.safeParse({
        ok: true,
        fulfilled: true,
        replay: false,
        orderId,
        entitlementId,
        enrolmentId,
        activationId,
      }).success,
    ).toBe(true);
    expect(
      fulfillCommercialV1OrderResultSchema.safeParse({
        ok: true,
        fulfilled: true,
        replay: true,
        orderId,
        entitlementId: null,
        enrolmentId: null,
        activationId,
      }).success,
    ).toBe(false);
  });
  it("accepts a bounded NOT_PAID non-fulfilled result and a bounded denial", () => {
    expect(
      fulfillCommercialV1OrderResultSchema.safeParse({
        ok: true,
        fulfilled: false,
        code: "NOT_PAID",
        orderId,
      }).success,
    ).toBe(true);
    expect(
      fulfillCommercialV1OrderResultSchema.safeParse({
        ok: false,
        code: "MISMATCHED_AMOUNT",
      }).success,
    ).toBe(true);
    expect(
      fulfillCommercialV1OrderResultSchema.safeParse({
        ok: false,
        code: "MADE_UP",
      }).success,
    ).toBe(false);
  });
});

describe("Reconciliation result contract (V2 correction, items 3 & 6)", () => {
  it("accepts fulfilled/not-paid/denied shapes including the new INCOMPLETE_EVIDENCE code", () => {
    expect(
      reconcileCommercialV1OrderResultSchema.safeParse({
        ok: true,
        fulfilled: true,
        replay: false,
        orderId,
      }).success,
    ).toBe(true);
    expect(
      reconcileCommercialV1OrderResultSchema.safeParse({
        ok: true,
        fulfilled: false,
        code: "NOT_PAID",
        orderId,
      }).success,
    ).toBe(true);
    expect(
      reconcileCommercialV1OrderResultSchema.safeParse({
        ok: false,
        code: "INCOMPLETE_EVIDENCE",
      }).success,
    ).toBe(true);
  });
});

describe("Verified checkout shape", () => {
  it("is bounded and provider-neutral beyond a literal STRIPE tag", () => {
    expect(
      verifiedCheckoutSchema.safeParse({
        provider: "STRIPE",
        sessionId: "cs_test_123",
        eventId: "evt_test_123",
        orderId,
        amountMinor: 19900,
        currency: "gbp",
        status: "PAID",
      }).success,
    ).toBe(true);
    expect(
      verifiedCheckoutSchema.safeParse({
        provider: "PAYPAL",
        sessionId: "x",
        eventId: "y",
        orderId,
        amountMinor: 1,
        currency: "GBP",
        status: "PAID",
      }).success,
    ).toBe(false);
  });
});

describe("Static-source proofs (migration 034 + Stripe adapter)", () => {
  const migration = readFileSync(
    "supabase/migrations/202609160034_commercial_v1_commerce_onboarding.sql",
    "utf8",
  );
  const stripeProvider = readFileSync(
    "src/server/commercial-v1-commerce/stripe-provider.ts",
    "utf8",
  );

  it("no protected content column exists on the offer/order/entitlement tables (answer keys, marking guidance, card data)", () => {
    expect(migration).not.toMatch(
      /expected_answer|marking_guidance|card_number|cvv|raw_body|signature text/i,
    );
  });

  it("create_enrolment itself is never redefined or weakened -- fulfillment reproduces its checks inline instead", () => {
    expect(migration).not.toMatch(
      /create (or replace )?function public\.create_enrolment/,
    );
    expect(migration).toMatch(/on conflict\(student_id,cohort_id\) do nothing/);
  });

  it("fulfill_commercial_v1_order is granted to both anon and authenticated (webhook has no session; success-page fallback does)", () => {
    const grants = [
      ...migration.matchAll(
        /grant execute on function (public\.\w+)\([^)]*\)\s+to\s+([a-z,]+)/g,
      ),
    ];
    const fulfill = grants.find(
      (g) => g[1] === "public.fulfill_commercial_v1_order",
    );
    expect(fulfill?.[2]).toBe("anon,authenticated");
  });

  it("V2 correction (item 5): fulfillment only ever accepts a strictly ACTIVE existing enrolment status", () => {
    expect(migration).toMatch(/enrolment_status<>'ACTIVE'/);
    expect(migration).not.toMatch(
      /enrolment_status not in \('ACTIVE','PAUSED','COMPLETED'\)/,
    );
  });

  it("V2 correction (item 4): order creation checks the canonical enrolments table, independent of commerce entitlement", () => {
    expect(migration).toMatch(
      /select status into enrolment_status from public\.enrolments where student_id=actor and cohort_id=a_cohort/,
    );
    expect(migration).toMatch(/'ALREADY_ENROLLED'/);
    expect(migration).toMatch(/'ENROLMENT_REQUIRES_SUPPORT'/);
  });

  it("V2 correction (item 1): attach_commercial_v1_checkout_session reports the existing bound session id on mismatch", () => {
    expect(migration).toMatch(/'existingSessionId',o\.provider_session_id/);
  });

  it("V2 correction (item 7): the Stripe adapter pins payment_method_types to card only", () => {
    expect(stripeProvider).toMatch(/payment_method_types:\s*\["card"\]/);
  });

  it("V2 correction (item 1): checkout creation is called with a deterministic per-order Stripe idempotency key", () => {
    expect(stripeProvider).toMatch(/idempotencyKey/);
    const server = readFileSync(
      "src/server/commercial-v1-commerce/index.ts",
      "utf8",
    );
    expect(server).toMatch(/DUCELIO_COMMERCIAL_V1_ORDER:.*order\.orderId/);
  });

  it("no arbitrary snapshot/order writer is exposed to authenticated beyond the governed RPCs", () => {
    const grants = [
      ...migration.matchAll(
        /grant execute on function (public\.\w+)\([^)]*\)\s+to\s+[a-z,]+/g,
      ),
    ].map((m) => m[1]);
    expect(new Set(grants)).toEqual(
      new Set([
        "public.list_commercial_v1_offers",
        "public.get_commercial_v1_offer",
        "public.publish_commercial_v1_offer",
        "public.archive_commercial_v1_offer",
        "public.list_commercial_v1_offer_activations",
        "public.create_commercial_v1_order",
        "public.attach_commercial_v1_checkout_session",
        "public.get_commercial_v1_order",
        "public.fulfill_commercial_v1_order",
      ]),
    );
  });
});
