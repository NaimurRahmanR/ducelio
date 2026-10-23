// The admin control centre's course lifecycle. Pure: it only interprets the
// governed admin reads (course packages, activations, offer activations, the
// public offer projections, the cohort workspace and the Academy package
// register). It never decides authority; every stage's real gate stays in
// its own database RPC.
//
// One curriculum can have two independent delivery tracks:
//  - Organisation (B2B): Import -> Validate -> Configure -> Test -> Publish
//    curriculum -> Activate delivery (cohort) -> Publish offer -> Public
//    catalogue.
//  - Academy (B2C, individual learning): Upload -> Validate -> Review ->
//    Prepare curriculum -> Publish course and offer -> Learner access ->
//    Approval gates -> Public sale. No cohort, instructor or activation.
// The track is never guessed from a title or key: a course is an Academy
// course only when an Academy package's recorded curriculum import is one
// of the course's own revisions (list_academy_course_packages
// curriculumImport.id), and it has organisation delivery only when an
// activation, an organisation offer or a non-demo cohort exists for it.

export const PACKAGE_STATUSES = [
  "IMPORTED",
  "VALIDATED",
  "APPLIED",
  "PUBLISHED",
  "REJECTED",
] as const;

export type LifecyclePackage = {
  id: string;
  packageKey: string;
  packageRevision: number;
  status: string;
  programmeId: string | null;
  programmeVersionId: string | null;
  createdAt: string;
  appliedAt: string | null;
  publishedAt: string | null;
  rejectedAt: string | null;
};

export type LifecycleActivation = {
  activationId: string;
  packageKey: string;
  packageRevision: number;
  cohortTitle: string;
  cohortStartsOn: string;
  createdAt: string;
  gradingPolicyPublished: boolean;
  resultPolicyPublished: boolean;
  labPracticalsTotal: number;
  labPracticalsConfigured: number;
};

export type LifecycleOfferActivation = {
  activationId: string;
  publishedOfferSlug: string | null;
};

export type LifecycleCohort = {
  id: string;
  title: string;
  startsOn: string;
  endsOn: string | null;
  status: "OPEN" | "CLOSED" | "COMPLETED";
  programmeVersionId: string;
  isDemo: boolean;
  enrolments: {
    active: number;
    paused: number;
    completed: number;
    withdrawn: number;
  };
  activationId: string | null;
  publishedOfferSlug: string | null;
};

export type TestReadiness =
  "NOT_TESTED" | "FAILED" | "PASSED_CURRENT" | "PASSED_STALE";

export type StageState =
  | "complete"
  | "action" // an administrator can take the next step now
  | "approval" // ready, waiting for an explicit administrator decision
  | "blocked" // an earlier stage must finish first
  | "attention"; // something is inconsistent and needs investigation

export type OrganisationStageId =
  | "import"
  | "validate"
  | "configure"
  | "test"
  | "publish-curriculum"
  | "activate"
  | "publish-offer"
  | "catalogue";

export type AcademyStageId =
  | "academy-upload"
  | "academy-validate"
  | "academy-review"
  | "academy-curriculum"
  | "academy-publish"
  | "academy-access"
  | "academy-gates"
  | "academy-sale";

export type StageId = OrganisationStageId | AcademyStageId;

export type LifecycleStage = {
  id: StageId;
  label: string;
  state: StageState;
  summary: string;
  next?: { label: string; href: string };
};

// A cohort's purpose is not recorded in the schema, so it is never assumed.
// "staging" is only ever a warning derived from the cohort's own title; an
// unflagged cohort is still "unverified", never "approved for sale".
export type CohortPurpose = "DEMO" | "LIKELY_STAGING" | "UNVERIFIED";
const STAGING_TITLE =
  /\b(acceptance|staging|sandbox|smoke|qa|dry[- ]?run|rehearsal)\b|\btest(ing)? cohort\b/i;

export function cohortPurpose(cohort: {
  title: string;
  isDemo: boolean;
}): CohortPurpose {
  if (cohort.isDemo) return "DEMO";
  if (STAGING_TITLE.test(cohort.title)) return "LIKELY_STAGING";
  return "UNVERIFIED";
}

