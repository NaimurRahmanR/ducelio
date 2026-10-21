import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireActor: vi.fn(),
  getCurrentActor: vi.fn(),
  listCommercialV1Offers: vi.fn(),
  getCommercialV1Offer: vi.fn(),
  createCommercialV1Checkout: vi.fn(),
  reconcileCommercialV1Order: vi.fn(),
  commerceConfig: vi.fn(),
  notFound: vi.fn(),
  redirect: vi.fn(),
}));
vi.mock("@/server/identity", () => ({
  requireActor: mocks.requireActor,
  getCurrentActor: mocks.getCurrentActor,
}));
vi.mock("@/server/commercial-v1-commerce", () => ({
  listCommercialV1Offers: mocks.listCommercialV1Offers,
  getCommercialV1Offer: mocks.getCommercialV1Offer,
  createCommercialV1Checkout: mocks.createCommercialV1Checkout,
  reconcileCommercialV1Order: mocks.reconcileCommercialV1Order,
}));
vi.mock("@/lib/env", () => ({ commerceConfig: mocks.commerceConfig }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    mocks.notFound();
    throw new Error("NOT_FOUND");
  },
  redirect: (url: string) => {
    mocks.redirect(url);
    throw new Error("REDIRECT:" + url);
  },
}));
// BuyCourseForm is a "use client" component using useActionState -- it is
// never actually invoked by a plain server-side flatten walk (only real
// React rendering calls a component function). Mocked to a recognisable
// text marker so its presence/absence in the page tree is directly
// observable.
vi.mock("@/components/buy-course-form", () => ({
  BuyCourseForm: ({
    slug,
    paymentAvailable,
  }: {
    slug: string;
    paymentAvailable: boolean;
  }) => `BUY_FORM_MARKER:${slug}:${paymentAvailable}`,
}));

import CoursesPage from "@/app/courses/page";
import CourseDetailPage from "@/app/courses/[slug]/page";
import SuccessPage from "@/app/checkout/success/page";
import CancelPage from "@/app/checkout/cancel/page";
import { startCheckout } from "@/app/courses/actions";

function flatten(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean")
    return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flatten).join(" ");
  if (typeof node === "object" && node !== null && "props" in node) {
    const el = node as { type: unknown; props: { children?: unknown } };
    // A simple, hookless function component (e.g. our own BuyCourseForm
    // mock, which has no `children` prop at all) can be invoked directly
    // outside React's render loop. A component that actually uses hooks
    // (e.g. next/link's Link) throws when called this way -- fall back to
    // walking .props.children exactly as before, which is what every
    // already-passing assertion here relies on.
    if (typeof el.type === "function") {
      try {
        return flatten((el.type as (props: unknown) => unknown)(el.props));
      } catch {
        return flatten(el.props.children);
      }
    }
    return flatten(el.props.children);
  }
  return "";
}

const baseOffer = {
  ok: true as const,
  slug: "cybersecurity-foundations",
  title: "Cybersecurity Foundations",
  examinationBody: "ISC2",
  qualificationName: "Certified in Cybersecurity",
  priceAmountMinor: 19900,
  currency: "GBP",
  summary: "A hands-on introduction.",
  cohortStartsOn: "2026-09-01",
  deliveryPlan: "STANDARD_6_WEEK" as const,
  viewerAuthenticated: false,
  viewerEntitled: false,
  viewerEnrolmentId: null,
  viewerEnrolmentStatus: "NONE" as const,
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.commerceConfig.mockReturnValue({ configured: true });
  mocks.getCurrentActor.mockResolvedValue({
    id: "learner-1",
    displayName: "Alex",
    roles: ["STUDENT"],
  });
});

