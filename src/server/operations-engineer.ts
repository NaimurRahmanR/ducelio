import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { requireAnyRole } from "./identity";
import {
  archiveCommercialV1Campaign,
  archiveCommercialV1Offer,
  createCommercialV1Campaign,
  listCommercialV1Campaigns,
  listCommercialV1OfferActivations,
  listCommercialV1Offers,
  publishCommercialV1Offer,
} from "./commercial-v1-commerce";
import { listCommerceOperations } from "./commercial-v1-commerce/operations";
import { listCommercialV1Activations } from "./course-activation";
import { changeCohortStatus, getCohortWorkspace } from "./cohorts";
import {
  getCoursePackageTestStatus,
  listCoursePackages,
  runCoursePackageTest,
} from "./course-engineering";
import {
  describeProductionProfiles,
  providerCredentialReadiness,
} from "./agent-control-plane";
import {
  resolveAdapterForProfile,
  resolvePlatformRuntimeProfile,
} from "./academic-runtime/profile-registry";
import { runGovernedProviderExecution } from "./academic-runtime/runtime";
import { getCourseCatalogue, parseOfferRow } from "./admin-control-centre";
import {
  OPERATIONS_ENGINEER_CAPABILITY,
  OPERATIONS_ENGINEER_PROVIDER_ROLE,
  DUPLICATE_PROTECTION,
  OPERATIONS_ENGINEER_DISABLED,
  OPERATION_ACTIONS,
  isOperationEnabled,
  operationActionIdSchema,
  parseActionInput,
  parseInterpreterOutput,
  type ChoiceSource,
  type OperationActionId,
} from "@/domain/operations-engineer";
import {
  academyFormatPrice,
  cohortPurpose,
  DELIVERY_LABELS,
} from "@/domain/admin-course-lifecycle";
import { formatOfferPrice } from "@/domain/commercial-v1-commerce";
import { DELIVERY_PLAN_DEFINITIONS } from "@/domain/commercial-v1-launch";
import type { DeliveryPlan } from "@/domain/commercial-v1-launch";
import {
  isAcceptanceOffer,
  isAcceptanceOfferSlug,
} from "@/domain/admin-test-records";

const TEST_LABEL_NOTE =
  "Rows marked “acceptance test” are shared-environment test records, recognised by their naming; they are not business sales.";

// The Operations Engineer execution plane. Natural-language request ->
// intent (AI, when configured) -> authoritative state read -> typed,
// validated proposal -> explicit administrator confirmation -> execution
// through the existing governed service AS THAT ADMINISTRATOR -> verification
// re-read -> receipt. The model holds no authority at any point: it only
// names an action from the closed registry, and its arguments are untrusted
// input re-validated exactly like a typed form.

const ADMINS = ["ACADEMIC_ADMIN", "PLATFORM_ADMIN"] as const;
const PROPOSAL_TTL_MS = 15 * 60 * 1000;

export type Option = { value: string; label: string; warning?: string };
export type OperationOptions = Record<ChoiceSource, Option[]>;
export type ReadTable = {
  title: string;
  columns: string[];
  rows: string[][];
  note?: string;
};
export type Check = { ok: boolean; text: string; blocking: boolean };
export type DisplayLine = { label: string; value: string };

export type Proposal = {
  actionId: OperationActionId;
  title: string;
  raw: Record<string, string>;
  display: DisplayLine[];
  checks: Check[];
  blocked: boolean;
  consequence: string;
  recovery: string;
  duplicateProtection: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  proposalId: string;
};

export type PrepareResult =
  | { status: "INVALID"; actionId: OperationActionId; issues: string[] }
  | { status: "READ_RESULT"; actionId: OperationActionId; table: ReadTable }
  | { status: "PROPOSAL"; proposal: Proposal }
  | { status: "UNAVAILABLE"; actionId: OperationActionId; message: string };

export type Receipt = {
  status:
    | "SUCCEEDED"
    | "ALREADY_DONE"
    | "FAILED"
    | "STATE_CHANGED"
    | "EXPIRED"
    | "DUPLICATE"
    | "REFUSED"
    | "UNCERTAIN";
  actionId: OperationActionId;
  title: string;
  reference: string;
  executedAt: string | null;
  display: DisplayLine[];
  outcome: string;
  verified: boolean | null;
  verification: string;
  recovery: string;
};

export type InterpretResult =
  | { status: "AI_NOT_CONFIGURED"; message: string }
  | { status: "AI_FAILED"; message: string }
  | { status: "NO_ACTION"; explanation: string }
  | {
      status: "INTERPRETED";
      explanation: string;
      actionId: OperationActionId;
      prepared: PrepareResult;
      raw: Record<string, string>;
    };

// ---------------------------------------------------------------------------
// Authoritative reads used for options, proposals and verification.
// ---------------------------------------------------------------------------

async function readCommerce() {
  const [offerActivations, activations, live, campaigns] = await Promise.all([
    listCommercialV1OfferActivations(),
    listCommercialV1Activations(),
    listCommercialV1Offers().catch(() => null),
    listCommercialV1Campaigns(),
  ]);
  return {
    offerActivations,
    activations: activations.activations,
    live,
    campaigns,
  };
}

