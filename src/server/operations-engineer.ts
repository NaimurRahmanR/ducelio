import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { courseEngineeringAccess } from "./course-organisations";
import {
  describeProductionProfiles,
  providerCredentialReadiness,
} from "./agent-control-plane";
import {
  resolveAdapterForProfile,
  resolvePlatformRuntimeProfile,
} from "./academic-runtime/profile-registry";
import { runGovernedProviderExecution } from "./academic-runtime/runtime";
import {
  checkUnifiedCoursePackageUpload,
  describeUploadConflict,
  getUnifiedAcademicResolutions,
  getUnifiedPublicationGate,
  listUnifiedCourseCatalogue,
  listUnifiedCoursePackages,
  publishUnifiedCourse,
  uploadUnifiedCoursePackage,
  type UploadCheck,
} from "./unified-course-engine";
import {
  getAcademyPackageReview,
  validateAcademyPackage,
} from "./academy-course-engineering";
import {
  createCourseCoupon,
  listCourseCoupons,
  listOrganisationCourseOrders,
  setCourseCouponActive,
} from "./course-coupons";
import { commerceConfig } from "@/lib/env";
import {
  OPERATIONS_ENGINEER_CAPABILITY,
  OPERATIONS_ENGINEER_PROVIDER_ROLE,
  DUPLICATE_PROTECTION,
  OPERATION_ACTIONS,
  operationActionIdSchema,
  parseActionInput,
  parseInterpreterOutput,
  type ChoiceSource,
  type OperationActionId,
} from "@/domain/operations-engineer";
import {
  academyUploadSizeError,
  formatMoney,
  type AcademyPackageListItem,
} from "@/domain/academy-delivery";
import type { AcademyReview } from "@/domain/academy-course-package";
import { courseStage } from "@/domain/unified-course-lifecycle";
import { isAcceptanceCourse } from "@/domain/admin-test-records";
import { AccessDenied } from "@/domain/policy";

// The Operations Engineer execution plane for the unified Course Engine.
// Natural-language request -> intent (AI, when configured) -> authoritative
// state read with the administrator's own session -> typed, validated
// proposal -> explicit confirmation -> execution through the existing
// governed service AS THAT ADMINISTRATOR -> verification re-read -> receipt.
// The model holds no authority at any point: it only names an action from
// the closed registry, and its arguments are untrusted input re-validated
// exactly like a typed form. Organisation scope is enforced by the database
// on every read and write; the choice lists only contain records the
// administrator's own session returned.

const PROPOSAL_TTL_MS = 15 * 60 * 1000;
// A change whose duplicate protection is only partial (see
// DUPLICATE_PROTECTION) gets a shorter confirmation window.
const PARTIAL_TTL_MS = 5 * 60 * 1000;
export const proposalTtl = (id: OperationActionId) =>
  DUPLICATE_PROTECTION[id].level === "partial"
    ? PARTIAL_TTL_MS
    : PROPOSAL_TTL_MS;

export type Option = { value: string; label: string; warning?: string };
export type OperationOptions = Record<ChoiceSource, Option[]>;
export type Link = { label: string; href: string };
export type DisplayLine = { label: string; value: string };
export type ReadTable = {
  title: string;
  columns: string[];
  rows: string[][];
  summary?: DisplayLine[];
  links?: Link[];
  note?: string;
};
export type Check = { ok: boolean; text: string; blocking: boolean };

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
  links?: Link[];
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

// A file attached in the browser for upload_course_package. Its bytes are
// hashed into the proposal, so a confirmation with a different file is
// refused as a changed proposal.
export type Attachment = {
  name: string;
  size: number;
  sha256: string;
  json: unknown;
  problem: string | null;
};

