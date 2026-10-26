import "server-only";
import { sourced, isCourseAdmin } from "./admin-control-centre";
import { getAdminOverview } from "./staff";
import { listUnifiedCoursePackages } from "./unified-course-engine";
import {
  listCourseCoupons,
  listOrganisationCourseOrders,
} from "./course-coupons";
import {
  describeProductionProfiles,
  providerCredentialReadiness,
} from "./agent-control-plane";
import type { courseEngineeringAccess } from "./course-organisations";
import {
  courseStage,
  isTestCourseRecord,
  type CourseStage,
} from "@/domain/unified-course-lifecycle";
import type { AcademyPackageListItem } from "@/domain/academy-delivery";

// The admin dashboard over the unified Course Engine. Every source is read
// with the administrator's own session (so organisation scope applies) and
// loads independently: an unavailable source is shown as unavailable, never
// as zero.

export type DashboardCourse = {
  latest: AcademyPackageListItem;
  stage: ReturnType<typeof courseStage>;
  revisions: number;
};

// One course per organisation and package key, judged by its latest revision.
function latestRevisions(packages: AcademyPackageListItem[]) {
  const byCourse = new Map<string, AcademyPackageListItem[]>();
  for (const p of packages) {
    const key = `${p.organisationId ?? ""}:${p.packageKey}`;
    byCourse.set(key, [...(byCourse.get(key) ?? []), p]);
  }
  return [...byCourse.values()].map((revisions): DashboardCourse => {
    const latest = revisions.reduce((a, b) =>
      b.packageRevision > a.packageRevision ? b : a,
    );
    return { latest, stage: courseStage(latest), revisions: revisions.length };
  });
}

export const NEEDS_ATTENTION: readonly CourseStage[] = [
  "AWAITING_REVIEW",
  "UPLOADED",
  "PUBLICATION_INCOMPLETE",
  "FAILED",
  "APPROVED_FOR_PUBLICATION",
];

export async function getUnifiedDashboardData(
  access: Awaited<ReturnType<typeof courseEngineeringAccess>>,
) {
  const roles = access.actor.roles;
  const staff = roles.some(
    (r) => r === "ACADEMIC_ADMIN" || r === "PLATFORM_ADMIN",
  );
  const [overview, packages, orders, coupons] = await Promise.all([
    // Academy-wide totals and the audit trail are platform-staff views.
    staff
      ? sourced(async () => {
          const o = await getAdminOverview();
          return {
            learners: o.counts[1],
            audit: o.audit.slice(0, 8),
            canAudit: roles.includes("PLATFORM_ADMIN"),
          };
        })
      : Promise.resolve({ ok: false as const }),
    sourced(listUnifiedCoursePackages),
    sourced(listOrganisationCourseOrders),
    sourced(listCourseCoupons),
  ]);
  const courses = packages.ok ? latestRevisions(packages.data) : [];
  const real = courses.filter((c) => !isTestCourseRecord(c.latest));
  const realOrders = orders.ok
    ? orders.data.filter(
        (o) => !isTestCourseRecord({ packageKey: "", title: o.courseTitle }),
      )
    : [];
  const now = Date.now();
  return {
    staff,
    courseAdmin: isCourseAdmin(roles),
    overview,
    courses: packages.ok
      ? { ok: true as const, real, test: courses.length - real.length }
      : { ok: false as const },
    orders: orders.ok
      ? {
          ok: true as const,
          rows: realOrders,
          test: orders.data.length - realOrders.length,
          total: orders.data.length,
        }
      : { ok: false as const },
    coupons: coupons.ok
      ? {
          ok: true as const,
          active: coupons.data.filter(
            (c) => c.active && Date.parse(c.expiresAt) > now,
          ).length,
          total: coupons.data.length,
        }
      : { ok: false as const },
    agents: staff
      ? describeProductionProfiles(providerCredentialReadiness()).map((p) => ({
          ref: p.ref,
          roles: p.roles,
          ready: p.readiness === "CREDENTIAL_PRESENT",
        }))
      : [],
  };
}