// Real records first; acceptance-test records after them, labelled, so a
// choice list never leads with test traffic.
function businessFirst(options: (Option & { test: boolean })[]): Option[] {
  return [
    ...options.filter((o) => !o.test),
    ...options.filter((o) => o.test),
  ].map(({ test, ...o }) =>
    test ? { ...o, label: `${o.label} (acceptance test)` } : o,
  );
}

export async function getOperationOptions(): Promise<OperationOptions> {
  await requireAnyRole(ADMINS);
  const [catalogue, commerce, cohorts, packages] = await Promise.all([
    getCourseCatalogue().catch(() => null),
    readCommerce().catch(() => null),
    getCohortWorkspace(null).catch(() => null),
    listCoursePackages().catch(() => []),
  ]);
  const titleByKey = new Map(
    (catalogue?.courses ?? []).map((c) => [c.packageKey, c.title]),
  );
  return {
    courses: businessFirst(
      (catalogue?.courses ?? []).map((c) => ({
        value: c.packageKey,
        label: `${c.title} — revision ${c.lifecycle.current.packageRevision}`,
        test: c.testRecord,
      })),
    ),
    appliedPackages: packages
      .filter((p) => p.status === "APPLIED")
      .map((p) => ({
        value: p.id,
        label: `${titleByKey.get(p.package_key) ?? p.package_key} — revision ${p.package_revision} (draft)`,
      })),
    activationsWithoutOffer: (commerce?.offerActivations ?? [])
      .filter((a) => !a.publishedOfferSlug)
      .map((a) => {
        const purpose = cohortPurpose({ title: a.cohortTitle, isDemo: false });
        return {
          value: a.activationId,
          label: `${a.programmeTitle} — ${a.cohortTitle} (starts ${a.cohortStartsOn})`,
          warning:
            purpose === "LIKELY_STAGING"
              ? "Staging or acceptance cohort: not for paying learners."
              : undefined,
        };
      }),
    publishedOffers: businessFirst(
      (commerce?.offerActivations ?? [])
        .filter((a) => a.publishedOfferSlug)
        .map((a) => ({
          value: a.publishedOfferSlug as string,
          label: `${a.programmeTitle} — ${a.cohortTitle} (/courses/${a.publishedOfferSlug})`,
          test: isAcceptanceOffer({
            slug: a.publishedOfferSlug,
            course: a.programmeTitle,
            cohort: a.cohortTitle,
          }),
        })),
    ),
    activeCampaigns: businessFirst(
      (commerce?.campaigns ?? [])
        .filter((c) => c.state === "ACTIVE")
        .map((c) => ({
          value: c.code,
          label: `${c.code} — ${c.offerSlug}`,
          test: isAcceptanceOfferSlug(c.offerSlug),
        })),
    ),
    cohorts: (cohorts?.workspace.cohorts ?? [])
      .filter((c) => c.status !== "COMPLETED" && !c.isDemo)
      .map((c) => ({
        value: c.id,
        label: `${c.title} — ${c.programmeTitle} (${c.status.toLowerCase()})`,
        warning:
          cohortPurpose(c) === "LIKELY_STAGING"
            ? "Staging or acceptance cohort."
            : undefined,
      })),
  };
}

// ---------------------------------------------------------------------------
// Read-only inspections: executed immediately, no confirmation needed.
// ---------------------------------------------------------------------------

const money = (minor: number, currency: string) =>
  formatOfferPrice(minor, currency);

