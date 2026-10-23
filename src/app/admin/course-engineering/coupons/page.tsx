import Link from "next/link";
import { z } from "zod";
import { AdminForbidden, AdminShell } from "@/components/admin-shell";
import { DataTable, Panel, Unavailable } from "@/components/admin-ui";
import {
  adminWorkspaceAccess,
  COURSE_ADMIN_ROLES,
} from "@/server/admin-access";
import {
  listCourseCoupons,
  getCourseCouponRedemptions,
} from "@/server/course-coupons";
import { listUnifiedCoursePackages } from "@/server/unified-course-engine";
import {
  CreateCourseCouponForm,
  ToggleCourseCouponForm,
} from "@/components/course-coupon-forms";
export const dynamic = "force-dynamic";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ couponId?: string }>;
}) {
  const access = await adminWorkspaceAccess(COURSE_ADMIN_ROLES);
  if (!access.allowed)
    return (
      <AdminForbidden
        actor={access.actor}
        active="courses"
        title="Course coupons"
        requires={COURSE_ADMIN_ROLES}
      />
    );
  const [coupons, packages, params] = await Promise.all([
    listCourseCoupons().catch(() => null),
    listUnifiedCoursePackages().catch(() => null),
    searchParams,
  ]);
  const id = z.uuid().safeParse(params.couponId);
  const redemptions = id.success
    ? await getCourseCouponRedemptions(id.data).catch(() => null)
    : null;
  return (
    <AdminShell
      active="courses"
      name={access.actor.displayName}
      roles={access.actor.roles}
      title="Course coupons"
      description="Create discounts, control availability and review reserved and redeemed uses."
      actions={
        <Link href="/admin/course-engineering" className="ac-button secondary">
          Course Engineering
        </Link>
      }
    >
      <Panel title="New coupon">
        <p>
          100% coupons grant access without a Stripe charge. Partial discounts
          use secure card checkout. A pending checkout reserves a use until
          resolved; resuming it uses the same order and coupon. Existing
          reservations keep their agreed terms after expiry or deactivation.
        </p>
        {packages ? (
          <CreateCourseCouponForm
            courses={packages.flatMap((p) =>
              p.course
                ? [{ id: p.course.id, title: p.title ?? p.packageKey }]
                : [],
            )}
          />
        ) : (
          <Unavailable what="The published course register" />
        )}
      </Panel>
      <Panel title="Coupons (newest 200)">
        {coupons ? (
          <ul className="acad-list">
            {coupons.map((c) => (
              <li key={c.id}>
                <h2>
                  {c.code}: {c.percentOff}%
                </h2>
                <p>
                  {c.active ? "Active" : "Inactive"}. Expires{" "}
                  {new Date(c.expiresAt).toISOString()}. {c.reserved} reserved;{" "}
                  {c.redeemed} redeemed; limit {c.redemptionLimit}. Scope:{" "}
                  {c.courseId ?? "all unified courses"}.
                </p>
                <Link href={`?couponId=${c.id}`}>Redemption report</Link>
                <ToggleCourseCouponForm id={c.id} active={c.active} />
              </li>
            ))}
          </ul>
        ) : (
          <Unavailable what="The coupon register" />
        )}
      </Panel>
      {id.success && (
        <Panel title="Redemptions (newest 200)">
          {redemptions ? (
            <DataTable
              caption="Authoritative coupon reservation and redemption evidence"
              columns={[
                "Recorded (UTC)",
                "Learner",
                "Course",
                "State",
                "Discount (minor units)",
                "Order",
              ]}
              rows={redemptions.map((r) => [
                new Date(r.createdAt).toISOString(),
                r.learnerId,
                r.courseId,
                r.state,
                String(r.discountAmountMinor),
                r.orderId ?? "Full-discount access",
              ])}
            />
          ) : (
            <Unavailable what="The redemption report" />
          )}
        </Panel>
      )}
    </AdminShell>
  );
}