export const STAGE_LABELS: Record<StageId, string> = {
  import: "Import",
  validate: "Validate",
  configure: "Configure",
  test: "Test",
  "publish-curriculum": "Publish curriculum",
  activate: "Activate delivery",
  "publish-offer": "Publish offer",
  catalogue: "Public catalogue",
  "academy-upload": "Upload package",
  "academy-validate": "Validate package",
  "academy-review": "Review content",
  "academy-curriculum": "Prepare curriculum",
  "academy-publish": "Publish course and offer",
  "academy-access": "Learner access",
  "academy-gates": "Approval gates",
  "academy-sale": "Public sale and catalogue",
};

export const ORGANISATION_STAGE_IDS: readonly OrganisationStageId[] = [
  "import",
  "validate",
  "configure",
  "test",
  "publish-curriculum",
  "activate",
  "publish-offer",
  "catalogue",
];
export const ACADEMY_STAGE_IDS: readonly AcademyStageId[] = [
  "academy-upload",
  "academy-validate",
  "academy-review",
  "academy-curriculum",
  "academy-publish",
  "academy-access",
  "academy-gates",
  "academy-sale",
];

// "ACADEMY": individual learners (B2C) only. "ORGANISATION": cohort
// delivery (B2B) only. "BOTH": one shared curriculum with both tracks.
export type CourseDelivery = "ACADEMY" | "ORGANISATION" | "BOTH";
export const DELIVERY_LABELS: Record<CourseDelivery, string> = {
  ACADEMY: "Academy · individual learners (B2C)",
  ORGANISATION: "Organisation · cohort delivery (B2B)",
  BOTH: "Academy (B2C) and Organisation (B2B)",
};

export type AcademyLifecycleFormat = {
  formatId: string;
  weeks: number;
  sessionMinutes: number;
  minStudyDays: number;
  maxStudyDays: number;
  amountMinor: number;
};

// One Academy package from the admin register, reduced to what the
// lifecycle reads. formats/currency are undefined when the database does
// not return the offer terms (migration 066 not applied).
export type LifecycleAcademyPackage = {
  id: string;
  packageRevision: number;
  status: "UPLOADED" | "VALIDATED" | "PUBLISHED" | "REJECTED";
  pendingDecisions: string[];
  curriculumImport: { id: string; status: string } | null;
  course: {
    id: string;
    offerId: string | null;
    slug: string | null;
    offerState: "PUBLISHED" | "ARCHIVED" | null;
    saleMode: "REVIEW_ONLY" | "PUBLIC_SALE" | null;
    currency?: string | null;
    formats?: AcademyLifecycleFormat[];
  } | null;
};

export type AcademyTrack = {
  packageId: string;
  packageRevision: number;
  packageStatus: LifecycleAcademyPackage["status"];
  pendingDecisions: string[];
  courseId: string | null;
  offerId: string | null;
  slug: string | null;
  offerState: "PUBLISHED" | "ARCHIVED" | null;
  saleMode: "REVIEW_ONLY" | "PUBLIC_SALE" | null;
  currency: string | null;
  // null: the offer terms could not be read (see LifecycleAcademyPackage).
  formats: AcademyLifecycleFormat[] | null;
  // In the public Academy catalogue projection; null when unreadable.
  listed: boolean | null;
  // On public sale and confirmed in the Academy catalogue.
  publicSale: boolean;
  href: string;
};

export type CourseLifecycle = {
  packageKey: string;
  delivery: CourseDelivery;
  current: LifecyclePackage;
  revisions: LifecyclePackage[];
  activations: LifecycleActivation[];
  cohorts: (LifecycleCohort & { purpose: CohortPurpose })[];
  // Organisation (B2B) offers, and those in the public course catalogue.
  offerSlugs: string[];
  liveSlugs: string[];
  // The primary track: Academy stages for ACADEMY/BOTH, else organisation.
  stages: LifecycleStage[];
  // The organisation track; null for an Academy-only course.
  organisationStages: LifecycleStage[] | null;
  academy: AcademyTrack | null;
  headline: string;
  stage: StageId;
  stageState: StageState;
};

export const academyEngineering = (packageId: string) =>
  `/admin/academy-course-engineering?packageId=${packageId}`;

// True when the course can be bought publicly on either track.
export const isPubliclyLive = (life: CourseLifecycle) =>
  life.liveSlugs.length > 0 || life.academy?.publicSale === true;

export function academyFormatPrice(
  format: AcademyLifecycleFormat,
  currency: string | null,
) {
  return currency
    ? `${currency} ${(format.amountMinor / 100).toFixed(2)}`
    : `${format.amountMinor} (minor units)`;
}