async function runRead(
  id: OperationActionId,
  input: Record<string, unknown>,
): Promise<ReadTable> {
  switch (id) {
    case "inspect_course": {
      const catalogue = await getCourseCatalogue();
      const course = catalogue.courses.find(
        (c) => c.packageKey === input.packageKey,
      );
      if (!course)
        return {
          title: "Course not found",
          columns: ["Result"],
          rows: [["No course package with that key is visible to you."]],
        };
      const life = course.lifecycle;
      if (life.individual) {
        // Individual learning: never cohort advice. Cohort-delivery stages
        // are listed separately only when that model is also recorded.
        const a = life.individual;
        const cohortStages = life.cohortStages ?? [];
        const formats =
          a.formats === null
            ? "Format prices could not be read."
            : a.formats.length
              ? `Formats: ${a.formats
                  .map(
                    (f) =>
                      `${f.formatId} ${f.weeks} weeks ${academyFormatPrice(f, a.currency)}`,
                  )
                  .join("; ")}.`
              : "";
        return {
          title: `${course.title} — revision ${life.current.packageRevision} · ${DELIVERY_LABELS[life.delivery]}`,
          columns: ["Stage", "Status", "Detail"],
          rows: [
            ...life.stages.map((s) => [
              `Individual learning: ${s.label}`,
              STATE_WORDS[s.state],
              s.summary,
            ]),
            ...cohortStages.map((s) => [
              `Cohort delivery: ${s.label}`,
              STATE_WORDS[s.state],
              s.summary,
            ]),
          ],
          note: [
            life.headline,
            a.offerId
              ? `Individual-learning offer “${a.slug}” (${a.saleMode === "PUBLIC_SALE" ? "public sale" : "review only, not on public sale"}).`
              : "No individual-learning offer yet.",
            formats,
            "Individual learning: learners confirm their own schedules; no cohort is needed for this delivery model.",
            `Manage it in Academy Course Engineering: ${a.href}`,
          ]
            .filter(Boolean)
            .join(" "),
        };
      }
      return {
        title: `${course.title} — revision ${course.lifecycle.current.packageRevision}`,
        columns: ["Stage", "Status", "Detail"],
        rows: course.lifecycle.stages.map((s) => [
          s.label,
          STATE_WORDS[s.state],
          s.summary,
        ]),
        note: course.lifecycle.cohorts.length
          ? `Cohorts for this curriculum: ${course.lifecycle.cohorts
              .map(
                (c) =>
                  `${c.title} (${c.status.toLowerCase()}${c.purpose === "LIKELY_STAGING" ? ", staging" : ""})`,
              )
              .join("; ")}.`
          : "No cohort exists for this curriculum version.",
      };
    }
    case "list_offers": {
      const c = await readCommerce();
      return {
        title: "Activated deliveries and offers",
        columns: ["Course", "Cohort", "Offer", "Public price"],
        rows: c.offerActivations.map((a) => {
          const live = c.live?.find((o) => o.slug === a.publishedOfferSlug);
          const test = isAcceptanceOffer({
            slug: a.publishedOfferSlug,
            course: a.programmeTitle,
            cohort: a.cohortTitle,
          });
          return [
            a.programmeTitle + (test ? " (acceptance test)" : ""),
            `${a.cohortTitle} (starts ${a.cohortStartsOn})`,
            a.publishedOfferSlug
              ? `/courses/${a.publishedOfferSlug}`
              : "No offer",
            live
              ? money(live.priceAmountMinor, live.currency)
              : a.publishedOfferSlug
                ? "Not in public catalogue"
                : "—",
          ];
        }),
        note:
          c.live === null
            ? "The public catalogue could not be read."
            : TEST_LABEL_NOTE,
      };
    }
    case "list_campaigns": {
      const campaigns = await listCommercialV1Campaigns();
      return {
        title: "Campaigns",
        columns: ["Code", "Offer", "Type", "Price", "Used", "Window", "State"],
        rows: campaigns.map((x) => [
          x.code +
            (isAcceptanceOfferSlug(x.offerSlug) ? " (acceptance test)" : ""),
          x.offerSlug,
          KIND_WORDS[x.kind],
          money(x.effectivePriceAmountMinor, x.currency),
          `${x.redemptionCount} of ${x.maxRedemptions}`,
          `${x.startsAt.slice(0, 10)} → ${x.endsAt.slice(0, 10)}`,
          x.state === "ACTIVE" ? "Active" : "Archived",
        ]),
        note: TEST_LABEL_NOTE,
      };
    }
    case "review_payment_issues": {
      const issues = await listCommerceOperations({ view: "issues" });
      return {
        title: "Payment exceptions (latest 25)",
        columns: ["Received", "Event", "State", "Reason"],
        rows: issues.rows.map((r) => [
          r.occurredAt?.slice(0, 16).replace("T", " ") ?? "—",
          r.subtitle,
          r.state,
          r.reason ?? "—",
        ]),
        note: issues.hasMore
          ? "More records exist; open Sales & Commerce for the full queue."
          : undefined,
      };
    }
    case "check_agent_health": {
      const profiles = describeProductionProfiles(
        providerCredentialReadiness(),
      );
      return {
        title: "AI agent services",
        columns: ["Profile", "Used by", "Credential", "Status"],
        rows: profiles.map((p) => [
          p.ref,
          p.roles.join(", "),
          p.credential ?? "None required",
          p.readiness === "CREDENTIAL_PRESENT"
            ? "Configured"
            : "Not configured",
        ]),
        note: "Configured means the provider key is present in this deployment; it is not a live call.",
      };
    }
    case "list_cohorts": {
      const w = await getCohortWorkspace(null);
      return {
        title: "Cohorts",
        columns: [
          "Cohort",
          "Course",
          "Status",
          "Dates",
          "Active learners",
          "Offer",
        ],
        rows: w.workspace.cohorts.map((c) => [
          `${c.title}${cohortPurpose(c) === "LIKELY_STAGING" ? " (staging)" : ""}`,
          `${c.programmeTitle} · ${c.versionLabel}`,
          c.status.toLowerCase(),
          `${c.startsOn}${c.endsOn ? ` → ${c.endsOn}` : ""}`,
          String(c.enrolments.active),
          c.publishedOfferSlug ? `/courses/${c.publishedOfferSlug}` : "—",
        ]),
      };
    }
    default:
      throw new Error("Not a read action");
  }
}

const STATE_WORDS = {
  complete: "Complete",
  action: "Action needed",
  approval: "Awaiting approval",
  blocked: "Blocked",
  attention: "Needs attention",
} as const;

