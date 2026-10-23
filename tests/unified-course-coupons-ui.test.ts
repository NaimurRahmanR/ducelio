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
    "denies %s coupon administration before database access",
    async (role) => {
      m.actor.mockResolvedValue({ roles: [role] });
      await expect(listCourseCoupons()).rejects.toThrow();
      expect(m.rpc).not.toHaveBeenCalled();
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
    expect(m.rpc).toHaveBeenCalledExactlyOnceWith("create_course_coupon", {
      p_code: "SUMMER-100",
      p_percent_off: 100,
      p_expires_at: "2030-01-01T00:00:00Z",
      p_redemption_limit: 5,
      p_course_id: id,
      p_reason: "Synthetic coupon approval",
    });
  });
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
