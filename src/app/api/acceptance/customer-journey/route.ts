import { NextResponse } from "next/server";
import { z } from "zod";
import { offerSlugSchema } from "@/domain/commercial-v1-commerce";
import { campaignCodeSchema } from "@/domain/commercial-v1-launch";
import { DeliveryDenied } from "@/domain/delivery";
import { ClassroomDenied } from "@/domain/professor-classroom";
import { AccessDenied, AuthenticationRequired } from "@/domain/policy";
import { createSupabase } from "@/server/supabase";
import { acceptanceEnvironmentMatches } from "@/server/acceptance-app-driver";
import { customerJourneyRequestAllowed } from "@/server/acceptance-journey-driver";
import { createCommercialV1Checkout } from "@/server/commercial-v1-commerce";
import {
  confirmDeliveryStudyPlan,
  getDeliveryAgentAccess,
  getDeliveryContext,
  requestDeliveryHandoff,
  saveDeliveryStudyPlan,
} from "@/server/delivery";
import { openProfessorClassroom } from "@/server/professor-classroom";
import {
  getStudentAssessments,
  recordAssessmentResponse,
  startAssessmentAttempt,
} from "@/server/assessments";
import { submitPracticalLabWorkAndGrade } from "@/server/commercial-v1-submission-grading";
import {
  attemptCommercialV1CourseCompletion,
  getCommercialV1CourseProgress,
} from "@/server/commercial-v1-results-completion";
import {
  askProfessorAction,
  beginLessonAction,
} from "@/app/student/classroom/actions";
import {
  requestPracticalSupportAction,
  requestTutorLabSupportAction,
} from "@/app/student/practicals/actions";

// ============================================================================
// ACCEPTANCE-ONLY. Not a product API. See src/server/acceptance-journey-
// driver.ts for the fail-closed gate (404 unless every acceptance condition
// holds) and scripts/acceptance/customer-journey.mjs for its only caller.
//
// Each operation is a thin HTTP hop into an EXISTING production entrypoint,
// executed inside a real Next.js request so identity resolves exactly as it
// does for the product (Supabase SSR session cookies ->
// getAuthenticatedActor()). Where the learner product surface is a Server
// Action that owns the composition (the Professor classroom and Tutor/Lab
// support actions), that exact action is called with the same FormData
// fields its form posts. Sign-in, controlled-assessment submission/grading
// and institutional recovery are NOT here: the journey driver reuses the
// already-reviewed examiner-app route for those.
//
// This file contains no SQL, never signs anything, never reads a controller
// key, provider key or Stripe key, and never selects a role, capability,
// provider, model, profile, budget, grading capability or recovery path.
// Every schema is a strictObject: a caller-supplied actor/student/learner
// id, role, capability, provider, model, marks, score, price, entitlement,
// enrolment status or revision is rejected with 400 before any server
// function runs. Responses carry only bounded statuses, codes and
// identifiers (plus the provider stub's fixed learner-facing text) --
// never protected assessment prompts, answer keys, marking/grading guidance
// or learner response bodies.
// ============================================================================

export const dynamic = "force-dynamic";