const engineering = (importId: string) =>
  `/admin/course-engineering?importId=${importId}`;

function stage(
  id: StageId,
  state: StageState,
  summary: string,
  next?: { label: string; href: string },
): LifecycleStage {
  return { id, label: STAGE_LABELS[id], state, summary, next };
}

// The revision that represents the course: the highest non-rejected one, or
// the highest overall when every revision was rejected.
export function currentRevision(revisions: readonly LifecyclePackage[]) {
  const sorted = [...revisions].sort(
    (a, b) => b.packageRevision - a.packageRevision,
  );
  return sorted.find((r) => r.status !== "REJECTED") ?? sorted[0];
}

export function deriveCourseLifecycle(input: {
  revisions: readonly LifecyclePackage[];
  activations: readonly LifecycleActivation[];
  offerActivations: readonly LifecycleOfferActivation[];
  liveOfferSlugs: readonly string[] | null; // null: catalogue unreadable
  cohorts: readonly LifecycleCohort[];
  testReadiness?: TestReadiness | null;
  // The Academy package register; null or absent when it could not be read.
  academyPackages?: readonly LifecycleAcademyPackage[] | null;
  // Slugs in the public Academy catalogue; null when unreadable.
  academyCatalogueSlugs?: readonly string[] | null;
}): CourseLifecycle {
  const current = currentRevision(input.revisions);
  const revisions = [...input.revisions].sort(
    (a, b) => b.packageRevision - a.packageRevision,
  );
  const activations = input.activations.filter(
    (a) =>
      a.packageKey === current.packageKey &&
      a.packageRevision === current.packageRevision,
  );
  const activationIds = new Set(activations.map((a) => a.activationId));
  const offerSlugs = input.offerActivations
    .filter((o) => activationIds.has(o.activationId) && o.publishedOfferSlug)
    .map((o) => o.publishedOfferSlug as string);
  const liveSlugs = offerSlugs.filter((slug) =>
    input.liveOfferSlugs?.includes(slug),
  );
  const cohorts = input.cohorts
    .filter(
      (c) =>
        current.programmeVersionId &&
        c.programmeVersionId === current.programmeVersionId,
    )
    .map((c) => ({ ...c, purpose: cohortPurpose(c) }));

  const s = current.status;
  const rev = `Revision ${current.packageRevision}`;
  const stages: LifecycleStage[] = [];

  stages.push(stage("import", "complete", `${rev} imported.`, undefined));

  if (s === "REJECTED") {
    stages.push(
      stage(
        "validate",
        "attention",
        `${rev} was rejected. Import a corrected revision to continue.`,
        { label: "Open course engineering", href: engineering(current.id) },
      ),
    );
  } else if (s === "IMPORTED") {
    stages.push(
      stage("validate", "action", `${rev} is staged and needs validation.`, {
        label: "Validate package",
        href: engineering(current.id),
      }),
    );
  } else {
    stages.push(stage("validate", "complete", `${rev} passed validation.`));
  }

  const ready = input.testReadiness === "PASSED_CURRENT";
  if (s === "PUBLISHED") {
    stages.push(
      stage(
        "configure",
        "complete",
        "Applied and configured; publication passed its configuration gate.",
      ),
    );
    stages.push(
      stage(
        "test",
        "complete",
        "The pre-publication test gate passed before publication.",
      ),
    );
    stages.push(
      stage(
        "publish-curriculum",
        "complete",
        `${rev} is the published curriculum. No new upload is needed.`,
      ),
    );
  } else if (s === "APPLIED") {
    stages.push(
      stage(
        "configure",
        "complete",
        "Applied as a draft curriculum. Agent settings can still be adjusted before testing.",
        { label: "Review agent settings", href: engineering(current.id) },
      ),
    );
    stages.push(
      ready
        ? stage(
            "test",
            "complete",
            "A current pre-publication test passed for this exact state.",
          )
        : stage(
            "test",
            "action",
            input.testReadiness === "FAILED"
              ? "The latest pre-publication test failed. Review the failure and re-run it."
              : input.testReadiness === "PASSED_STALE"
                ? "The last passing test no longer matches the current configuration. Re-run it."
                : input.testReadiness === "NOT_TESTED"
                  ? "No pre-publication test has run for this state yet."
                  : "Test readiness could not be read. Open course engineering to check.",
            {
              label: "Run pre-publication test",
              href: engineering(current.id),
            },
          ),
    );
    stages.push(
      ready
        ? stage(
            "publish-curriculum",
            "approval",
            "Ready to publish. Publication is an explicit administrator decision.",
            { label: "Review and publish", href: engineering(current.id) },
          )
        : stage(
            "publish-curriculum",
            "blocked",
            "Publication waits for a current passing test.",
          ),
    );
  } else {
    stages.push(
      s === "VALIDATED"
        ? stage(
            "configure",
            "action",
            "Validated. Apply it as a draft curriculum, then configure agents.",
            { label: "Apply and configure", href: engineering(current.id) },
          )
        : stage("configure", "blocked", "Waits for validation."),
    );
    stages.push(stage("test", "blocked", "Waits for configuration."));
    stages.push(
      stage("publish-curriculum", "blocked", "Waits for a passing test."),
    );
  }

  const published = s === "PUBLISHED";
  if (activations.length > 0) {
    const a = activations[0];
    const policiesReady = a.gradingPolicyPublished && a.resultPolicyPublished;
    stages.push(
      stage(
        "activate",
        policiesReady ? "complete" : "attention",
        policiesReady
          ? `Delivery activated for “${a.cohortTitle}”.`
          : `Delivery activated for “${a.cohortTitle}”, but its grading or result policy is not published yet.`,
        policiesReady
          ? undefined
          : {
              label: "Complete policy setup",
              href: `/admin/activation/policy?activationId=${a.activationId}`,
            },
      ),
    );
  } else if (published) {
    stages.push(
      stage(
        "activate",
        "action",
        activationAdvice(rev, cohorts),
        cohorts.some(
          (c) => c.purpose === "UNVERIFIED" && c.status !== "COMPLETED",
        )
          ? { label: "Choose a delivery cohort", href: "/admin/activation" }
          : { label: "Create a delivery cohort", href: "/admin/cohorts" },
      ),
    );
  } else {
    stages.push(
      stage("activate", "blocked", "Waits for the curriculum to be published."),
    );
  }

  if (offerSlugs.length > 0) {
    stages.push(
      stage(
        "publish-offer",
        "complete",
        `Offer “${offerSlugs[0]}” is published.`,
      ),
    );
  } else if (activations.length > 0) {
    stages.push(
      stage(
        "publish-offer",
        "approval",
        "Activated and ready for a commercial offer. Setting a price is an explicit administrator decision.",
        { label: "Publish an offer", href: "/admin/sales#publish-offer" },
      ),
    );
  } else {
    stages.push(
      stage(
        "publish-offer",
        "blocked",
        "An offer needs an activated delivery first.",
      ),
    );
  }

  if (liveSlugs.length > 0) {
    stages.push(
      stage("catalogue", "complete", "Listed in the public course catalogue.", {
        label: "View public page",
        href: `/courses/${liveSlugs[0]}`,
      }),
    );
  } else if (offerSlugs.length > 0) {
    stages.push(
      stage(
        "catalogue",
        "attention",
        input.liveOfferSlugs === null
          ? "The public catalogue could not be read, so its listing is unconfirmed."
          : "The offer is published but is not in the public catalogue projection.",
      ),
    );
  } else {
    stages.push(
      stage("catalogue", "blocked", "Appears once an offer is published."),
    );
  }

  const base = {
    packageKey: current.packageKey,
    current,
    revisions,
    activations,
    cohorts,
    offerSlugs,
    liveSlugs,
  };
  const academyPackage = linkedAcademyPackage(
    revisions,
    current,
    input.academyPackages ?? [],
  );
  const organisation =
    activations.length > 0 ||
    offerSlugs.length > 0 ||
    cohorts.some((c) => c.purpose !== "DEMO");

  if (!academyPackage) {
    // An unreadable Academy register must not turn an Academy course into
    // cohort advice: without it the delivery track is unconfirmed.
    const i = stages.findIndex((x) => x.id === "activate");
    if (
      input.academyPackages === null &&
      !organisation &&
      i >= 0 &&
      stages[i].state === "action"
    )
      stages[i] = stage(
        "activate",
        "attention",
        "The Academy course register could not be read, so whether this curriculum is delivered to individual learners (Academy) or through cohorts is unconfirmed. Confirm the delivery track before creating a cohort.",
        {
          label: "Open Academy Course Engineering",
          href: "/admin/academy-course-engineering",
        },
      );
    const focus = focusOf(stages);
    return {
      ...base,
      delivery: "ORGANISATION",
      stages,
      organisationStages: stages,
      academy: null,
      headline:
        focus.state === "complete" ? "Live in the catalogue" : focus.summary,
      stage: focus.id,
      stageState: focus.state,
    };
  }

  const academy = academyLifecycle(
    academyPackage,
    input.academyCatalogueSlugs ?? null,
  );
  const focus = focusOf(academy.stages);
  return {
    ...base,
    delivery: organisation ? "BOTH" : "ACADEMY",
    stages: academy.stages,
    organisationStages: organisation ? stages : null,
    academy: academy.track,
    headline: academyHeadline(academy.track, focus),
    stage: focus.id,
    stageState: focus.state,
  };
}