export async function readAttachment(
  file: unknown,
): Promise<Attachment | null> {
  if (!(file instanceof Blob) || file.size === 0) return null;
  const name = "name" in file ? String((file as File).name) : "package.json";
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const base = { name: name.slice(0, 120), size: file.size, sha256 };
  if (!name.toLowerCase().endsWith(".json"))
    return { ...base, json: null, problem: "The file must be a .json file." };
  const tooLarge = academyUploadSizeError(file.size);
  if (tooLarge) return { ...base, json: null, problem: tooLarge };
  try {
    const json = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    return { ...base, json, problem: null };
  } catch {
    return {
      ...base,
      json: null,
      problem: "The file is not valid UTF-8 JSON.",
    };
  }
}

// ---------------------------------------------------------------------------
// Authority: course-engineering access (platform course administrators or
// organisation members), plus any platform role the action itself requires.
// ---------------------------------------------------------------------------

type Access = Awaited<ReturnType<typeof courseEngineeringAccess>>;

async function requireOperator(id?: OperationActionId): Promise<Access> {
  const access = await courseEngineeringAccess();
  if (!access.allowed) throw new AccessDenied();
  const roles = id ? OPERATION_ACTIONS[id].roles : [];
  if (roles.length && !roles.some((r) => access.actor.roles.includes(r)))
    throw new AccessDenied();
  return access;
}

const canManage = (access: Access, organisationId?: string) =>
  !!organisationId &&
  access.organisations.some((o) => o.id === organisationId && o.canManage);

// ---------------------------------------------------------------------------
// Authoritative reads used for options, inspections, proposals and
// verification. All run with the administrator's own session.
// ---------------------------------------------------------------------------

const isTestCourse = (p: { packageKey: string; title: string | null }) =>
  isAcceptanceCourse({ packageKey: p.packageKey, title: p.title ?? "" }) ||
  /^test only\b/i.test(p.title ?? "") ||
  /^test-/.test(p.packageKey);

// Real records first; test records after them, labelled, so a choice list
// never leads with test traffic.
function businessFirst(options: (Option & { test: boolean })[]): Option[] {
  return [
    ...options.filter((o) => !o.test),
    ...options.filter((o) => o.test),
  ].map(({ test, ...o }) =>
    test ? { ...o, label: `${o.label} (test record)` } : o,
  );
}

const titleOf = (p: AcademyPackageListItem) => p.title ?? p.packageKey;
type Coupon = Awaited<ReturnType<typeof listCourseCoupons>>[number];
const discountText = (c: {
  percentOff: number | null;
  amountOffMinor: number | null;
  currency: string | null;
}) =>
  c.percentOff !== null
    ? `${c.percentOff}% off`
    : `${formatMoney(c.amountOffMinor ?? 0, c.currency ?? "GBP")} off (${c.currency} courses only)`;
const utcText = (iso: string) =>
  `${new Date(iso).toISOString().slice(0, 16).replace("T", " ")} UTC`;

async function courseCurrencies() {
  const catalogue = await listUnifiedCourseCatalogue().catch(() => []);
  return new Map(catalogue.map((c) => [c.offerId, c.currency]));
}

export async function getOperationOptions(): Promise<OperationOptions> {
  const access = await requireOperator();
  const [packages, coupons, currencies] = await Promise.all([
    listUnifiedCoursePackages().catch(() => []),
    listCourseCoupons().catch(() => []),
    courseCurrencies(),
  ]);
  return {
    packages: businessFirst(
      packages.map((p) => ({
        value: p.id,
        label: `${titleOf(p)} — revision ${p.packageRevision} (${courseStage(p).label.toLowerCase()})`,
        test: isTestCourse(p),
      })),
    ),
    publishablePackages: businessFirst(
      packages
        .filter(
          (p) =>
            p.status === "VALIDATED" && canManage(access, p.organisationId),
        )
        .map((p) => ({
          value: p.id,
          label: `${titleOf(p)} — revision ${p.packageRevision}`,
          warning: p.pendingDecisions.length
            ? `${p.pendingDecisions.length} academic decision(s) pending: publication is blocked.`
            : undefined,
          test: isTestCourse(p),
        })),
    ),
    organisations: access.organisations
      .filter((o) => o.canManage)
      .map((o) => ({ value: o.id, label: o.name })),
    publishedCourses: businessFirst(
      packages
        .filter((p) => p.course?.offerState === "PUBLISHED")
        .map((p) => {
          const currency = currencies.get(p.course!.offerId ?? "");
          return {
            value: p.course!.id,
            label: `${titleOf(p)} (/courses/${p.course!.slug}${currency ? `, ${currency}` : ""})`,
            test: isTestCourse(p),
          };
        }),
    ),
    coupons: coupons.map((c) => ({
      value: c.id,
      label: `${c.code} — ${discountText(c)} · ${c.active ? "active" : "inactive"}`,
    })),
  };
}