const uuid = z.uuid();
const idempotencyKey = z.string().trim().min(8).max(100);
const message = z.string().max(2000);
const requestSchema = z.discriminatedUnion("operation", [
  // Access acquisition: the production checkout entrypoint the learner
  // "Buy" form reaches (src/app/courses/actions.ts). This schema does NOT
  // establish the campaign kind -- the production campaign authority does.
  // The safety model is: the journey driver provisions and supplies only a
  // REVIEWER_COMPLIMENTARY code, and its app child withholds every Stripe/
  // commerce credential (a paid path fails closed CHECKOUT_UNAVAILABLE), so
  // this journey makes no Stripe request and claims no paid checkout. Paid
  // checkout/webhook evidence remains `npm run acceptance:stripe`.
  z.strictObject({
    operation: z.literal("CREATE_CHECKOUT"),
    offerSlug: offerSlugSchema,
    campaignCode: campaignCodeSchema,
  }),
  // Delivery (src/server/delivery.ts). The product exposes no learner
  // Server Action for these yet, so the governed server functions are
  // called directly -- the same authority any future surface must use.
  z.strictObject({
    operation: z.literal("SAVE_STUDY_PLAN"),
    enrolmentId: uuid,
    studyDays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    localStartTime: z.string().max(5),
    timezone: z.string().max(100),
  }),
  z.strictObject({
    operation: z.literal("CONFIRM_STUDY_PLAN"),
    enrolmentId: uuid,
  }),
  z.strictObject({
    operation: z.literal("GET_DELIVERY_CONTEXT"),
    enrolmentId: uuid,
  }),
  z.strictObject({
    operation: z.literal("GET_AGENT_ACCESS"),
    enrolmentId: uuid,
  }),
  // Professor classroom (src/server/professor-classroom.ts and the learner
  // Server Actions in src/app/student/classroom/actions.ts).
  z.strictObject({
    operation: z.literal("OPEN_CLASSROOM"),
    classSessionId: uuid,
  }),
  z.strictObject({
    operation: z.literal("PROFESSOR_BEGIN_LESSON"),
    classSessionId: uuid,
    idempotencyKey,
  }),
  z.strictObject({
    operation: z.literal("PROFESSOR_ASK"),
    classSessionId: uuid,
    idempotencyKey,
    message,
  }),
  // Tutor/Lab support. The handoff reason is fixed server-side here; the
  // destination role is always derived by the production authority.
  z.strictObject({
    operation: z.literal("REQUEST_TUTOR_HANDOFF"),
    enrolmentId: uuid,
    lessonId: uuid,
    // OBJECTIVE_REINFORCEMENT is objective-specific (domain handoffInput and
    // migration 043); the id alone is relayed, never objective prose.
    objectiveId: uuid,
  }),
  z.strictObject({
    operation: z.literal("REQUEST_PRACTICAL_SUPPORT"),
    enrolmentId: uuid,
    practicalId: uuid,
    requestId: uuid,
  }),
  z.strictObject({
    operation: z.literal("TUTOR_LAB_SUPPORT"),
    handoffId: uuid,
    message,
    idempotencyKey: uuid,
  }),
  // Controlled assessment (src/server/assessments.ts): start, the learner's
  // own active-question projection, and the single server-owned response
  // writer composition.
  z.strictObject({
    operation: z.literal("START_ASSESSMENT"),
    assessmentId: uuid,
  }),
  z.strictObject({ operation: z.literal("GET_ACTIVE_QUESTIONS") }),
  z.strictObject({
    operation: z.literal("RECORD_RESPONSE"),
    attemptId: uuid,
    questionId: uuid,
    body: z.string().max(20000),
    idempotencyKey: z.string().max(200),
  }),
  // The governed FINAL practical/lab submission + Examiner lab grading
  // composition (submitPracticalLabWorkAndGrade).
  z.strictObject({
    operation: z.literal("SUBMIT_LAB_AND_GRADE"),
    enrolmentId: uuid,
    practicalId: uuid,
    body: z.string().max(20000),
    idempotencyKey: z.string().max(200),
  }),
  // Progress and completion (src/server/commercial-v1-results-completion.ts).
  z.strictObject({
    operation: z.literal("GET_PROGRESS"),
    enrolmentId: uuid,
  }),
  z.strictObject({
    operation: z.literal("ATTEMPT_COMPLETION"),
    enrolmentId: uuid,
    reason: z.string().max(300),
  }),
]);

const NO_STORE = { "Cache-Control": "private, no-store" };
function json(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}
function notFound() {
  return new NextResponse(null, { status: 404, headers: NO_STORE });
}
function ok(result: Record<string, unknown>) {
  return json(200, { ok: true, result });
}
function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