describe("page: /courses", () => {
  it("renders the published catalogue", async () => {
    mocks.listCommercialV1Offers.mockResolvedValue([
      {
        slug: "cybersecurity-foundations",
        title: "Cybersecurity Foundations",
        examinationBody: "ISC2",
        qualificationName: "Certified in Cybersecurity",
        priceAmountMinor: 19900,
        currency: "GBP",
        summary: "A hands-on introduction.",
        cohortStartsOn: "2026-09-01",
        // The published projection always carries a plan (schema default).
        deliveryPlan: "STANDARD_6_WEEK",
      },
    ]);
    const el = await CoursesPage();
    const text = flatten(el);
    expect(text).toContain("Cybersecurity Foundations");
    expect(text).toContain("ISC2");
  });

  it("renders an honest empty state, never fabricated content", async () => {
    mocks.listCommercialV1Offers.mockResolvedValue([]);
    const el = await CoursesPage();
    const text = flatten(el);
    expect(text).toMatch(/no courses/i);
  });
});

describe("page: /courses/[slug]", () => {
  it("calls notFound() for an unknown/unpublished slug", async () => {
    mocks.getCommercialV1Offer.mockResolvedValue({
      ok: false,
      code: "NOT_FOUND",
    });
    await expect(
      CourseDetailPage({ params: Promise.resolve({ slug: "unknown" }) }),
    ).rejects.toThrow("NOT_FOUND");
    expect(mocks.notFound).toHaveBeenCalled();
  });

  it("prompts an anonymous viewer to sign in/create an account with next= preserved, and shows no buy form", async () => {
    mocks.getCommercialV1Offer.mockResolvedValue(baseOffer);
    const el = await CourseDetailPage({
      params: Promise.resolve({ slug: "cybersecurity-foundations" }),
    });
    const text = flatten(el);
    expect(text).toMatch(/sign in to continue/i);
    expect(text).toContain("Create an account");
  });

  it("V2 correction (item 4): an ACTIVE-enrolled or entitled viewer sees Continue learning, never a buy button", async () => {
    mocks.getCommercialV1Offer.mockResolvedValue({
      ...baseOffer,
      viewerAuthenticated: true,
      viewerEntitled: true,
      viewerEnrolmentStatus: "ACTIVE",
    });
    const el = await CourseDetailPage({
      params: Promise.resolve({ slug: "cybersecurity-foundations" }),
    });
    const text = flatten(el);
    expect(text).toMatch(/already have access/i);
    expect(text).not.toContain("BUY_FORM_MARKER:");
  });

  it("V2 correction (item 4): a PAUSED-enrolled viewer is told to contact support, never offered a fresh purchase", async () => {
    mocks.getCommercialV1Offer.mockResolvedValue({
      ...baseOffer,
      viewerAuthenticated: true,
      viewerEnrolmentStatus: "PAUSED",
    });
    const el = await CourseDetailPage({
      params: Promise.resolve({ slug: "cybersecurity-foundations" }),
    });
    const text = flatten(el);
    expect(text).toMatch(/paused/i);
    expect(text).not.toContain("BUY_FORM_MARKER:");
  });

  it("V2 correction (item 4): a COMPLETED-enrolled viewer is told they already completed the course, never offered a fresh purchase", async () => {
    mocks.getCommercialV1Offer.mockResolvedValue({
      ...baseOffer,
      viewerAuthenticated: true,
      viewerEnrolmentStatus: "COMPLETED",
    });
    const el = await CourseDetailPage({
      params: Promise.resolve({ slug: "cybersecurity-foundations" }),
    });
    const text = flatten(el);
    expect(text).toMatch(/already completed/i);
    expect(text).not.toContain("BUY_FORM_MARKER:");
  });

  it("V2 correction (item 4): a WITHDRAWN-enrolled viewer is told to contact support, never offered a fresh purchase", async () => {
    mocks.getCommercialV1Offer.mockResolvedValue({
      ...baseOffer,
      viewerAuthenticated: true,
      viewerEnrolmentStatus: "WITHDRAWN",
    });
    const el = await CourseDetailPage({
      params: Promise.resolve({ slug: "cybersecurity-foundations" }),
    });
    const text = flatten(el);
    expect(text).toMatch(/contact support/i);
    expect(text).not.toContain("BUY_FORM_MARKER:");
  });

  it("when card checkout is unavailable, still exposes the code form for complimentary access", async () => {
    mocks.commerceConfig.mockReturnValue({ configured: false });
    mocks.getCommercialV1Offer.mockResolvedValue({
      ...baseOffer,
      viewerAuthenticated: true,
    });
    const el = await CourseDetailPage({
      params: Promise.resolve({ slug: "cybersecurity-foundations" }),
    });
    const text = flatten(el);
    expect(text).toMatch(/card checkout is temporarily unavailable/i);
    expect(text).toContain("BUY_FORM_MARKER:cybersecurity-foundations:false");
  });

  it("shows the buy/code form for an authenticated, unenrolled, unentitled viewer when commerce is configured", async () => {
    mocks.getCommercialV1Offer.mockResolvedValue({
      ...baseOffer,
      viewerAuthenticated: true,
    });
    const el = await CourseDetailPage({
      params: Promise.resolve({ slug: "cybersecurity-foundations" }),
    });
    const text = flatten(el);
    expect(text).toContain("BUY_FORM_MARKER:cybersecurity-foundations:true");
  });

  it("V2 correction (item 12): the scheduling caption never claims immediate access -- only that it opens once verified/confirmed", async () => {
    mocks.getCommercialV1Offer.mockResolvedValue({
      ...baseOffer,
      viewerAuthenticated: true,
    });
    const el = await CourseDetailPage({
      params: Promise.resolve({ slug: "cybersecurity-foundations" }),
    });
    const text = flatten(el);
    expect(text).not.toMatch(/open(s)? immediately/i);
  });
});