const KIND_WORDS = {
  PERCENT_OFF: "Percentage discount",
  FIXED_PRICE: "Fixed price",
  REVIEWER_COMPLIMENTARY: "Complimentary reviewer",
} as const;

// ---------------------------------------------------------------------------
// Mutation proposals: authoritative state, checks, fingerprint.
// ---------------------------------------------------------------------------

type Planned = {
  display: DisplayLine[];
  checks: Check[];
  fingerprint: unknown; // the exact authoritative state the proposal relies on
  done: boolean; // the requested end state already holds
};

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value as object)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value ?? null);
}
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const sameInstant = (a: unknown, b: unknown) =>
  typeof a === "string" &&
  typeof b === "string" &&
  Number.isFinite(Date.parse(a)) &&
  Date.parse(a) === Date.parse(b);

const ok = (text: string): Check => ({ ok: true, text, blocking: false });
const stop = (text: string): Check => ({ ok: false, text, blocking: true });
const warn = (text: string): Check => ({ ok: false, text, blocking: false });

async function plan(
  id: OperationActionId,
  input: Record<string, unknown>,
): Promise<Planned> {
  switch (id) {
    case "publish_offer": {
      const c = await readCommerce();
      const activation = c.offerActivations.find(
        (a) => a.activationId === input.activationId,
      );
      const detail = c.activations.find(
        (a) => a.activationId === input.activationId,
      );
      const slugs = await listCommerceOperations({
        view: "offers",
        query: String(input.slug),
      });
      const slugTaken = slugs.rows.some(
        (r) => r.subtitle.split(" / ")[0] === input.slug,
      );
      const publishedRow = slugs.rows
        .map(parseOfferRow)
        .find((o) => o.slug === input.slug && o.state === "PUBLISHED");
      const purpose = activation
        ? cohortPurpose({ title: activation.cohortTitle, isDemo: false })
        : null;
      const plan =
        DELIVERY_PLAN_DEFINITIONS[
          (input.deliveryPlan ?? "STANDARD_6_WEEK") as DeliveryPlan
        ];
      const checks: Check[] = [
        activation
          ? ok(
              `Delivery “${activation.programmeTitle} — ${activation.cohortTitle}” is activated.`,
            )
          : stop(
              "That activated delivery no longer exists or is not visible to you.",
            ),
        activation?.publishedOfferSlug
          ? stop(
              `This delivery already has a published offer (/courses/${activation.publishedOfferSlug}). Archive it first to change the price.`,
            )
          : ok("This delivery has no published offer yet."),
        slugTaken
          ? stop(
              `The slug “${String(input.slug)}” is already used by another offer.`,
            )
          : ok(`The public URL /courses/${String(input.slug)} is free.`),
        purpose === "LIKELY_STAGING"
          ? stop(
              "This delivery's cohort is a staging or acceptance cohort. Paying learners must not be sold a place in it; activate a dedicated delivery cohort instead.",
            )
          : ok(
              "The cohort is not flagged as a staging or acceptance cohort. Confirm it is the intended delivery cohort.",
            ),
        detail &&
        !(detail.gradingPolicyPublished && detail.resultPolicyPublished)
          ? warn(
              "The grading or result policy for this delivery is not published yet.",
            )
          : ok("Grading and result policies are published."),
      ];
      return {
        display: [
          { label: "Course", value: activation?.programmeTitle ?? "Unknown" },
          {
            label: "Cohort",
            value: activation
              ? `${activation.cohortTitle} (starts ${activation.cohortStartsOn})`
              : "Unknown",
          },
          { label: "Public URL", value: `/courses/${String(input.slug)}` },
          {
            label: "Price",
            value: money(
              Number(input.priceAmountMinor),
              String(input.currency),
            ),
          },
          { label: "Delivery plan", value: plan.label },
          {
            label: "Public summary",
            value: (input.summary as string | null) ?? "None",
          },
          { label: "Reason", value: String(input.reason) },
        ],
        checks,
        fingerprint: {
          offer: activation?.publishedOfferSlug ?? null,
          slugTaken,
          exists: Boolean(activation),
        },
        // The requested offer, exactly: this delivery, this slug, this price.
        // A different offer that won a race for the slug is not "done".
        done:
          activation?.publishedOfferSlug === input.slug &&
          publishedRow?.priceAmountMinor === input.priceAmountMinor &&
          publishedRow?.currency === input.currency,
      };
    }
    case "archive_offer": {
      const c = await readCommerce();
      const activation = c.offerActivations.find(
        (a) => a.publishedOfferSlug === input.slug,
      );
      return {
        display: [
          { label: "Offer", value: `/courses/${String(input.slug)}` },
          {
            label: "Course",
            value: activation
              ? `${activation.programmeTitle} — ${activation.cohortTitle}`
              : "Not currently published",
          },
          { label: "Reason", value: String(input.reason) },
        ],
        checks: [
          activation
            ? ok("The offer is currently published.")
            : stop(
                "No published offer has this slug. It may already be archived.",
              ),
          ok("Existing orders and entitlements will not change."),
        ],
        fingerprint: { published: Boolean(activation) },
        done: !activation,
      };
    }
    case "create_campaign": {
      const c = await readCommerce();
      const offer = c.offerActivations.find(
        (a) => a.publishedOfferSlug === input.offerSlug,
      );
      const live = c.live?.find((o) => o.slug === input.offerSlug);
      const existing = c.campaigns.find(
        (x) => x.code === String(input.code).toUpperCase(),
      );
      const kind = input.kind as keyof typeof KIND_WORDS;
      const effective =
        kind === "FIXED_PRICE"
          ? Number(input.fixedPriceAmountMinor)
          : kind === "PERCENT_OFF" && live
            ? null
            : 0;
      const checks: Check[] = [
        offer
          ? ok("The offer is published.")
          : stop("That offer is not published."),
        existing
          ? stop(
              `The code ${existing.code} already exists (${existing.state.toLowerCase()}).`,
            )
          : ok("The code is not in use."),
      ];
      if (
        kind === "FIXED_PRICE" &&
        live &&
        Number(input.fixedPriceAmountMinor) >= live.priceAmountMinor
      )
        checks.push(
          warn("The campaign price is not lower than the published price."),
        );
      if (kind === "REVIEWER_COMPLIMENTARY")
        checks.push(
          warn(
            "Reviewer campaigns grant access without payment and never create a payment order.",
          ),
        );
      return {
        display: [
          { label: "Offer", value: `/courses/${String(input.offerSlug)}` },
          { label: "Code", value: String(input.code).toUpperCase() },
          { label: "Type", value: KIND_WORDS[kind] },
          {
            label: "Campaign price",
            value:
              kind === "PERCENT_OFF"
                ? `${String(input.percentOff)}% off${live ? ` (computed by the server from ${money(live.priceAmountMinor, live.currency)})` : ""}`
                : effective !== null && live
                  ? money(effective, live.currency)
                  : effective === 0
                    ? "Free"
                    : "Computed by the server",
          },
          { label: "Maximum redemptions", value: String(input.maxRedemptions) },
          {
            label: "Window (UTC)",
            value: `${String(input.startsAt)} → ${String(input.endsAt)}`,
          },
          { label: "Reason", value: String(input.reason) },
        ],
        checks,
        fingerprint: {
          offer: Boolean(offer),
          existing: existing?.state ?? null,
        },
        // The requested campaign, exactly. A different campaign that took
        // the same code is not "done".
        done: Boolean(
          existing &&
          existing.offerSlug === input.offerSlug &&
          existing.state === "ACTIVE" &&
          existing.kind === kind &&
          existing.maxRedemptions === input.maxRedemptions &&
          sameInstant(existing.startsAt, input.startsAt) &&
          sameInstant(existing.endsAt, input.endsAt) &&
          (kind === "FIXED_PRICE"
            ? existing.effectivePriceAmountMinor === input.fixedPriceAmountMinor
            : kind === "REVIEWER_COMPLIMENTARY"
              ? existing.effectivePriceAmountMinor === 0
              : true),
        ),
      };
    }
    case "archive_campaign": {
      const campaigns = await listCommercialV1Campaigns();
      const campaign = campaigns.find(
        (x) => x.code === String(input.code).toUpperCase(),
      );
      return {
        display: [
          { label: "Campaign", value: String(input.code).toUpperCase() },
          {
            label: "Offer",
            value: campaign ? `/courses/${campaign.offerSlug}` : "Unknown",
          },
          { label: "Reason", value: String(input.reason) },
        ],
        checks: [
          !campaign
            ? stop("No campaign has this code.")
            : campaign.state === "ACTIVE"
              ? ok(
                  `Active, ${campaign.redemptionCount} of ${campaign.maxRedemptions} redemptions used.`,
                )
              : stop("This campaign is already archived."),
        ],
        fingerprint: { state: campaign?.state ?? null },
        done: campaign?.state === "ARCHIVED",
      };
    }
    case "change_cohort_status": {
      const w = await getCohortWorkspace(null);
      const cohort = w.workspace.cohorts.find((c) => c.id === input.cohortId);
      const to = String(input.status);
      const from = cohort?.status ?? null;
      const allowed =
        (from === "OPEN" && to === "CLOSED") ||
        (from === "CLOSED" && (to === "OPEN" || to === "COMPLETED"));
      const checks: Check[] = [
        cohort
          ? ok(`Cohort “${cohort.title}” is ${from?.toLowerCase()}.`)
          : stop("That cohort no longer exists."),
      ];
      if (cohort && from !== to)
        checks.push(
          allowed
            ? ok(
                `${from?.toLowerCase()} → ${to.toLowerCase()} is an allowed change.`,
              )
            : stop(
                `A cohort cannot move from ${from?.toLowerCase()} to ${to.toLowerCase()}.`,
              ),
        );
      if (cohort && to === "CLOSED" && cohort.publishedOfferSlug)
        checks.push(
          warn(
            `Closing archives its published offer /courses/${cohort.publishedOfferSlug}.`,
          ),
        );
      if (to === "COMPLETED")
        checks.push(warn("Completion is final and cannot be undone."));
      return {
        display: [
          {
            label: "Cohort",
            value: cohort
              ? `${cohort.title} — ${cohort.programmeTitle}`
              : "Unknown",
          },
          {
            label: "Change",
            value: `${from?.toLowerCase() ?? "unknown"} → ${to.toLowerCase()}`,
          },
          {
            label: "Active learners",
            value: String(cohort?.enrolments.active ?? 0),
          },
          { label: "Reason", value: String(input.reason) },
        ],
        checks,
        fingerprint: {
          status: from,
          offer: cohort?.publishedOfferSlug ?? null,
        },
        done: from === to,
      };
    }
    case "run_course_test": {
      const packages = await listCoursePackages();
      const pkg = packages.find((p) => p.id === input.importId);
      const status =
        pkg?.status === "APPLIED"
          ? await getCoursePackageTestStatus(pkg.id).catch(() => null)
          : null;
      return {
        display: [
          {
            label: "Course revision",
            value: pkg
              ? `${pkg.package_key} — revision ${pkg.package_revision}`
              : "Unknown",
          },
          {
            label: "Current test status",
            value: status ? TEST_WORDS[status.status] : "Unavailable",
          },
          { label: "Reason", value: String(input.reason) },
        ],
        checks: [
          pkg?.status === "APPLIED"
            ? ok("The revision is applied as a draft and can be tested.")
            : stop(
                pkg
                  ? `This revision is ${pkg.status.toLowerCase()}; only an applied draft can be tested.`
                  : "That course revision no longer exists.",
              ),
          status?.status === "PASSED_CURRENT"
            ? warn(
                "A current passing test already exists; another run is not needed for publication.",
              )
            : ok("A new run will record the current state's result."),
        ],
        fingerprint: {
          status: pkg?.status ?? null,
          run: status?.runSequence ?? null,
        },
        done: false,
      };
    }
    default:
      throw new Error("Not a mutation action");
  }
}