type Command = z.infer<typeof requestSchema>;

async function run(command: Command) {
  switch (command.operation) {
    case "CREATE_CHECKOUT": {
      const result = await createCommercialV1Checkout(
        command.offerSlug,
        command.campaignCode,
      );
      if (!result.ok) return ok({ ok: false, code: result.code });
      if (result.kind === "CHECKOUT")
        return ok({ ok: true, kind: "CHECKOUT", orderId: result.orderId });
      return ok({
        ok: true,
        kind: "ACCESS_GRANTED",
        entitlementId: result.entitlementId,
        enrolmentId: result.enrolmentId,
        offerSlug: result.offerSlug,
      });
    }
    case "SAVE_STUDY_PLAN":
      return ok({
        planId: await saveDeliveryStudyPlan({
          enrolmentId: command.enrolmentId,
          studyDays: command.studyDays,
          localStartTime: command.localStartTime,
          timezone: command.timezone,
        }),
      });
    case "CONFIRM_STUDY_PLAN":
      return ok({
        planId: await confirmDeliveryStudyPlan({
          enrolmentId: command.enrolmentId,
        }),
      });
    case "GET_DELIVERY_CONTEXT": {
      const context = await getDeliveryContext({
        enrolmentId: command.enrolmentId,
      });
      return ok({
        enrolmentId: context.enrolmentId,
        enrolmentStatus: context.enrolmentStatus,
        academicEligibility: context.academicEligibility,
        planId: context.plan?.id ?? null,
        planState: context.plan?.state ?? null,
        planProgrammeVersionId: context.plan?.programmeVersionId ?? null,
        occurrenceCount: context.occurrences.length,
        occurrenceLessonIds: context.occurrences.map((o) => o.lessonId),
        currentLessonId: context.currentLessonId,
      });
    }
    case "GET_AGENT_ACCESS": {
      const access = await getDeliveryAgentAccess({
        enrolmentId: command.enrolmentId,
      });
      return ok({
        enrolmentId: access.enrolmentId,
        PROFESSOR: access.PROFESSOR,
        TUTOR: access.TUTOR,
        LAB_INSTRUCTOR: access.LAB_INSTRUCTOR,
      });
    }
    case "OPEN_CLASSROOM": {
      const classroom = await openProfessorClassroom({
        classSessionId: command.classSessionId,
      });
      return ok({
        classroomId: classroom.classroomId,
        classSessionId: classroom.classSessionId,
        enrolmentId: classroom.enrolmentId,
        lessonId: classroom.lessonId,
        mode: classroom.mode,
      });
    }
    case "PROFESSOR_BEGIN_LESSON": {
      const state = await beginLessonAction(
        {},
        form({
          classSessionId: command.classSessionId,
          idempotencyKey: command.idempotencyKey,
        }),
      );
      return ok({ status: state.status ?? null, text: state.text ?? null });
    }
    case "PROFESSOR_ASK": {
      const state = await askProfessorAction(
        {},
        form({
          classSessionId: command.classSessionId,
          idempotencyKey: command.idempotencyKey,
          message: command.message,
        }),
      );
      return ok({ status: state.status ?? null, text: state.text ?? null });
    }
    case "REQUEST_TUTOR_HANDOFF":
      return ok({
        handoffId: await requestDeliveryHandoff({
          enrolmentId: command.enrolmentId,
          lessonId: command.lessonId,
          objectiveId: command.objectiveId,
          reasonCode: "OBJECTIVE_REINFORCEMENT",
        }),
      });
    case "REQUEST_PRACTICAL_SUPPORT": {
      const result = await requestPracticalSupportAction({
        enrolmentId: command.enrolmentId,
        practicalId: command.practicalId,
        requestId: command.requestId,
      });
      return ok({ ok: result.ok, handoffId: result.handoffId ?? null });
    }
    case "TUTOR_LAB_SUPPORT": {
      const state = await requestTutorLabSupportAction(
        {},
        form({
          handoffId: command.handoffId,
          message: command.message,
          idempotencyKey: command.idempotencyKey,
        }),
      );
      return ok({
        status: state.status ?? null,
        role: state.role ?? null,
        text: state.text ?? null,
      });
    }
    case "START_ASSESSMENT":
      return ok({
        attemptId: await startAssessmentAttempt(command.assessmentId),
      });
    case "GET_ACTIVE_QUESTIONS": {
      const workspace = await getStudentAssessments();
      const active = workspace.attempts.find((a) => a.state === "ACTIVE");
      // Identifiers and limits only: the released prompt text is never
      // relayed by this route.
      return ok({
        activityState: workspace.activityState,
        activeAttemptId: active?.id ?? null,
        activeAssessmentId: active?.assessment_id ?? null,
        questions: workspace.activeQuestions.map((q) => ({
          id: q.id,
          maxMarks: q.max_marks,
        })),
      });
    }
    case "RECORD_RESPONSE": {
      const outcome = await recordAssessmentResponse({
        attemptId: command.attemptId,
        questionId: command.questionId,
        body: command.body,
        idempotencyKey: command.idempotencyKey,
      });
      return ok(
        outcome.ok
          ? { ok: true, responseId: outcome.responseId }
          : { ok: false, code: outcome.code },
      );
    }
    case "SUBMIT_LAB_AND_GRADE": {
      const result = await submitPracticalLabWorkAndGrade({
        enrolmentId: command.enrolmentId,
        practicalId: command.practicalId,
        body: command.body,
        idempotencyKey: command.idempotencyKey,
      });
      return ok({ submissionId: result.submissionId, grading: result.grading });
    }
    case "GET_PROGRESS": {
      const progress = await getCommercialV1CourseProgress(command.enrolmentId);
      if (!progress.ok) return ok({ ok: false, code: progress.code });
      return ok({
        ok: true,
        components: progress.components,
        labs: progress.labs,
        courseScoreBp: progress.courseScoreBp,
        passMarkBp: progress.passMarkBp,
        pendingCount: progress.pending.length,
        enrolmentStatus: progress.enrolmentStatus,
        completed: progress.completed,
      });
    }
    case "ATTEMPT_COMPLETION": {
      const result = await attemptCommercialV1CourseCompletion({
        enrolmentId: command.enrolmentId,
        reason: command.reason,
      });
      return ok(
        result.ok
          ? { ok: true, code: result.code, receiptId: result.receiptId }
          : { ok: false, code: result.code },
      );
    }
  }
}