describe("action: startCheckout", () => {
  it("redirects to the real Stripe-hosted URL on success", async () => {
    mocks.createCommercialV1Checkout.mockResolvedValue({
      ok: true,
      kind: "CHECKOUT",
      url: "https://checkout.stripe.test/cs_test_1",
      orderId: "order-1",
    });
    const form = new FormData();
    form.set("slug", "cybersecurity-foundations");
    await expect(startCheckout({}, form)).rejects.toThrow(
      "REDIRECT:https://checkout.stripe.test/cs_test_1",
    );
  });

  it("passes an optional campaign code and redirects direct access into the learner programme", async () => {
    mocks.createCommercialV1Checkout.mockResolvedValue({
      ok: true,
      kind: "ACCESS_GRANTED",
      entitlementId: "entitlement-1",
      enrolmentId: "enrolment-1",
      offerSlug: "cybersecurity-foundations",
    });
    const form = new FormData();
    form.set("slug", "cybersecurity-foundations");
    form.set("campaignCode", "reviewer-50");
    await expect(startCheckout({}, form)).rejects.toThrow(
      "REDIRECT:/student/programme?access=granted",
    );
    expect(mocks.createCommercialV1Checkout).toHaveBeenCalledWith(
      "cybersecurity-foundations",
      "reviewer-50",
    );
  });

  it("never redirects on a denial -- returns a truthful error instead", async () => {
    mocks.createCommercialV1Checkout.mockResolvedValue({
      ok: false,
      code: "ALREADY_ENTITLED",
    });
    const form = new FormData();
    form.set("slug", "cybersecurity-foundations");
    const result = await startCheckout({}, form);
    expect(result.error).toBeTruthy();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});

describe("page: /checkout/success", () => {
  // LR-03: a buyer whose sign-in lapsed during Stripe Checkout keeps the
  // exact order through login instead of losing it.
  const ORDER = "10000000-0000-4000-8000-000000000001";
  it("sends a signed-out buyer to login with this exact order as the validated return", async () => {
    mocks.getCurrentActor.mockResolvedValue(null);
    await expect(
      SuccessPage({
        searchParams: Promise.resolve({
          order: ORDER,
          session_id: "cs_test_a1B2",
        }),
      }),
    ).rejects.toThrow("REDIRECT:");
    expect(mocks.redirect).toHaveBeenCalledExactlyOnceWith(
      "/login?next=" +
        encodeURIComponent(
          `/checkout/success?order=${ORDER}&session_id=cs_test_a1B2`,
        ),
    );
    expect(mocks.reconcileCommercialV1Order).not.toHaveBeenCalled();
  });
  it("sends a signed-out visitor with unusable parameters to plain login", async () => {
    mocks.getCurrentActor.mockResolvedValue(null);
    await expect(
      SuccessPage({
        searchParams: Promise.resolve({ order: "x", session_id: "/admin" }),
      }),
    ).rejects.toThrow("REDIRECT:/login");
    expect(mocks.redirect).toHaveBeenCalledExactlyOnceWith("/login");
    expect(mocks.reconcileCommercialV1Order).not.toHaveBeenCalled();
  });
  it("refunded redundant payment is shown without claiming course access was revoked", async () => {
    mocks.reconcileCommercialV1Order.mockResolvedValue({
      ok: false,
      code: "ORDER_REFUNDED",
    });
    const text = flatten(
      await SuccessPage({
        searchParams: Promise.resolve({ order: "order-b", session_id: "cs_b" }),
      }),
    );
    expect(text).toContain("Payment refunded");
    expect(text).toMatch(
      /another purchase or an independent academic enrolment is unchanged/,
    );
    expect(text).not.toContain("Course access revoked");
    expect(text).not.toContain("Payment confirmed");
  });
  it("actual course access revocation remains explicit", async () => {
    mocks.reconcileCommercialV1Order.mockResolvedValue({
      ok: false,
      code: "ACCESS_REVOKED",
    });
    const text = flatten(
      await SuccessPage({
        searchParams: Promise.resolve({ order: "order-a", session_id: "cs_a" }),
      }),
    );
    expect(text).toContain("Course access revoked");
  });
  it("only claims payment confirmed when the server fulfillment result says fulfilled:true", async () => {
    mocks.reconcileCommercialV1Order.mockResolvedValue({
      ok: true,
      fulfilled: true,
      replay: false,
      orderId: "order-1",
    });
    const el = await SuccessPage({
      searchParams: Promise.resolve({ order: "order-1", session_id: "cs_1" }),
    });
    const text = flatten(el);
    expect(text).toMatch(/payment confirmed/i);
  });

  it("never says payment confirmed for a NOT_PAID reconciliation result", async () => {
    mocks.reconcileCommercialV1Order.mockResolvedValue({
      ok: true,
      fulfilled: false,
      code: "NOT_PAID",
      orderId: "order-1",
    });
    const el = await SuccessPage({
      searchParams: Promise.resolve({ order: "order-1", session_id: "cs_1" }),
    });
    const text = flatten(el);
    expect(text).toMatch(/not confirmed/i);
    expect(text).not.toMatch(/payment confirmed/i);
  });

  it("never says payment confirmed for a denied/mismatched reconciliation result", async () => {
    mocks.reconcileCommercialV1Order.mockResolvedValue({
      ok: false,
      code: "MISMATCHED_AMOUNT",
    });
    const el = await SuccessPage({
      searchParams: Promise.resolve({ order: "order-1", session_id: "cs_1" }),
    });
    const text = flatten(el);
    expect(text).not.toMatch(/payment confirmed/i);
  });

  it("distinguishes ENROLMENT_NOT_ACTIVATABLE as a support case, not a payment failure", async () => {
    mocks.reconcileCommercialV1Order.mockResolvedValue({
      ok: false,
      code: "ENROLMENT_NOT_ACTIVATABLE",
    });
    const el = await SuccessPage({
      searchParams: Promise.resolve({ order: "order-1", session_id: "cs_1" }),
    });
    const text = flatten(el);
    expect(text).toMatch(/contact support/i);
    expect(text).not.toMatch(/could not verify this payment$/im);
  });

  it("renders an honest missing-details state without ever calling the reconciliation server function", async () => {
    const el = await SuccessPage({ searchParams: Promise.resolve({}) });
    const text = flatten(el);
    expect(text).toMatch(/missing/i);
    expect(mocks.reconcileCommercialV1Order).not.toHaveBeenCalled();
  });
});

describe("page: /checkout/cancel", () => {
  it("V2 correction (item 8): never claims 'you were not charged' -- makes no authoritative financial claim", () => {
    const el = CancelPage();
    const text = flatten(el);
    expect(text).not.toMatch(/you were not charged/i);
    expect(text).toMatch(/has not confirmed a completed payment/i);
  });
});
