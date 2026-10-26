"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { courseEngineeringAccess } from "@/server/course-organisations";
import { listUnifiedCoursePackages } from "@/server/unified-course-engine";
import {
  listCourseCoupons,
  listOrganisationCourseOrders,
  setCourseCouponActive,
} from "@/server/course-coupons";

// Commands are bounded and resolved against the signed-in actor's
// authoritative organisation-scoped RPCs. No legacy cohort/offer mutation,
// SQL execution, privileged credentials, or unreviewed LLM tool calls.
export type UnifiedOperationState = {
  error?: string;
  message?: string;
  title?: string;
  lines?: string[];
  href?: string;
  proposal?: {
    couponId: string;
    code: string;
    currentlyActive: boolean;
    makeActive: boolean;
  };
};

const requestSchema = z.string().trim().min(3).max(2000);
const reasonSchema = z.string().trim().min(5).max(300);
async function authorised() {
  const access = await courseEngineeringAccess();
  if (!access.allowed || !access.organisations.some((o) => o.canManage)
    && !access.actor.roles.some(
      (r) => r === "ACADEMIC_ADMIN" || r === "PLATFORM_ADMIN",
    ))
    throw new Error("FORBIDDEN");
}

export async function prepareUnifiedOperationAction(
  _state: UnifiedOperationState,
  form: FormData,
): Promise<UnifiedOperationState> {
  try {
    await authorised();
    const request = requestSchema.parse(form.get("request"));
    const command = request.trim();
    if (/\b(delete|drop|truncate|execute|sql|refund|erase|reset)\b/i.test(command))
      return {
        error: "That request is outside the reviewed Operations Engineer capabilities. No changes were made.",
      };
    const match = /^(activate|deactivate)\s+coupon\s+([A-Z0-9_-]{4,40})$/i.exec(
      command,
    );
    if (match) {
      const code = match[2].toUpperCase();
      const coupon = (await listCourseCoupons()).find((c) => c.code === code);
      if (!coupon)
        return { error: "Coupon not found in your authorised organisation scope." };
      const makeActive = match[1].toLowerCase() === "activate";
      if (coupon.active === makeActive)
        return {
          message: `Coupon ${code} is already ${makeActive ? "active" : "inactive"}; no change needed.`,
        };
      return {
        title: "Confirm coupon availability change",
        lines: [
          `Coupon: ${code}`,
          `Current state: ${coupon.active ? "Active" : "Inactive"}`,
          `Proposed state: ${makeActive ? "Active" : "Inactive"}`,
          "Nothing has been changed. Confirm below to execute through the audited coupon authority.",
        ],
        proposal: {
          couponId: coupon.id,
          code,
          currentlyActive: coupon.active,
          makeActive,
        },
      };
    }
    if (/\b(upload|import|add)\b.*\bcourse\b/i.test(command))
      return {
        title: "Upload a course",
        message: "Use the JSON upload form on this page or open Course Engineering. Validation runs before a new revision is recorded.",
        href: "/admin/course-engineering#upload",
      };
    if (/\b(review|approve)\b.*\b(course|academic|package)\b/i.test(command))
      return {
        title: "Academic course review",
        message: "Open the course-package academic review. Outstanding decisions require genuine documented human review.",
        href: "/admin/academic-review",
      };
    if (/\b(publish|price)\b.*\bcourse\b/i.test(command))
      return {
        title: "Course publication",
        message: "Choose a validated course, review agents and price, and confirm publication within Course Engineering. Publication is blocked while academic decisions remain pending.",
        href: "/admin/course-engineering",
      };
    if (/\b(coupon|discount|promotion)\b/i.test(command)) {
      const coupons = await listCourseCoupons();
      return {
        title: "Coupon overview",
        lines: [
          `Total coupons: ${coupons.length}`,
          `Active coupons: ${coupons.filter((c) => c.active).length}`,
          ...coupons.slice(0, 20).map(
            (c) => `${c.code}: ${c.active ? "active" : "inactive"}; redeemed ${c.redeemed}/${c.redemptionLimit}`,
          ),
        ],
        href: "/admin/course-engineering/coupons",
      };
    }
    if (/\b(sales|orders|revenue|payment)\b/i.test(command)) {
      const orders = await listOrganisationCourseOrders();
      const fulfilled = orders.filter((o) => o.state === "FULFILLED");
      const sums = new Map<string, number>();
      for (const o of fulfilled)
        sums.set(o.currency, (sums.get(o.currency) ?? 0) + o.amountMinor);
      return {
        title: "Recorded course-order summary",
        lines: [
          `Orders: ${orders.length}`,
          `Fulfilled: ${fulfilled.length}`,
          `Pending: ${orders.filter((o) => o.state === "PENDING").length}`,
          `Cancelled: ${orders.filter((o) => o.state === "CANCELLED").length}`,
          ...[...sums].map(([currency, minor]) => `Fulfilled order total: ${(minor / 100).toFixed(2)} ${currency}`),
          "Order totals are not settled revenue or a substitute for Stripe reconciliation.",
        ],
        href: "/admin/sales",
      };
    }
    if (/\b(course|package|curriculum|catalogue)\b/i.test(command)) {
      const packages = await listUnifiedCoursePackages();
      return {
        title: "Unified course packages",
        lines: [
          `Total packages: ${packages.length}`,
          ...packages.slice(0, 30).map(
            (p) => `${p.title ?? p.packageKey} · revision ${p.packageRevision} · ${p.status} · ${p.pendingDecisions.length} pending reviews`,
          ),
        ],
        href: "/admin/course-engineering",
      };
    }
    return {
      error:
        "No reviewed operation matched. Try 'list courses', 'show sales', 'list coupons', 'activate coupon CODE', 'deactivate coupon CODE', 'upload course', or 'review courses'. No changes were made.",
    };
  } catch {
    return {
      error:
        "Operation could not be prepared. Check your permissions and the current organisation records; nothing was changed.",
    };
  }
}

