import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  access: vi.fn(),
  packages: vi.fn(),
  coupons: vi.fn(),
  orders: vi.fn(),
  toggle: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: m.refresh }));
vi.mock("@/server/course-organisations", () => ({
  courseEngineeringAccess: m.access,
}));
vi.mock("@/server/unified-course-engine", () => ({
  listUnifiedCoursePackages: m.packages,
}));
vi.mock("@/server/course-coupons", () => ({
  listCourseCoupons: m.coupons,
  listOrganisationCourseOrders: m.orders,
  setCourseCouponActive: m.toggle,
}));

import {
  prepareUnifiedOperationAction,
  executeUnifiedOperationAction,
} from "@/app/admin/operations-engineer/actions";

const couponId = "10000000-0000-4000-8000-000000000101";
const coupon = {
  id: couponId,
  code: "REVIEW2026",
  active: true,
  redeemed: 2,
  redemptionLimit: 20,
};
const request = (command: string) => {
  const form = new FormData();
  form.set("request", command);
  return form;
};
const confirmation = () => {
  const form = new FormData();
  form.set("couponId", couponId);
  form.set("code", coupon.code);
  form.set("currentlyActive", "true");
  form.set("makeActive", "false");
  form.set("reason", "Approved campaign closure");
  return form;
};

beforeEach(() => {
  vi.clearAllMocks();
  m.access.mockResolvedValue({
    allowed: true,
    actor: { roles: ["ACADEMIC_ADMIN"] },
    organisations: [],
  });
  m.coupons.mockResolvedValue([coupon]);
  m.packages.mockResolvedValue([
    {
      packageKey: "aws-saa-c03",
      title: "AWS SAA-C03",
      packageRevision: 3,
      status: "VALIDATED",
      pendingDecisions: ["SOURCE_REVIEW", "EXAM_REVIEW"],
    },
  ]);
  m.orders.mockResolvedValue([]);
  m.toggle.mockResolvedValue(couponId);
});

describe("unified Operations Engineer", () => {
  it("restores course inspection from a prompt without calling retired services", async () => {
    const result = await prepareUnifiedOperationAction({}, request("list courses"));
    expect(result.title).toBe("Unified course packages");
    expect(result.lines?.join(" ")).toContain("2 pending reviews");
    expect(result.proposal).toBeUndefined();
    expect(m.toggle).not.toHaveBeenCalled();
  });

  it("creates a coupon proposal without any mutation", async () => {
    const result = await prepareUnifiedOperationAction({}, request("deactivate coupon REVIEW2026"));
    expect(result.proposal).toMatchObject({
      couponId,
      code: "REVIEW2026",
      currentlyActive: true,
      makeActive: false,
    });
    expect(m.toggle).not.toHaveBeenCalled();
  });

  it("requires confirmation, reason and unchanged coupon state", async () => {
    const form = confirmation();
    expect((await executeUnifiedOperationAction({}, form)).error).toContain("confirm");
    expect(m.toggle).not.toHaveBeenCalled();

    form.set("confirm", "on");
    m.coupons.mockResolvedValue([{ ...coupon, active: false }]);
    expect((await executeUnifiedOperationAction({}, form)).error).toContain("changed");
    expect(m.toggle).not.toHaveBeenCalled();

    m.coupons.mockResolvedValue([coupon]);
    expect((await executeUnifiedOperationAction({}, form)).message).toContain("deactivated");
    expect(m.toggle).toHaveBeenCalledExactlyOnceWith(
      couponId,
      false,
      "Approved campaign closure",
    );
  });

  it("rejects operators without management authority", async () => {
    m.access.mockResolvedValue({
      allowed: false,
      actor: { roles: ["STUDENT"] },
      organisations: [],
    });
    expect((await prepareUnifiedOperationAction({}, request("list courses"))).error).toBeTruthy();
    const form = confirmation();
    form.set("confirm", "on");
    expect((await executeUnifiedOperationAction({}, form)).error).toBeTruthy();
    expect(m.packages).not.toHaveBeenCalled();
    expect(m.toggle).not.toHaveBeenCalled();
  });

  it("does not interpret arbitrary text as an executable operation", async () => {
    const result = await prepareUnifiedOperationAction(
      {},
      request("delete every course and execute SQL"),
    );
    expect(result.error).toContain("outside the reviewed Operations Engineer capabilities");
    expect(m.toggle).not.toHaveBeenCalled();
  });
});