function focusOf(stages: readonly LifecycleStage[]) {
  return (
    stages.find((x) => x.state === "attention") ??
    stages.find((x) => x.state === "action") ??
    stages.find((x) => x.state === "approval") ??
    stages.find((x) => x.state === "blocked") ??
    stages[stages.length - 1]
  );
}

// The Academy package whose recorded curriculum import is one of this
// course's revisions: the one for the current revision, else the latest
// linked one. Matched by import id only, never by key or title.
function linkedAcademyPackage(
  revisions: readonly LifecyclePackage[],
  current: LifecyclePackage,
  packages: readonly LifecycleAcademyPackage[],
) {
  const ids = new Set(revisions.map((r) => r.id));
  const linked = packages
    .filter((p) => p.curriculumImport && ids.has(p.curriculumImport.id))
    .sort((a, b) => b.packageRevision - a.packageRevision);
  return linked.find((p) => p.curriculumImport?.id === current.id) ?? linked[0];
}

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

function academyHeadline(track: AcademyTrack, focus: LifecycleStage) {
  if (focus.state === "attention" || focus.state === "action")
    return focus.summary;
  if (track.publicSale) return "On public sale in the Academy catalogue";
  if (track.offerState === "PUBLISHED" && track.saleMode === "REVIEW_ONLY")
    return track.pendingDecisions.length > 0
      ? `Published for review only — not on public sale. ${plural(
          track.pendingDecisions.length,
          "pending decision",
          "pending decisions",
        )} must be resolved first.`
      : "Published for review only — not on public sale. Opening sale is an owner decision.";
  return focus.summary;
}