const TEST_WORDS = {
  NOT_TESTED: "Not tested",
  FAILED: "Failed",
  PASSED_CURRENT: "Passed (current)",
  PASSED_STALE: "Passed (out of date)",
} as const;

function proposalHash(
  actorId: string,
  id: OperationActionId,
  input: Record<string, unknown>,
  fingerprint: unknown,
  issuedAt: string,
  nonce: string,
) {
  return sha(stable({ actorId, id, input, fingerprint, issuedAt, nonce }));
}

function rawStrings(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === "object")
    for (const [k, v] of Object.entries(raw as Record<string, unknown>))
      if (typeof v === "string" || typeof v === "number")
        out[k.slice(0, 40)] = String(v).slice(0, 600);
  return out;
}

export async function prepareOperation(
  actionId: unknown,
  rawInput: unknown,
  now = new Date(),
): Promise<PrepareResult> {
  const id = operationActionIdSchema.parse(actionId);
  const def = OPERATION_ACTIONS[id];
  const actor = await requireAnyRole(def.roles);
  const disabled = OPERATIONS_ENGINEER_DISABLED[id];
  if (disabled)
    return {
      status: "UNAVAILABLE",
      actionId: id,
      message: `The Operations Engineer does not carry out this change yet. ${disabled.reason} Use the dedicated form instead: ${disabled.manualLabel}. Nothing was changed.`,
    };
  const raw = rawStrings(rawInput);
  const parsed = parseActionInput(id, raw);
  if (!parsed.ok)
    return { status: "INVALID", actionId: id, issues: parsed.issues };
  try {
    if (def.kind === "READ")
      return {
        status: "READ_RESULT",
        actionId: id,
        table: await runRead(id, parsed.input),
      };
    const planned = await plan(id, parsed.input);
    const issuedAt = now.toISOString();
    const nonce = randomUUID();
    return {
      status: "PROPOSAL",
      proposal: {
        actionId: id,
        title: def.title,
        raw,
        display: planned.display,
        checks: planned.checks,
        blocked: planned.checks.some((c) => c.blocking),
        consequence: def.consequence ?? "",
        recovery: def.recovery ?? "",
        duplicateProtection: DUPLICATE_PROTECTION[id].text,
        issuedAt,
        expiresAt: new Date(now.getTime() + PROPOSAL_TTL_MS).toISOString(),
        nonce,
        proposalId: proposalHash(
          actor.id,
          id,
          parsed.input,
          planned.fingerprint,
          issuedAt,
          nonce,
        ),
      },
    };
  } catch {
    return {
      status: "UNAVAILABLE",
      actionId: id,
      message:
        "The current state could not be read from the governed services, so no proposal was prepared. Nothing was changed.",
    };
  }
}