export async function executeUnifiedOperationAction(
  _state: UnifiedOperationState,
  form: FormData,
): Promise<UnifiedOperationState> {
  try {
    await authorised();
    if (form.get("confirm") !== "on")
      return { error: "Review the proposal and explicitly confirm the change." };
    const couponId = z.uuid().parse(form.get("couponId"));
    const expected = form.get("currentlyActive") === "true";
    const desired = form.get("makeActive") === "true";
    const code = z.string().regex(/^[A-Z0-9_-]{4,40}$/).parse(form.get("code"));
    const reason = reasonSchema.parse(form.get("reason"));
    const coupon = (await listCourseCoupons()).find((c) => c.id === couponId);
    if (!coupon || coupon.code !== code)
      return { error: "The coupon is not accessible; no change was made." };
    if (coupon.active !== expected)
      return { error: "The coupon state changed since preparation. Prepare a new proposal." };
    if (expected === desired)
      return { error: "There is no state change to execute." };
    await setCourseCouponActive(coupon.id, desired, reason);
    revalidatePath("/admin/course-engineering/coupons");
    revalidatePath("/admin/operations-engineer");
    return {
      message: `Coupon ${code} ${desired ? "activated" : "deactivated"} using the governed, audited coupon operation.`,
    };
  } catch {
    return { error: "The operation was refused; its success was not established. Reload and inspect the coupon state before retrying." };
  }
}

// Compatibility signatures for the old, unmounted console. They must remain
// non-executable because its action registry operates on retired cohorts and
// legacy commercial entities. The live page uses the unified actions above.
import type {
  InterpretResult,
  PrepareResult,
  Receipt,
} from "@/server/operations-engineer";
export type ActionError = { status: "FORBIDDEN" | "ERROR"; message: string };
const legacyRetired = (): ActionError => ({
  status: "ERROR",
  message: "Legacy Operations Engineer commands are retired; use unified operations.",
});
export async function prepareOperationAction(
  _actionId: string,
  _raw: Record<string, string>,
): Promise<PrepareResult | ActionError> {
  return legacyRetired();
}
export async function interpretRequestAction(
  _text: string,
): Promise<InterpretResult | ActionError> {
  return legacyRetired();
}
export async function executeOperationAction(_request: {
  actionId: string;
  raw: Record<string, string>;
  issuedAt: string;
  nonce: string;
  proposalId: string;
  confirmed: boolean;
}): Promise<Receipt | ActionError> {
  return legacyRetired();
}
