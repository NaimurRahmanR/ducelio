// The admin control centre's course lifecycle: Import -> Validate ->
// Configure -> Test -> Publish curriculum -> Activate delivery -> Publish
// offer -> Public catalogue. Pure: it only interprets the governed admin
// reads (course packages, activations, offer activations, the public offer
// projection and the cohort workspace). It never decides authority; every
// stage's real gate stays in its own database RPC.

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

export type StageId =
  | "import"
  | "validate"
  | "configure"
  | "test"
  | "publish-curriculum"
  | "activate"
  | "publish-offer"
  | "catalogue";

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
};

export type CourseLifecycle = {
  packageKey: string;
  current: LifecyclePackage;
  revisions: LifecyclePackage[];
  activations: LifecycleActivation[];
  cohorts: (LifecycleCohort & { purpose: CohortPurpose })[];
  offerSlugs: string[];
  liveSlugs: string[];
  stages: LifecycleStage[];
  headline: string;
  stage: StageId;
  stageState: StageState;
};

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

  const focus =
    stages.find((x) => x.state === "attention") ??
    stages.find((x) => x.state === "action") ??
    stages.find((x) => x.state === "approval") ??
    stages.find((x) => x.state === "blocked") ??
    stages[stages.length - 1];

  return {
    packageKey: current.packageKey,
    current,
    revisions,
    activations,
    cohorts,
    offerSlugs,
    liveSlugs,
    stages,
    headline:
      focus.state === "complete" ? "Live in the catalogue" : focus.summary,
    stage: focus.id,
    stageState: focus.state,
  };
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