// Best-effort guards for ONE server instance only (lost on restart, not
// shared between instances). They are not idempotency. Across instances the
// protection is (1) the state fingerprint: once an operation has run, the
// records it was proposed against no longer match, so a later confirmation
// of the same proposal is refused; and (2) the database invariants listed in
// DUPLICATE_PROTECTION. Two confirmations that re-read the records at the
// same moment on different instances are stopped only by (2).
const inFlight = new Set<string>();
const executed = new Map<string, number>();
function remember(id: string, at: number) {
  executed.set(id, at);
  for (const [k, t] of executed)
    if (at - t > PROPOSAL_TTL_MS) executed.delete(k);
}

const annotate = (reason: string, proposalId: string) =>
  `${reason} · Ops Engineer ref ${proposalId.slice(0, 8)}`.slice(0, 300);

async function perform(
  id: OperationActionId,
  input: Record<string, unknown>,
  reason: string,
): Promise<string> {
  switch (id) {
    case "publish_offer":
      await publishCommercialV1Offer({ ...input, reason });
      return `Offer /courses/${String(input.slug)} published.`;
    case "archive_offer":
      await archiveCommercialV1Offer({ ...input, reason });
      return `Offer /courses/${String(input.slug)} archived.`;
    case "create_campaign":
      await createCommercialV1Campaign({ ...input, reason });
      return `Campaign ${String(input.code).toUpperCase()} created.`;
    case "archive_campaign":
      await archiveCommercialV1Campaign({ ...input, reason });
      return `Campaign ${String(input.code).toUpperCase()} archived.`;
    case "change_cohort_status": {
      const result = await changeCohortStatus({ ...input, reason });
      return result.archivedOfferIds.length
        ? `Cohort is now ${result.status.toLowerCase()}; ${result.archivedOfferIds.length} offer(s) archived.`
        : `Cohort is now ${result.status.toLowerCase()}.`;
    }
    case "run_course_test": {
      const run = await runCoursePackageTest(String(input.importId), reason);
      return run.outcome === "PASS"
        ? "Pre-publication test passed for the current state."
        : `Pre-publication test failed (${run.failureCode ?? "see course engineering"}).`;
    }
    default:
      throw new Error("Not a mutation action");
  }
}