function academyLifecycle(
  pkg: LifecycleAcademyPackage,
  catalogueSlugs: readonly string[] | null,
): { track: AcademyTrack; stages: LifecycleStage[] } {
  const href = academyEngineering(pkg.id);
  const open = { label: "Open Academy Course Engineering", href };
  const rev = `Revision ${pkg.packageRevision}`;
  const course = pkg.course;
  const offerPublished = course?.offerState === "PUBLISHED";
  const listed =
    catalogueSlugs === null
      ? null
      : Boolean(course?.slug && catalogueSlugs.includes(course.slug));
  const publicSale =
    offerPublished && course?.saleMode === "PUBLIC_SALE" && listed === true;
  const track: AcademyTrack = {
    packageId: pkg.id,
    packageRevision: pkg.packageRevision,
    packageStatus: pkg.status,
    pendingDecisions: [...pkg.pendingDecisions],
    courseId: course?.id ?? null,
    offerId: course?.offerId ?? null,
    slug: course?.slug ?? null,
    offerState: course?.offerState ?? null,
    saleMode: course?.saleMode ?? null,
    currency: course?.currency ?? null,
    formats: course?.formats ?? (course?.offerId ? null : []),
    listed,
    publicSale,
    href,
  };

  const stages: LifecycleStage[] = [
    stage(
      "academy-upload",
      "complete",
      `${rev} of the Academy package is uploaded.`,
    ),
  ];
  stages.push(
    pkg.status === "REJECTED"
      ? stage(
          "academy-validate",
          "attention",
          `${rev} was rejected. Upload a corrected revision to continue.`,
          open,
        )
      : pkg.status === "UPLOADED"
        ? stage("academy-validate", "action", `${rev} needs validation.`, open)
        : stage(
            "academy-validate",
            "complete",
            `${rev} passed the Academy package validator.`,
          ),
  );

  const curriculum = pkg.curriculumImport;
  stages.push(
    curriculum
      ? stage(
          "academy-review",
          "complete",
          "Content reviewed and approved for curriculum preparation.",
        )
      : stage("academy-review", "blocked", "Waits for a valid package."),
  );
  const curriculumPublished = curriculum?.status === "PUBLISHED";
  stages.push(
    curriculumPublished
      ? stage(
          "academy-curriculum",
          "complete",
          "The curriculum passed its pre-publication test and is published.",
        )
      : curriculum?.status === "REJECTED"
        ? stage(
            "academy-curriculum",
            "attention",
            "The curriculum import was rejected.",
            open,
          )
        : stage(
            "academy-curriculum",
            "action",
            "Curriculum preparation has not finished. Re-run it from Academy Course Engineering.",
            open,
          ),
  );

  const formats =
    track.formats === null
      ? "formats whose prices could not be read"
      : plural(track.formats.length, "priced format", "priced formats");
  stages.push(
    offerPublished
      ? stage(
          "academy-publish",
          "complete",
          `Course published as Academy offer “${track.slug}” with ${formats}.`,
        )
      : course?.offerState === "ARCHIVED"
        ? stage(
            "academy-publish",
            "attention",
            `Academy offer “${track.slug}” is archived, so no learner can be granted or buy access.`,
            open,
          )
        : curriculumPublished && pkg.status !== "REJECTED"
          ? stage(
              "academy-publish",
              "approval",
              "Ready to publish. Setting the format prices is an explicit administrator decision.",
              open,
            )
          : stage(
              "academy-publish",
              "blocked",
              "Waits for the curriculum to be published.",
            ),
  );

  stages.push(
    offerPublished
      ? stage(
          "academy-access",
          "complete",
          "Individual learning: each learner confirms a personal schedule in an offered format. No cohort, instructor or delivery activation is needed.",
        )
      : stage(
          "academy-access",
          "blocked",
          "Learners can be granted or buy access once the offer is published.",
        ),
  );

  const pending = track.pendingDecisions;
  stages.push(
    pending.length > 0
      ? stage(
          "academy-gates",
          "approval",
          `${plural(pending.length, "pending decision", "pending decisions")} must be resolved by a new package revision before public sale: ${pending.join(", ")}.`,
          open,
        )
      : stage(
          "academy-gates",
          "complete",
          "No pending academic or commercial decisions in this revision.",
        ),
  );

  stages.push(
    publicSale
      ? stage(
          "academy-sale",
          "complete",
          "On public sale and listed in the Academy catalogue.",
          { label: "View public page", href: `/academy/${track.slug}` },
        )
      : offerPublished && track.saleMode === "PUBLIC_SALE"
        ? stage(
            "academy-sale",
            "attention",
            listed === null
              ? "Public sale is open, but the Academy catalogue could not be read, so its listing is unconfirmed."
              : "Public sale is open, but the offer is not in the Academy catalogue projection.",
            open,
          )
        : offerPublished && pending.length === 0
          ? stage(
              "academy-sale",
              "approval",
              "Review only: not on public sale. Opening public sale is an explicit owner decision.",
              open,
            )
          : stage(
              "academy-sale",
              "blocked",
              offerPublished
                ? "Review only: not on public sale and not in the public catalogue while decisions are pending."
                : "Public sale needs a published offer and resolved decisions.",
            ),
  );

  return { track, stages };
}

function activationAdvice(
  rev: string,
  cohorts: readonly (LifecycleCohort & { purpose: CohortPurpose })[],
) {
  const base = `${rev} is published, but no delivery is activated, so there is nothing to sell yet. Do not upload the package again.`;
  const usable = cohorts.filter((c) => c.status !== "COMPLETED");
  const staging = usable.filter((c) => c.purpose === "LIKELY_STAGING");
  const unverified = usable.filter((c) => c.purpose === "UNVERIFIED");
  if (usable.length === 0)
    return `${base} No open cohort exists for this curriculum: create a delivery cohort, then activate it.`;
  const parts = [base];
  if (staging.length > 0)
    parts.push(
      `${staging.map((c) => `“${c.title}”`).join(", ")} ${
        staging.length === 1 ? "is" : "are"
      } a staging or acceptance cohort and must not be used for paying learners.`,
    );
  parts.push(
    unverified.length > 0
      ? "Cohort purpose is not recorded, so no cohort is chosen for you: select the delivery cohort explicitly and confirm it is meant for paying learners."
      : "Create a dedicated delivery cohort, then activate it.",
  );
  return parts.join(" ");
}
