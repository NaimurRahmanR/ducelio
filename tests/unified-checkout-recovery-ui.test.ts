import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  cancel: vi.fn(),
  resume: vi.fn(),
  refresh: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error("REDIRECT:" + url);
  }),
}));
vi.mock("@/server/academy-commerce", () => ({
  cancelMyUnifiedCheckout: m.cancel,
  resumeMyUnifiedCheckout: m.resume,
}));
vi.mock("next/navigation", () => ({ redirect: m.redirect }));
vi.mock("next/cache", () => ({ revalidatePath: m.refresh }));
import {
  cancelUnifiedCheckoutAction,
  resumeUnifiedCheckoutAction,
} from "@/app/student/academy/checkout-actions";
import { CourseCheckoutRecovery } from "@/components/course-checkout-recovery";
const id = "10000000-0000-4000-8000-000000000101";
beforeEach(() => vi.resetAllMocks());
const form = () => {
  const f = new FormData();
  f.set("orderId", id);
  return f;
};
it("exposes resume and verified cancellation with an explicit confirmation", () => {
  const html = renderToStaticMarkup(
    createElement(CourseCheckoutRecovery, { orderId: id }),
  );
  expect(html).toContain("Resume checkout");
  expect(html).toContain('name="confirm"');
  expect(html).toContain("Verify and cancel checkout");
});
it("requires confirmation before any cancellation request", async () => {
  expect(await cancelUnifiedCheckoutAction({}, form())).toHaveProperty("error");
  expect(m.cancel).not.toHaveBeenCalled();
});
it("retains the reservation when provider verification fails", async () => {
  m.cancel.mockRejectedValue(new Error("SECRET provider details"));
  const f = form();
  f.set("confirm", "on");
  const state = await cancelUnifiedCheckoutAction({}, f);
  expect(state.error).toContain("reservation has been retained");
  expect(JSON.stringify(state)).not.toContain("SECRET");
  expect(m.refresh).not.toHaveBeenCalled();
});
it("reports cancellation only after the authority confirms it", async () => {
  m.cancel.mockResolvedValue({ ok: true, code: "CANCELLED" });
  const f = form();
  f.set("confirm", "on");
  expect(await cancelUnifiedCheckoutAction({}, f)).toHaveProperty("message");
  expect(m.cancel).toHaveBeenCalledExactlyOnceWith(id);
});
it("redirects only to the resumed provider checkout returned by the server", async () => {
  m.resume.mockResolvedValue({
    ok: true,
    url: "https://checkout.stripe.com/test-fixture",
  });
  await expect(resumeUnifiedCheckoutAction(form())).rejects.toThrow(
    "REDIRECT:https://checkout.stripe.com/test-fixture",
  );
});