// ---------------------------------------------------------------------------
// Read-only inspections: executed immediately, no confirmation needed.
// ---------------------------------------------------------------------------

async function decisionHistory(
  packages: AcademyPackageListItem[],
  p: AcademyPackageListItem,
) {
  const lineage = packages.filter(
    (x) =>
      x.packageKey === p.packageKey &&
      x.organisationId === p.organisationId &&
      x.packageRevision <= p.packageRevision,
  );
  const rows = await Promise.all(
    lineage.map((x) =>
      getUnifiedAcademicResolutions(x.id).then((r) =>
        r.map((d) => ({ ...d, revision: x.packageRevision })),
      ),
    ),
  );
  return rows.flat();
}

async function runRead(
  id: OperationActionId,
  input: Record<string, unknown>,
): Promise<ReadTable> {
  switch (id) {
    case "list_courses": {
      const packages = await listUnifiedCoursePackages();
      return {
        title: "Courses and publication states",
        columns: [
          "Course",
          "Organisation",
          "Revision",
          "Stage",
          "Pending decisions",
          "Offer",
        ],
        rows: packages.map((p) => [
          `${titleOf(p)}${isTestCourse(p) ? " (test record)" : ""}`,
          p.organisationName ?? "—",
          `${p.packageKey} · ${p.packageRevision}`,
          courseStage(p).label,
          String(p.pendingDecisions.length),
          p.course?.slug
            ? `/courses/${p.course.slug} (${p.course.offerState?.toLowerCase() ?? "no offer"})`
            : "—",
        ]),
        note: "Newest 200 revisions you can see. Earlier revisions are retained unchanged.",
      };
    }
    case "inspect_course": {
      const packages = await listUnifiedCoursePackages();
      const p = packages.find((x) => x.id === input.packageId);
      if (!p)
        return {
          title: "Course revision not found",
          columns: ["Result"],
          rows: [["This revision is not in your course register."]],
        };
      const [review, history] = await Promise.all([
        p.status === "UPLOADED"
          ? null
          : getAcademyPackageReview(p.id).then(
              (r) => (r.review as AcademyReview | null) ?? null,
            ),
        decisionHistory(packages, p),
      ]);
      const stage = courseStage(p);
      const newer = packages.find(
        (x) =>
          x.packageKey === p.packageKey &&
          x.organisationId === p.organisationId &&
          x.packageRevision > p.packageRevision,
      );
      const rows: string[][] = [
        ["Stage", `${stage.label}. ${stage.detail}`],
        ["Organisation", p.organisationName ?? "—"],
        ["Revision", `${p.packageKey} · ${p.packageRevision}`],
      ];
      if (newer)
        rows.push([
          "Newer revision",
          `Revision ${newer.packageRevision} exists (${courseStage(newer).label.toLowerCase()}).`,
        ]);
      if (review)
        rows.push([
          "Content",
          `${review.totals.modules} modules, ${review.totals.lessons} lessons, ${review.labs.length} labs (${review.labs.filter((l) => l.graded).length} graded), ${review.assessments.length} assessments: ${review.assessments.map((a) => `${a.kind.toLowerCase()} ${a.questionCount} items/${a.durationMinutes} min`).join("; ")}.`,
        ]);
      for (const d of review?.pendingDecisions ?? [])
        rows.push([`Pending: ${d.key}`, d.summary]);
      for (const r of history)
        rows.push([
          `Resolved: ${r.key}`,
          `Revision ${r.revision}. ${r.rationale} Evidence: ${r.evidenceReference}.`,
        ]);
      rows.push([
        "Curriculum",
        p.curriculumImport
          ? `Imported (${p.curriculumImport.status.toLowerCase()}).`
          : "Not imported yet: the curriculum is imported and tested at publication.",
      ]);
      rows.push([
        "Offer",
        p.course?.slug
          ? `/courses/${p.course.slug}: ${p.course.offerState?.toLowerCase()}, ${p.course.saleMode === "PUBLIC_SALE" ? "public sale" : "review only"}.`
          : "None.",
      ]);
      return {
        title: `${titleOf(p)} · revision ${p.packageRevision}`,
        columns: ["Item", "Detail"],
        rows,
        links: [
          {
            label: "Open in Course academic review",
            href: `/admin/course-engineering/review?packageId=${p.id}`,
          },
          {
            label: "Open in Course Engineering",
            href: `/admin/course-engineering?packageId=${p.id}`,
          },
        ],
        note: "Protected assessment content and answer keys are never shown here.",
      };
    }
    case "list_coupons": {
      const coupons = await listCourseCoupons();
      return {
        title: "Discount codes",
        columns: [
          "Code",
          "Discount",
          "Scope",
          "Expires",
          "Limit",
          "Reserved",
          "Redeemed",
          "Availability",
        ],
        rows: coupons.map((c) => [
          c.code,
          discountText(c),
          c.courseId
            ? `Course ${c.courseId}`
            : "All of its organisation's courses",
          utcText(c.expiresAt),
          String(c.redemptionLimit),
          String(c.reserved),
          String(c.redeemed),
          c.active ? "Active" : "Inactive",
        ]),
        note: "Newest 200 coupons in organisations you manage.",
      };
    }
    case "sales_report": {
      const orders = await listOrganisationCourseOrders();
      const currencies = [...new Set(orders.map((o) => o.currency))].sort();
      const summary: DisplayLine[] = [];
      for (const cur of currencies) {
        const list = orders.filter((o) => o.currency === cur);
        const fulfilled = list.filter((o) => o.state === "FULFILLED");
        const confirmed = list.filter((o) => o.paymentConfirmed);
        const sum = (
          xs: typeof list,
          f: (o: (typeof list)[number]) => number,
        ) =>
          formatMoney(
            xs.reduce((n, o) => n + f(o), 0),
            cur,
          );
        summary.push(
          {
            label: `${cur} orders`,
            value: `${list.length}: ${fulfilled.length} fulfilled, ${list.filter((o) => o.state === "PENDING").length} pending, ${list.filter((o) => o.state === "CANCELLED").length} cancelled`,
          },
          {
            label: `${cur} fulfilled order totals`,
            value: `${sum(fulfilled, (o) => o.amountMinor)} (order amounts, not settled revenue)`,
          },
          {
            label: `${cur} payment confirmed`,
            value: `${confirmed.length} orders with a verified paid event, totalling ${sum(confirmed, (o) => o.amountMinor)} in order amounts`,
          },
          {
            label: `${cur} discounts given`,
            value: sum(list, (o) => o.discountAmountMinor),
          },
          {
            label: `${cur} refunds recorded`,
            value: `${list.filter((o) => o.refundRecorded).length} orders (refund amounts are not in this report)`,
          },
        );
      }
      summary.push({
        label: "Recognised revenue",
        value:
          "Not reported. There is no reviewed settled-revenue ledger; captured and refunded amounts are not available here.",
      });
      return {
        title: "Orders and sales statistics",
        columns: [
          "Created (UTC)",
          "Course",
          "State",
          "Order amount",
          "Discount",
          "Payment confirmed",
          "Refund recorded",
        ],
        rows: orders.map((o) => [
          utcText(o.createdAt),
          o.courseTitle,
          o.state.toLowerCase(),
          formatMoney(o.amountMinor, o.currency),
          formatMoney(o.discountAmountMinor, o.currency),
          o.paymentConfirmed ? "Yes" : "No",
          o.refundRecorded ? "Yes" : "No",
        ]),
        summary,
        note: `Covers the newest ${orders.length} paid-checkout orders (at most 200) for organisations you manage. Free coupon access creates no order and is not counted.`,
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
    default:
      throw new Error("Not a read action");
  }
}

// ---------------------------------------------------------------------------
// Mutation proposals: authoritative state, checks, fingerprint.
// ---------------------------------------------------------------------------

type Planned = {
  display: DisplayLine[];
  checks: Check[];
  fingerprint: unknown; // the exact authoritative state the proposal relies on
  done: boolean; // the requested end state already holds
  upload?: UploadCheck; // reused by perform for upload_course_package
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

const sameCouponTerms = (c: Coupon, input: Record<string, unknown>) =>
  c.percentOff === ((input.percentOff as number | undefined) ?? null) &&
  c.amountOffMinor === ((input.amountOffMinor as number | undefined) ?? null) &&
  c.currency === ((input.currency as string | undefined) ?? null) &&
  sameInstant(c.expiresAt, input.expiresAt) &&
  c.redemptionLimit === input.redemptionLimit &&
  c.courseId === input.courseId;

async function plan(
  id: OperationActionId,
  input: Record<string, unknown>,
  access: Access,
  attachment: Attachment | null,
): Promise<Planned> {
  switch (id) {
    case "upload_course_package": {
      const org = access.organisations.find(
        (o) => o.id === input.organisationId,
      );
      const display: DisplayLine[] = [
        { label: "Organisation", value: org?.name ?? "Not one you manage" },
        {
          label: "File",
          value: attachment
            ? `${attachment.name} (${Math.ceil(attachment.size / 1024)} KiB, SHA-256 ${attachment.sha256.slice(0, 16)}…)`
            : "None attached",
        },
      ];
      const checks: Check[] = [];
      if (!canManage(access, org?.id))
        checks.push(
          stop("You do not manage course packages for this organisation."),
        );
      if (!attachment)
        checks.push(
          stop(
            "Attach the course package JSON file. Nothing has been uploaded.",
          ),
        );
      else if (attachment.problem)
        checks.push(stop(`${attachment.problem} Nothing has been uploaded.`));
      let upload: UploadCheck | undefined;
      if (attachment && !attachment.problem && org) {
        upload = await checkUnifiedCoursePackageUpload(attachment.json, org.id);
        if (upload.status === "INVALID")
          checks.push(
            stop(
              `The package failed validation with ${upload.issues.length} issue(s): ${upload.issues.slice(0, 5).join("; ")}${upload.issues.length > 5 ? "; …" : ""}. Nothing has been stored.`,
            ),
          );
        else if (upload.status === "REVISION_TAKEN")
          checks.push(stop(describeUploadConflict(upload)));
        else if (upload.status === "ALREADY_UPLOADED")
          checks.push(
            ok(
              `This exact file is already stored as revision ${upload.revision} (${upload.packageStatus.toLowerCase()}). Confirming creates nothing new${upload.packageStatus === "UPLOADED" ? " and records its validation" : ""}.`,
            ),
          );
        else {
          display.push(
            { label: "Course", value: upload.title },
            {
              label: "Package and revision",
              value: `${upload.packageKey} · revision ${upload.revision}`,
            },
          );
          checks.push(
            ok(
              "The file is a structurally valid ACADEMY_COURSE_PACKAGE_V1 package.",
            ),
            ok(
              `Revision ${upload.revision} is not stored yet${upload.latestRevision ? ` (latest stored revision: ${upload.latestRevision})` : ""}.`,
            ),
            upload.pendingDecisions
              ? warn(
                  `${upload.pendingDecisions} academic decision(s) must be reviewed before it can be published.`,
                )
              : ok("It declares no pending academic decision."),
          );
        }
      }
      return {
        display,
        checks,
        upload,
        fingerprint: {
          sha: attachment?.sha256 ?? null,
          upload:
            upload?.status === "READY"
              ? { status: upload.status, latest: upload.latestRevision }
              : upload?.status === "ALREADY_UPLOADED"
                ? {
                    status: upload.status,
                    id: upload.packageId,
                    s: upload.packageStatus,
                  }
                : (upload?.status ?? null),
        },
        done:
          upload?.status === "ALREADY_UPLOADED" &&
          upload.packageStatus !== "UPLOADED",
      };
    }
    case "publish_course": {
      const gate = await getUnifiedPublicationGate(String(input.packageId));
      const packages = await listUnifiedCoursePackages();
      const p = "package" in gate ? gate.package : undefined;
      const checks: Check[] = [];
      const display: DisplayLine[] = [
        {
          label: "Course",
          value: p
            ? `${titleOf(p)} — revision ${p.packageRevision}`
            : "Not found",
        },
        { label: "Organisation", value: p?.organisationName ?? "—" },
        { label: "Address", value: `/courses/${String(input.slug)}` },
        {
          label: "Price",
          value: `${formatMoney(Number(input.amountMinor), String(input.currency))} for every supported duration`,
        },
      ];
      if (input.summary)
        display.push({ label: "Summary", value: String(input.summary) });
      if (!p)
        checks.push(stop("This revision is not in your course register."));
      else {
        if (!canManage(access, p.organisationId))
          checks.push(stop("You do not manage this course's organisation."));
        if (gate.ok && gate.published)
          checks.push(
            p.course?.slug === input.slug
              ? ok(`Already published at /courses/${String(input.slug)}.`)
              : stop(
                  `This revision is already published at /courses/${p.course?.slug ?? "?"}.`,
                ),
          );
        else if (!gate.ok && gate.code === "POLICY_PENDING")
          checks.push(
            stop(
              `${gate.pending.length} academic decision(s) are pending (${gate.pending.join(", ")}). They must be resolved by an authorised reviewer in Course academic review before publication.`,
            ),
          );
        else if (!gate.ok)
          checks.push(
            stop(
              `Only a structurally validated revision can be published; this one is "${courseStage(p).label}".`,
            ),
          );
        else checks.push(ok("No academic decision is pending."));
        const taken = packages.find(
          (x) => x.course?.slug === input.slug && x.id !== p.id,
        );
        if (taken)
          checks.push(
            stop(
              `/courses/${String(input.slug)} is already used by ${titleOf(taken)}.`,
            ),
          );
        const newer = packages.find(
          (x) =>
            x.packageKey === p.packageKey &&
            x.organisationId === p.organisationId &&
            x.packageRevision > p.packageRevision,
        );
        if (newer)
          checks.push(
            warn(
              `A newer revision (${newer.packageRevision}) of this course exists.`,
            ),
          );
      }
      checks.push(
        commerceConfig().configured
          ? ok("Card checkout is configured in this deployment.")
          : warn(
              "Card checkout is not configured in this deployment: learners can join only with a coupon until it is.",
            ),
      );
      return {
        display,
        checks,
        fingerprint: {
          status: p?.status ?? null,
          pending: p?.pendingDecisions ?? null,
          course: p?.course ?? null,
          taken: packages
            .filter((x) => x.course?.slug === input.slug)
            .map((x) => x.id),
        },
        done: p?.status === "PUBLISHED" && p.course?.slug === input.slug,
      };
    }
    case "create_coupon": {
      const org = access.organisations.find(
        (o) => o.id === input.organisationId,
      );
      const [coupons, packages, currencies] = await Promise.all([
        listCourseCoupons(),
        listUnifiedCoursePackages(),
        courseCurrencies(),
      ]);
      const existing = coupons.find((c) => c.code === input.code);
      const course = input.courseId
        ? packages.find((p) => p.course?.id === input.courseId)
        : undefined;
      const courseCurrency = course?.course?.offerId
        ? currencies.get(course.course.offerId)
        : undefined;
      const fixed = typeof input.amountOffMinor === "number";
      const display: DisplayLine[] = [
        { label: "Organisation", value: org?.name ?? "Not one you manage" },
        { label: "Code", value: String(input.code) },
        {
          label: "Discount",
          value: discountText({
            percentOff: (input.percentOff as number | undefined) ?? null,
            amountOffMinor:
              (input.amountOffMinor as number | undefined) ?? null,
            currency: (input.currency as string | undefined) ?? null,
          }),
        },
        {
          label: "Applies to",
          value: input.courseId
            ? course
              ? `${titleOf(course)} (/courses/${course.course?.slug})`
              : "A course not in your register"
            : `All of ${org?.name ?? "the organisation"}'s courses`,
        },
        { label: "Expires", value: utcText(String(input.expiresAt)) },
        { label: "Total uses", value: String(input.redemptionLimit) },
      ];
      const checks: Check[] = [];
      if (!canManage(access, org?.id))
        checks.push(stop("You do not manage coupons for this organisation."));
      if (Date.parse(String(input.expiresAt)) <= Date.now())
        checks.push(stop("The expiry must be in the future."));
      if (input.courseId && !course)
        checks.push(
          stop("The course restriction is not one of your published courses."),
        );
      if (course && course.organisationId !== org?.id)
        checks.push(stop("The course belongs to a different organisation."));
      if (fixed && courseCurrency && courseCurrency !== input.currency)
        checks.push(
          stop(
            `This course is priced in ${courseCurrency}; a fixed amount must use ${courseCurrency}.`,
          ),
        );
      if (fixed && !input.courseId)
        checks.push(
          ok(
            `Applies only to the organisation's courses priced in ${String(input.currency)}.`,
          ),
        );
      if (input.percentOff === 100)
        checks.push(warn("A 100% coupon grants access without any payment."));
      checks.push(
        warn(
          "A partial discount that would leave less than the minimum card payment is refused at checkout.",
        ),
      );
      if (existing)
        checks.push(
          sameCouponTerms(existing, input)
            ? ok(
                "This code already exists with these exact terms; confirming creates nothing new.",
              )
            : stop(
                "This code already exists with different terms. Coupon terms cannot be changed; choose a new code.",
              ),
        );
      return {
        display,
        checks,
        fingerprint: {
          existing: existing ?? null,
          course: course?.course ?? null,
        },
        done: !!existing && sameCouponTerms(existing, input),
      };
    }
    case "set_coupon_active": {
      const coupon = (await listCourseCoupons()).find(
        (c) => c.id === input.couponId,
      );
      const display: DisplayLine[] = coupon
        ? [
            {
              label: "Coupon",
              value: `${coupon.code} — ${discountText(coupon)}`,
            },
            {
              label: "Availability",
              value: `${coupon.active ? "Active" : "Inactive"} → ${input.active ? "Active" : "Inactive"}`,
            },
            {
              label: "Uses",
              value: `${coupon.reserved} reserved, ${coupon.redeemed} redeemed of ${coupon.redemptionLimit}`,
            },
          ]
        : [{ label: "Coupon", value: "Not found" }];
      const checks: Check[] = [];
      if (!coupon)
        checks.push(stop("This coupon is not in your coupon register."));
      else if (coupon.active === input.active)
        checks.push(
          ok(
            `The coupon is already ${coupon.active ? "active" : "inactive"}; confirming changes nothing.`,
          ),
        );
      return {
        display,
        checks,
        fingerprint: { active: coupon?.active ?? null },
        done: coupon?.active === input.active,
      };
    }
    default:
      throw new Error("Not a mutation action");
  }
}

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
  attachment: Attachment | null = null,
  now = new Date(),
): Promise<PrepareResult> {
  const id = operationActionIdSchema.parse(actionId);
  const def = OPERATION_ACTIONS[id];
  const access = await requireOperator(id);
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
    const planned = await plan(id, parsed.input, access, attachment);
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
        expiresAt: new Date(now.getTime() + proposalTtl(id)).toISOString(),
        nonce,
        proposalId: proposalHash(
          access.actor.id,
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
        "The current state could not be read from the governed services, so nothing was prepared. Nothing was changed.",
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

// A bounded policy code from a governed service, for the receipt only.
const policyCode = (error: unknown) =>
  error instanceof Error && /^[A-Z_]{3,40}$/.test(error.message)
    ? error.message
    : null;

async function perform(
  id: OperationActionId,
  input: Record<string, unknown>,
  reason: string,
  planned: Planned,
  attachment: Attachment | null,
): Promise<{ outcome: string; links?: Link[] }> {
  switch (id) {
    case "upload_course_package": {
      const check = planned.upload;
      if (!check || !attachment) throw new Error("INVALID_STATE");
      const packageId =
        check.status === "ALREADY_UPLOADED"
          ? check.packageId
          : await uploadUnifiedCoursePackage(
              attachment.json,
              reason,
              String(input.organisationId),
            );
      const result =
        check.status === "ALREADY_UPLOADED" &&
        check.packageStatus !== "UPLOADED"
          ? null
          : await validateAcademyPackage(packageId, reason);
      if (result && !result.valid) throw new Error("MALFORMED_PACKAGE");
      return {
        outcome: result
          ? `Stored and structurally validated as revision ${result.package.packageRevision}, with ${result.review.pendingDecisions.length} academic decision(s) pending review.`
          : "This exact file was already stored; nothing new was created.",
        links: [
          {
            label: "Open its academic review",
            href: `/admin/course-engineering/review?packageId=${packageId}`,
          },
          {
            label: "Open in Course Engineering",
            href: `/admin/course-engineering?packageId=${packageId}`,
          },
        ],
      };
    }
    case "publish_course": {
      const result = await publishUnifiedCourse({ ...input, reason });
      return {
        outcome: result.replayed
          ? `Already published at /courses/${String(input.slug)} with these exact terms.`
          : `Published at /courses/${String(input.slug)}.`,
        links: [
          {
            label: "Open the course page",
            href: `/courses/${String(input.slug)}`,
          },
        ],
      };
    }
    case "create_coupon": {
      const { organisationId, ...coupon } = input;
      await createCourseCoupon({ ...coupon, reason }, String(organisationId));
      return { outcome: `Coupon ${String(input.code)} created.` };
    }
    case "set_coupon_active":
      await setCourseCouponActive(
        String(input.couponId),
        input.active === true,
        reason,
      );
      return {
        outcome: `Coupon is now ${input.active ? "active" : "inactive"} for new checkouts.`,
      };
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
  attachment: Attachment | null = null,
  now = new Date(),
): Promise<Receipt> {
  const id = operationActionIdSchema.parse(request.actionId);
  const def = OPERATION_ACTIONS[id];
  const access = await requireOperator(id);
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
    now.getTime() - issued > proposalTtl(id) ||
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
      planned = await plan(id, parsed.input, access, attachment);
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
      access.actor.id,
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
              "Not executed: the records (or the attached file) changed since this proposal was prepared, or the proposal was altered. Review the new proposal before confirming.",
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
        return (await plan(id, parsed.input, access, attachment)).done;
      } catch {
        return null;
      }
    };
    let result: { outcome: string; links?: Link[] };
    try {
      result = await perform(
        id,
        parsed.input,
        annotate(String(parsed.input.reason), proposalId),
        planned,
        attachment,
      );
    } catch (error) {
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
      const code = policyCode(error);
      return {
        ...base,
        display,
        executedAt,
        status: "FAILED",
        outcome: `The governed service refused or could not complete the operation${code ? ` (${code})` : ""}, and re-reading the records confirms the change was not applied.`,
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
      outcome: result.outcome,
      links: result.links,
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
  await requireOperator();
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
    // A file is never inferred: an upload is prepared without one, which
    // asks the administrator to attach it.
    prepared: await prepareOperation(intent.action, raw, null),
  };
}
