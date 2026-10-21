import "server-only";
import { requireActor, requireAnyRole } from "./identity";
import { getAdminOverview } from "./staff";
import {
  getCoursePackagePreview,
  getCoursePackageTestStatus,
  listCoursePackages,
} from "./course-engineering";
import { listAgentConfigs } from "./academic-agent-config";
import {
  operatorPreviewSchema,
  type OperatorPreview,
  type TestStatusResult,
} from "@/domain/course-engineering-admin";
import type { AgentConfigRecord } from "@/domain/academic-agent-config";
import type { CommercialV1ActivationSummary } from "@/domain/course-activation";
import { listCommercialV1Activations } from "./course-activation";
import {
  listCommercialV1Campaigns,
  listCommercialV1OfferActivations,
  listCommercialV1Offers,
} from "./commercial-v1-commerce";
import { listCommerceOperations } from "./commercial-v1-commerce/operations";
import { getCohortWorkspace } from "./cohorts";
import {
  describeProductionProfiles,
  providerCredentialReadiness,
} from "./agent-control-plane";
import {
  deriveCourseLifecycle,
  type CourseLifecycle,
  type LifecyclePackage,
  type TestReadiness,
} from "@/domain/admin-course-lifecycle";
import type { Role } from "@/domain/academy";
import {
  isAcceptanceCourse,
  isAcceptanceOfferSlug,
  isNonBusinessCohort,
} from "@/domain/admin-test-records";
import type { CommerceList } from "@/domain/commercial-v1-commerce-operations";

// Read-only aggregation for the admin control centre. Every value comes from
// an existing governed server read (each enforcing its own role and the
// database enforcing it again). A source that fails is reported as
// unavailable, never replaced with a guess, a zero or sample data.

export const COURSE_ADMINS: readonly Role[] = [
  "ACADEMIC_ADMIN",
  "PLATFORM_ADMIN",
];

export type Sourced<T> = { ok: true; data: T } | { ok: false };

export async function sourced<T>(read: () => Promise<T>): Promise<Sourced<T>> {
  try {
    return { ok: true, data: await read() };
  } catch {
    return { ok: false };
  }
}

export const isCourseAdmin = (roles: readonly Role[]) =>
  roles.some((r) => COURSE_ADMINS.includes(r));

export type CourseRow = {
  packageKey: string;
  title: string;
  versionLabel: string | null;
  lifecycle: CourseLifecycle;
  // Acceptance-harness record (naming rule, see admin-test-records.ts).
  testRecord: boolean;
};

export type CourseCatalogue = {
  courses: CourseRow[];
  sources: {
    packages: boolean;
    activations: boolean;
    offers: boolean;
    catalogue: boolean;
    cohorts: boolean;
  };
};

function humanise(key: string) {
  return key
    .split("-")
    .map((w) =>
      w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1),
    )
    .join(" ");
}

// All courses with their lifecycle, derived from the governed reads.
export async function getCourseCatalogue(): Promise<CourseCatalogue> {
  await requireAnyRole(COURSE_ADMINS);
  const [
    packages,
    activations,
    offerActivations,
    live,
    cohortWorkspace,
    overview,
  ] = await Promise.all([
    sourced(() => listCoursePackages()),
    sourced(() => listCommercialV1Activations()),
    sourced(() => listCommercialV1OfferActivations()),
    sourced(() => listCommercialV1Offers()),
    sourced(() => getCohortWorkspace(null)),
    sourced(() => getAdminOverview()),
  ]);

  const pkgRows: LifecyclePackage[] = packages.ok
    ? packages.data.map((p) => ({
        id: p.id,
        packageKey: p.package_key,
        packageRevision: p.package_revision,
        status: p.status,
        programmeId: p.programme_id,
        programmeVersionId: p.programme_version_id,
        createdAt: p.created_at,
        appliedAt: p.applied_at,
        publishedAt: p.published_at,
        rejectedAt: p.rejected_at,
      }))
    : [];
  const byKey = new Map<string, LifecyclePackage[]>();
  for (const p of pkgRows)
    byKey.set(p.packageKey, [...(byKey.get(p.packageKey) ?? []), p]);

  const versionTitles = new Map(
    (cohortWorkspace.ok ? cohortWorkspace.data.workspace.versions : []).map(
      (v) => [v.id, { title: v.programmeTitle, label: v.label }],
    ),
  );
  const programmeTitles = new Map(
    (overview.ok ? overview.data.programmes : []).map((p) => [p.id, p.title]),
  );
  const activationRows = activations.ok ? activations.data.activations : [];

  // Test readiness is only meaningful (and only read) for APPLIED drafts.
  const applied = [...byKey.values()]
    .map((revs) => revs.sort((a, b) => b.packageRevision - a.packageRevision))
    .flatMap((revs) => revs.filter((r) => r.status === "APPLIED").slice(0, 1))
    .slice(0, 12);
  const readiness = new Map<string, TestReadiness | null>(
    await Promise.all(
      applied.map(
        async (p) =>
          [
            p.id,
            await getCoursePackageTestStatus(p.id).then(
              (r) => r.status,
              () => null,
            ),
          ] as const,
      ),
    ),
  );

  const courses = [...byKey.entries()].map(([packageKey, revisions]) => {
    const lifecycle = deriveCourseLifecycle({
      revisions,
      activations: activationRows,
      offerActivations: offerActivations.ok ? offerActivations.data : [],
      liveOfferSlugs: live.ok ? live.data.map((o) => o.slug) : null,
      cohorts: cohortWorkspace.ok ? cohortWorkspace.data.workspace.cohorts : [],
      testReadiness: readiness.get(
        revisions.find((r) => r.status === "APPLIED")?.id ?? "",
      ),
    });
    const version = lifecycle.current.programmeVersionId
      ? versionTitles.get(lifecycle.current.programmeVersionId)
      : undefined;
    const activationTitle = activationRows.find(
      (a) => a.packageKey === packageKey,
    )?.programmeTitle;
    const title =
      version?.title ??
      activationTitle ??
      (lifecycle.current.programmeId
        ? programmeTitles.get(lifecycle.current.programmeId)
        : undefined) ??
      humanise(packageKey);
    return {
      packageKey,
      title,
      versionLabel: version?.label ?? null,
      lifecycle,
      testRecord: isAcceptanceCourse({ packageKey, title }),
    };
  });
  courses.sort((a, b) => a.title.localeCompare(b.title));

  return {
    courses,
    sources: {
      packages: packages.ok,
      activations: activations.ok,
      offers: offerActivations.ok,
      catalogue: live.ok,
      cohorts: cohortWorkspace.ok,
    },
  };
}

