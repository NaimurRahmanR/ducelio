import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  actor: vi.fn(),
  rpc: vi.fn(),
  refresh: vi.fn(),
  checkout: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error("REDIRECT:" + url);
  }),
}));
vi.mock("@/server/identity", () => ({ requireActor: m.actor }));
vi.mock("@/server/supabase", () => ({
  createSupabase: async () => ({ rpc: m.rpc }),
}));
vi.mock("next/cache", () => ({ revalidatePath: m.refresh }));
vi.mock("next/navigation", () => ({ redirect: m.redirect }));
vi.mock("@/server/academy-commerce", () => ({
  createUnifiedCourseCheckout: m.checkout,
}));
import { createCourseCoupon, listCourseCoupons } from "@/server/course-coupons";
import { createCouponAction } from "@/app/admin/course-engineering/coupons/actions";
import { startAcademyCheckout } from "@/app/academy/actions";
import { AcademyBuyForm } from "@/components/academy-buy-form";
import {
  CreateCourseCouponForm,
  ToggleCourseCouponForm,
} from "@/components/course-coupon-forms";
const id = "10000000-0000-4000-8000-000000000101";
beforeEach(() => {
  vi.resetAllMocks();
  m.actor.mockResolvedValue({ roles: ["ACADEMIC_ADMIN"] });
  m.rpc.mockResolvedValue({ data: id, error: null });
});
describe("course coupon server and UI boundaries", () => {
  it("exposes expiry, limits, course restriction, activation and all discount percentages", () => {
    const html = renderToStaticMarkup(
      createElement(CreateCourseCouponForm, {
        courses: [{ id, title: "Synthetic Course" }],
      }),
    );
    for (const name of [
      "code",
      "discountKind",
      "percentOff",
      "expiresAt",
      "redemptionLimit",
      "courseId",
      "reason",
    ])
      expect(html).toContain(`name="${name}"`);
    expect(html).toContain('max="100"');
    expect(html).toContain("Expiry (UTC)");
    expect(
      renderToStaticMarkup(
        createElement(ToggleCourseCouponForm, { id, active: true }),
      ),
    ).toContain("Deactivate coupon");
  });
  it.each(["STUDENT", "INSTRUCTOR", "REGISTRAR"])(
    "denies %s without organisation authority through the database",
    async (role) => {
      m.actor.mockResolvedValue({ roles: [role] });
      m.rpc.mockResolvedValue({ error: { message: "FORBIDDEN" } });
      await expect(listCourseCoupons()).rejects.toThrow();
      expect(m.rpc).toHaveBeenCalledExactlyOnceWith("list_course_coupons", {});
    },
  );
  it("sends reviewed coupon fields only, with a normalized code", async () => {
    await createCourseCoupon({
      code: " summer-100 ",
      percentOff: 100,
      expiresAt: "2030-01-01T00:00:00Z",
      redemptionLimit: 5,
      courseId: id,
      reason: "Synthetic coupon approval",
    });
    expect(m.rpc).toHaveBeenCalledExactlyOnceWith(
      "create_organisation_course_coupon",
      {
        p_organisation_id: "00000000-0000-4000-8000-000000000001",
        p_code: "SUMMER-100",
        p_percent_off: 100,
        p_expires_at: "2030-01-01T00:00:00Z",
        p_redemption_limit: 5,
        p_course_id: id,
        p_reason: "Synthetic coupon approval",
      },
    );
  });
  it("sends a fixed amount with its currency to the separate amount authority", async () => {
    await createCourseCoupon({
      code: "save-25",
      amountOffMinor: 2500,
      currency: "GBP",
      expiresAt: "2030-01-01T00:00:00Z",
      redemptionLimit: 5,
      courseId: null,
      reason: "Synthetic coupon approval",
    });
    expect(m.rpc).toHaveBeenCalledExactlyOnceWith(
      "create_organisation_course_amount_coupon",
      {
        p_organisation_id: "00000000-0000-4000-8000-000000000001",
        p_code: "SAVE-25",
        p_amount_off_minor: 2500,
        p_currency: "GBP",
        p_expires_at: "2030-01-01T00:00:00Z",
        p_redemption_limit: 5,
        p_course_id: null,
        p_reason: "Synthetic coupon approval",
      },
    );
  });
  it("refuses mixed, partial or unsupported discount input before any RPC", async () => {
    const base = {
      code: "MIXED-1",
      expiresAt: "2030-01-01T00:00:00Z",
      redemptionLimit: 5,
      courseId: null,
      reason: "Synthetic coupon approval",
    };
    for (const discount of [
      { percentOff: 10, amountOffMinor: 100, currency: "GBP" },
      { amountOffMinor: 100 },
      { amountOffMinor: 100, currency: "JPY" },
      { amountOffMinor: 0, currency: "GBP" },
      { amountOffMinor: 12.5, currency: "GBP" },
      {},
    ])
      await expect(
        createCourseCoupon({ ...base, ...discount }),
      ).rejects.toThrow();
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it.each([
    ["25", 2500],
    ["25.5", 2550],
    ["0.30", 30],
    ["999999.99", 99999999],
  ])(
    "converts the admin fixed amount %s exactly to minor units",
    async (amountOff, minor) => {
      const f = new FormData();
      for (const [k, v] of Object.entries({
        code: "FIXED-TEST",
        discountKind: "AMOUNT",
        amountOff,
        currency: "EUR",
        expiresAt: "2030-01-01T12:30",
        redemptionLimit: "5",
        courseId: "",
        reason: "Synthetic approval",
      }))
        f.set(k, v);
      expect(await createCouponAction({}, f)).toHaveProperty("message");
      expect(m.rpc.mock.calls[0][0]).toBe(
        "create_organisation_course_amount_coupon",
      );
      expect(m.rpc.mock.calls[0][1]).toMatchObject({
        p_amount_off_minor: minor,
        p_currency: "EUR",
      });
      expect(m.rpc.mock.calls[0][1]).not.toHaveProperty("p_percent_off");
    },
  );
  it.each(["0", "1.234", "-5", "1e3", "", "12,50"])(
    "refuses the malformed admin fixed amount %j",
    async (amountOff) => {
      const f = new FormData();
      for (const [k, v] of Object.entries({
        code: "FIXED-TEST",
        discountKind: "AMOUNT",
        amountOff,
        currency: "GBP",
        expiresAt: "2030-01-01T12:30",
        redemptionLimit: "5",
        courseId: "",
        reason: "Synthetic approval",
      }))
        f.set(k, v);
      expect(await createCouponAction({}, f)).toHaveProperty("error");
      expect(m.rpc).not.toHaveBeenCalled();
    },
  );
  it("records an unambiguous UTC expiry from the admin form", async () => {
    const f = new FormData();
    for (const [k, v] of Object.entries({
      code: "FREE-TEST",
      percentOff: "100",
      expiresAt: "2030-01-01T12:30",
      redemptionLimit: "5",
      courseId: "",
      reason: "Synthetic approval",
    }))
      f.set(k, v);
    expect(await createCouponAction({}, f)).toHaveProperty("message");
    expect(m.rpc.mock.calls[0][1].p_expires_at).toBe("2030-01-01T12:30:00Z");
  });
  it("keeps price, duration and actor choices out of the purchase form", () => {
    const html = renderToStaticMarkup(
      createElement(AcademyBuyForm, {
        slug: "synthetic-course",
        currency: "GBP",
        formats: [{ formatId: "STANDARD_6W", amountMinor: 9999 }],
      }),
    );
    expect(html).toContain('name="couponCode"');
    expect(html).not.toMatch(/name="(?:formatId|price|actorId|amountMinor)"/);
    expect(html).toContain("Duration does not change the price");
  });
  it("passes only course and code to checkout and follows backend-granted free access", async () => {
    const f = new FormData();
    f.set("slug", "synthetic-course");
    f.set("couponCode", "FULL-TEST");
    f.set("amountMinor", "0");
    f.set("actorId", "forged");
    m.checkout.mockResolvedValue({
      ok: true,
      url: `/student/academy?enrolmentId=${id}`,
    });
    await expect(startAcademyCheckout({}, f)).rejects.toThrow(
      `REDIRECT:/student/academy?enrolmentId=${id}`,
    );
    expect(m.checkout).toHaveBeenCalledExactlyOnceWith(
      "synthetic-course",
      "FULL-TEST",
    );
  });
  it("does not redirect or expose backend content after a refusal", async () => {
    m.checkout.mockResolvedValue({ ok: false, code: "COUPON_UNAVAILABLE" });
    const result = await startAcademyCheckout({}, new FormData());
    expect(result.error).toContain("coupon");
    expect(m.redirect).not.toHaveBeenCalled();
    m.rpc.mockResolvedValue({
      data: null,
      error: { message: "PRIVATE_SENTINEL" },
    });
    await expect(listCourseCoupons()).rejects.toThrow(
      "COUPON_SERVICE_UNAVAILABLE",
    );
  });
});