export async function executeOperation(
  request: {
    actionId: unknown;
    raw: unknown;
    issuedAt: unknown;
    nonce: unknown;
    proposalId: unknown;
    confirmed: unknown;
  },
  now = new Date(),
): Promise<Receipt> {
  const id = operationActionIdSchema.parse(request.actionId);
  const def = OPERATION_ACTIONS[id];
  const actor = await requireAnyRole(def.roles);
  const proposalId =
    typeof request.proposalId === "string" ? request.proposalId : "";
  const base = {
    actionId: id,
    title: def.title,
    reference: proposalId.slice(0, 8),
    executedAt: null,
    display: [] as DisplayLine[],
    verified: null,
    verification: "",
    recovery: def.recovery ?? "",
  };
  if (def.kind !== "MUTATION")
    return {
      ...base,
      status: "REFUSED",
      outcome: "Read-only inspections need no confirmation.",
    };
  if (!isOperationEnabled(id))
    return {
      ...base,
      status: "REFUSED",
      outcome:
        "Not executed: the Operations Engineer does not carry out this change yet. Use its dedicated form.",
    };
  if (request.confirmed !== true)
    return {
      ...base,
      status: "REFUSED",
      outcome: "Not executed: the exact operation was not confirmed.",
    };
  const issuedAt = typeof request.issuedAt === "string" ? request.issuedAt : "";
  const issued = Date.parse(issuedAt);
  if (
    !Number.isFinite(issued) ||
    now.getTime() - issued > PROPOSAL_TTL_MS ||
    issued > now.getTime() + 60_000
  )
    return {
      ...base,
      status: "EXPIRED",
      outcome:
        "Not executed: this proposal has expired. Prepare it again to see the current state.",
    };
  if (executed.has(proposalId))
    return {
      ...base,
      status: "DUPLICATE",
      outcome:
        "Not executed again: this server already carried out this exact proposal.",
    };
  if (inFlight.has(proposalId))
    return {
      ...base,
      status: "DUPLICATE",
      outcome:
        "Not executed again: this server is already carrying out this proposal.",
    };

  const parsed = parseActionInput(id, rawStrings(request.raw));
  if (!parsed.ok)
    return {
      ...base,
      status: "REFUSED",
      outcome: `Not executed: ${parsed.issues.join(" ")}`,
    };

  inFlight.add(proposalId);
  try {
    let planned: Planned;
    try {
      planned = await plan(id, parsed.input);
    } catch {
      return {
        ...base,
        status: "FAILED",
        outcome:
          "Not executed: the current state could not be re-read. Nothing was changed.",
      };
    }
    const display = planned.display;
    const nonce = typeof request.nonce === "string" ? request.nonce : "";
    const expected = proposalHash(
      actor.id,
      id,
      parsed.input,
      planned.fingerprint,
      issuedAt,
      nonce,
    );
    if (expected !== proposalId)
      return planned.done
        ? {
            ...base,
            display,
            status: "ALREADY_DONE",
            outcome: "Nothing to do: the requested end state already holds.",
          }
        : {
            ...base,
            display,
            status: "STATE_CHANGED",
            outcome:
              "Not executed: the state changed since this proposal was prepared, or the proposal was altered. Review the new proposal before confirming.",
          };
    if (planned.checks.some((c) => c.blocking))
      return {
        ...base,
        display,
        status: "REFUSED",
        outcome: `Not executed: ${planned.checks
          .filter((c) => c.blocking)
          .map((c) => c.text)
          .join(" ")}`,
      };

    const executedAt = new Date().toISOString();
    // Whether the requested end state holds, from a fresh authoritative read.
    // null: the records could not be re-read.
    const applied = async (): Promise<boolean | null> => {
      try {
        const after = await plan(id, parsed.input);
        return id === "run_course_test"
          ? runSequence(after.fingerprint) !== null &&
              runSequence(after.fingerprint) !==
                runSequence(planned.fingerprint)
          : after.done;
      } catch {
        return null;
      }
    };
    let outcome: string;
    try {
      outcome = await perform(
        id,
        parsed.input,
        annotate(String(parsed.input.reason), proposalId),
      );
    } catch {
      // An error does not prove nothing changed: the database may have
      // committed before the response was lost. Decide from the records.
      const state = await applied();
      if (state === true) {
        remember(proposalId, Date.now());
        return {
          ...base,
          display,
          executedAt,
          status: "SUCCEEDED",
          outcome:
            "The requested change is in place, confirmed by re-reading the records. The service returned an error, which happens when the change was already applied (by this request whose reply was lost, or by a simultaneous one); it was not applied twice.",
          verified: true,
          verification: "Confirmed by re-reading the authoritative state.",
        };
      }
      if (state === null)
        return {
          ...base,
          display,
          executedAt,
          status: "UNCERTAIN",
          outcome:
            "The service reported an error and the records could not be re-read, so it is not known whether the change was applied.",
          recovery:
            "Do not retry yet. Inspect the record (for example with a read-only inspection) and prepare a new proposal only if the change is absent.",
        };
      return {
        ...base,
        display,
        executedAt,
        status: "FAILED",
        outcome:
          "The governed service refused or could not complete the operation, and re-reading the records confirms the change was not applied.",
        recovery:
          "Prepare the proposal again to see the current state, then correct the input or the blocking condition.",
      };
    }
    remember(proposalId, Date.now());
    const state = await applied();
    return {
      ...base,
      display,
      executedAt,
      status: "SUCCEEDED",
      outcome,
      verified: state,
      verification:
        state === true
          ? "Confirmed by re-reading the authoritative state."
          : state === false
            ? "The re-read state does not show the expected result yet. Check the record before retrying."
            : "The result could not be re-read for verification. Check the record before retrying.",
    };
  } finally {
    inFlight.delete(proposalId);
  }
}