// Parses the "offers" commerce view subtitle "slug / cohort / 24900 GBP".
export function parseOfferRow(row: CommerceList["rows"][number]) {
  const parts = row.subtitle.split(" / ");
  const priceMatch = /^(\d+) ([A-Z]{3})$/.exec(parts[parts.length - 1] ?? "");
  return {
    id: row.id,
    course: row.title,
    slug: parts[0] ?? "",
    cohort: parts.slice(1, -1).join(" / "),
    priceAmountMinor: priceMatch ? Number(priceMatch[1]) : null,
    currency: priceMatch ? priceMatch[2] : null,
    state: row.state,
    createdAt: row.occurredAt,
  };
}

type EnrolmentTotals = {
  active: number;
  paused: number;
  completed: number;
  withdrawn: number;
  openCohorts: number;
};

// What the dashboard left out of its business figures, so the exclusion is
// visible rather than silent. Null where the source could not be read.
export type TestRecordTotals = {
  courses: number | null;
  cohorts: number | null;
  enrolments: number | null;
  orders: number | null;
  campaigns: number | null;
};

const NO_ENROLMENTS: EnrolmentTotals = {
  active: 0,
  paused: 0,
  completed: 0,
  withdrawn: 0,
  openCohorts: 0,
};

function sumEnrolments(
  cohorts: {
    status: string;
    enrolments: Omit<EnrolmentTotals, "openCohorts">;
  }[],
): EnrolmentTotals {
  return cohorts.reduce(
    (sum, c) => ({
      active: sum.active + c.enrolments.active,
      paused: sum.paused + c.enrolments.paused,
      completed: sum.completed + c.enrolments.completed,
      withdrawn: sum.withdrawn + c.enrolments.withdrawn,
      openCohorts: sum.openCohorts + (c.status === "OPEN" ? 1 : 0),
    }),
    NO_ENROLMENTS,
  );
}

// Orders view rows carry the offer slug as their subtitle.
export const isAcceptanceOrder = (row: CommerceList["rows"][number]) =>
  isAcceptanceOfferSlug(row.subtitle);

export type DashboardData = {
  actor: { displayName: string; roles: Role[] };
  courseAdmin: boolean;
  overview: Sourced<{
    programmes: number;
    learners: number;
    cohorts: number;
    staff: number;
    audit: {
      id: string;
      action: string;
      target_type: string;
      occurred_at: string;
      source: string;
    }[];
    canAudit: boolean;
  }>;
  catalogue: Sourced<CourseCatalogue>;
  // Business figures only: acceptance-test and demo records are excluded
  // here and counted separately in testRecords.
  enrolments: Sourced<EnrolmentTotals & { cohorts: number }>;
  orders: Sourced<CommerceList>;
  issues: Sourced<CommerceList>;
  campaigns: Sourced<{ active: number; archived: number }>;
  testRecords: Sourced<TestRecordTotals>;
  agents: {
    ref: string;
    roles: string[];
    ready: boolean;
    credential: string | null;
  }[];
};