export async function POST(request: Request) {
  // Includes the per-request provider-redirect attestation -- before the
  // body is read, anyone is resolved or any operation runs.
  if (!(await customerJourneyRequestAllowed(request))) return notFound();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "INVALID_REQUEST" });
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) return json(400, { error: "INVALID_REQUEST" });

  // Every operation runs as the caller's EXISTING real session (established
  // through the examiner-app route's SIGN_IN), and only once that session
  // proves it belongs to the deliberately provisioned acceptance
  // environment.
  const client = await createSupabase();
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) return json(401, { error: "AUTHENTICATION_REQUIRED" });
  if (!(await acceptanceEnvironmentMatches(client))) return notFound();

  try {
    return await run(parsed.data);
  } catch (error) {
    if (error instanceof AuthenticationRequired)
      return json(401, { error: "AUTHENTICATION_REQUIRED" });
    if (error instanceof AccessDenied) return json(403, { error: "FORBIDDEN" });
    if (error instanceof DeliveryDenied)
      return json(200, {
        ok: false,
        error: "DELIVERY_DENIED",
        code: error.code,
      });
    if (error instanceof ClassroomDenied)
      return json(200, {
        ok: false,
        error: "CLASSROOM_DENIED",
        code: error.code,
      });
    return json(500, { error: "OPERATION_FAILED" });
  }
}