// ---------------------------------------------------------------------------
// Natural-language interpretation through the reviewed runtime profile.
// ---------------------------------------------------------------------------

export function operationsEngineerConfigured(): boolean {
  const profile = resolvePlatformRuntimeProfile("OPERATIONS_ENGINEER");
  return Boolean(profile && resolveAdapterForProfile(profile));
}

export async function interpretOperationRequest(
  text: unknown,
): Promise<InterpretResult> {
  await requireAnyRole(ADMINS);
  const request = typeof text === "string" ? text.trim().slice(0, 2000) : "";
  if (request.length < 3)
    return {
      status: "AI_FAILED",
      message: "Describe what you need in a few words.",
    };
  const profile = resolvePlatformRuntimeProfile("OPERATIONS_ENGINEER");
  const adapter = profile ? resolveAdapterForProfile(profile) : null;
  if (!profile || !adapter)
    return {
      status: "AI_NOT_CONFIGURED",
      message:
        "AI interpretation is not configured in this deployment (no Anthropic provider key for the reviewed Operations Engineer profile). Choose an operation from the list instead; every operation works without AI.",
    };
  const options = await getOperationOptions();
  const result = await runGovernedProviderExecution(
    adapter,
    {
      role: OPERATIONS_ENGINEER_PROVIDER_ROLE,
      capability: OPERATIONS_ENGINEER_CAPABILITY,
      context: {
        administratorRequest: request,
        todayUtc: new Date().toISOString().slice(0, 10),
        referenceData: Object.fromEntries(
          Object.entries(options).map(([k, list]) => [
            k,
            list.slice(0, 60).map((o) => ({ value: o.value, label: o.label })),
          ]),
        ),
      },
    },
    profile.budgetPolicy,
  );
  if (result.outcome !== "SUCCEEDED")
    return {
      status: "AI_FAILED",
      message: `The AI interpreter did not return a usable answer (${result.outcome.toLowerCase().replace(/_/g, " ")}). Nothing was changed; choose an operation from the list instead.`,
    };
  const intent = parseInterpreterOutput(result.response.outputText);
  if (!intent)
    return {
      status: "AI_FAILED",
      message:
        "The AI interpreter's answer did not match the required format, so it was discarded. Nothing was changed.",
    };
  if (intent.action === "none")
    return { status: "NO_ACTION", explanation: intent.explanation };
  const raw = rawStrings(intent.arguments);
  return {
    status: "INTERPRETED",
    explanation: intent.explanation,
    actionId: intent.action,
    raw,
    prepared: await prepareOperation(intent.action, raw),
  };
}

function runSequence(fingerprint: unknown): number | null {
  const run = (fingerprint as { run?: unknown } | null)?.run;
  return typeof run === "number" ? run : null;
}