export async function getDashboardData(): Promise<DashboardData> {
  const actor = await requireActor("admin");
  const courseAdmin = isCourseAdmin(actor.roles);
  const overview = await sourced(async () => {
    const o = await getAdminOverview();
    return {
      programmes: o.counts[0],
      learners: o.counts[1],
      cohorts: o.counts[2],
      staff: o.counts[3],
      audit: o.audit.slice(0, 8),
      canAudit: actor.roles.includes("PLATFORM_ADMIN"),
    };
  });
  const none = { ok: false } as const;
  if (!courseAdmin)
    return {
      actor,
      courseAdmin,
      overview,
      catalogue: none,
      enrolments: none,
      orders: none,
      issues: none,
      campaigns: none,
      testRecords: none,
      agents: [],
    };
  const [catalogue, cohorts, orders, issues, campaigns] = await Promise.all([
    sourced(() => getCourseCatalogue()),
    sourced(() => getCohortWorkspace(null)),
    sourced(() => listCommerceOperations({ view: "orders" })),
    sourced(() => listCommerceOperations({ view: "issues" })),
    sourced(() => listCommercialV1Campaigns()),
  ]);
  const profiles = describeProductionProfiles(providerCredentialReadiness());
  const allCohorts = cohorts.ok ? cohorts.data.workspace.cohorts : [];
  const businessCohorts = allCohorts.filter((c) => !isNonBusinessCohort(c));
  // Demo cohorts are excluded silently, as before; staging/acceptance
  // cohorts are excluded and counted.
  const testCohorts = allCohorts.filter(
    (c) => !c.isDemo && isNonBusinessCohort(c),
  );
  const businessCampaigns = campaigns.ok
    ? campaigns.data.filter((c) => !isAcceptanceOfferSlug(c.offerSlug))
    : [];
  return {
    actor,
    courseAdmin,
    overview,
    catalogue,
    enrolments: cohorts.ok
      ? {
          ok: true,
          data: {
            ...sumEnrolments(businessCohorts),
            cohorts: businessCohorts.length,
          },
        }
      : none,
    orders: orders.ok
      ? {
          ok: true,
          data: {
            ...orders.data,
            rows: orders.data.rows.filter((o) => !isAcceptanceOrder(o)),
          },
        }
      : none,
    issues,
    campaigns: campaigns.ok
      ? {
          ok: true,
          data: {
            active: businessCampaigns.filter((c) => c.state === "ACTIVE")
              .length,
            archived: businessCampaigns.filter((c) => c.state === "ARCHIVED")
              .length,
          },
        }
      : none,
    testRecords: {
      ok: true,
      data: {
        courses: catalogue.ok
          ? catalogue.data.courses.filter((c) => c.testRecord).length
          : null,
        cohorts: cohorts.ok ? testCohorts.length : null,
        enrolments: cohorts.ok ? sumEnrolments(testCohorts).active : null,
        orders: orders.ok
          ? orders.data.rows.filter((o) => isAcceptanceOrder(o)).length
          : null,
        campaigns: campaigns.ok
          ? campaigns.data.length - businessCampaigns.length
          : null,
      },
    },
    agents: profiles.map((p) => ({
      ref: p.ref,
      roles: p.roles,
      ready: p.readiness === "CREDENTIAL_PRESENT",
      credential: p.credential,
    })),
  };
}

export type CourseDetail = {
  row: CourseRow;
  preview: Sourced<OperatorPreview | null>;
  agents: Sourced<AgentConfigRecord[]>;
  activations: CommercialV1ActivationSummary[];
  offers: {
    slug: string;
    priceAmountMinor: number;
    currency: string;
    deliveryPlan: string;
  }[];
  testReadiness: Sourced<TestStatusResult | null>;
  sources: CourseCatalogue["sources"];
};

// One course's full workspace view, every part read independently.
export async function getCourseDetail(
  packageKey: string,
): Promise<CourseDetail | null> {
  const catalogue = await getCourseCatalogue();
  const row = catalogue.courses.find((c) => c.packageKey === packageKey);
  if (!row) return null;
  const current = row.lifecycle.current;
  const [preview, agents, activations, live, testReadiness] = await Promise.all(
    [
      sourced(async () => {
        if (current.status === "IMPORTED" || current.status === "REJECTED")
          return null;
        const result = await getCoursePackagePreview(current.id);
        const parsed = operatorPreviewSchema.safeParse(result.preview);
        return parsed.success ? parsed.data : null;
      }),
      sourced(async () =>
        current.programmeVersionId
          ? listAgentConfigs(current.programmeVersionId)
          : [],
      ),
      sourced(() => listCommercialV1Activations()),
      sourced(() => listCommercialV1Offers()),
      sourced(async () =>
        current.status === "APPLIED"
          ? getCoursePackageTestStatus(current.id)
          : null,
      ),
    ],
  );
  return {
    row,
    preview,
    agents,
    activations: activations.ok
      ? activations.data.activations.filter(
          (a) =>
            a.packageKey === current.packageKey &&
            a.packageRevision === current.packageRevision,
        )
      : [],
    offers: live.ok
      ? live.data
          .filter((o) => row.lifecycle.offerSlugs.includes(o.slug))
          .map((o) => ({
            slug: o.slug,
            priceAmountMinor: o.priceAmountMinor,
            currency: o.currency,
            deliveryPlan: o.deliveryPlan,
          }))
      : [],
    testReadiness,
    sources: catalogue.sources,
  };
}
