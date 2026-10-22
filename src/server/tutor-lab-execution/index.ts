import "server-only";
import { randomUUID, createHash } from "node:crypto";
import {
  TUTOR_LAB_EXECUTION_DB_CEILING,
  mapRuntimeResultToTutorLabFinalizeCommand,
  mapRuntimeResultToTutorLabOutcome,
  tutorLabInteractionFingerprintMaterial,
  tutorLabReservationRpcResultSchema,
  TutorLabExecutionDenied,
  type TutorLabRole,
  type TutorLabSupportRequest,
} from "@/domain/tutor-lab-execution";
import { zeroUsage, type RuntimeResult } from "@/domain/academic-runtime";
import { requireStudentPrincipal } from "../identity";
import { createSupabase } from "../supabase";
import {
  beginTutorLabContentRelease,
  closeTutorLabContentRelease,
  TutorLabContentReleaseDenied,
  type TutorLabContentRelease,
} from "./release";
import {
  attestTutorLabExecutionCommand,
  closeUnstartedTutorLabExecution,
} from "./authority";
import { buildTutorContext, buildLabContext } from "./context";
import {
  resolveAdapterForProfile,
  resolveRoleBoundRuntimeProfile,
} from "../academic-runtime/profile-registry";
import { runGovernedProviderExecution } from "../academic-runtime/runtime";
import { getAgentConfigForEnrolment } from "../academic-agent-config";
import { isCapabilityAuthorized } from "@/domain/academic-capability-policy";
import { getAgentBehaviourForEnrolment } from "../agent-behaviour-config";
import { buildTutorLabProviderContext } from "@/domain/tutor-lab-provider-context";
import {
  PROFESSOR_TEACHING_RECORD_AWARE_VERSIONS,
  roleBaselineFor,
  type EffectiveAgentBehaviour,
} from "@/domain/agent-behaviour";
import type { ProfessorTeachingRecord } from "@/domain/professor-academic-handoff";
import { getProfessorTeachingRecordForRelease } from "../professor-academic-handoff";
import {
  TUTOR_CLASS_NOTE_BODY_MAX,
  isStorableTutorClassNoteBody,
  tutorClassNoteBodyLength,
  tutorClassNoteOutcomeForRefusal,
  type TutorClassNoteOutcome,
} from "@/domain/tutor-class-notes";
import {
  recordTutorClassNote,
  TutorClassNoteRefused,
} from "../tutor-class-notes";

export type TutorLabSupportResult =
  | {
      status: "SUCCEEDED";
      text: string;
      role: TutorLabRole;
      // AC-4: present only when the learner asked to keep a Tutor answer.
      classNote?: TutorClassNoteOutcome;
    }
  | { status: "ACTIVITY_BLOCKED" }
  | { status: "UNAVAILABLE" }
  | { status: "ESCALATED" }
  | { status: "RETRY_LATER" }
  | { status: "DUPLICATE" };

function outcomeToResult(
  outcome: ReturnType<typeof mapRuntimeResultToTutorLabOutcome>,
  role: TutorLabRole,
): TutorLabSupportResult {
  if (outcome.kind === "SUCCEEDED")
    return { status: "SUCCEEDED", text: outcome.text, role };
  return { status: outcome.kind };
}

// Reservation happens BEFORE any release/provider work, so two simultaneous
// duplicate actions can never knowingly reach the provider twice. The
// fingerprint covers the handoff, the message and (AC-4) the note choice
// (tutorLabInteractionFingerprintMaterial). A mismatched replay (same key,
// different handoff, message or note choice) fails closed as a conflict,
// mapped here to a safe UNAVAILABLE rather than propagating the raw
// conflict code to the learner.
async function reserveInteraction(
  handoffId: string,
  idempotencyKey: string,
  message: string,
  saveAsClassNote: boolean,
): Promise<boolean> {
  const requestHash = createHash("sha256")
    .update(
      tutorLabInteractionFingerprintMaterial(
        handoffId,
        message,
        saveAsClassNote,
      ),
      "utf8",
    )
    .digest("hex");
  const client = await createSupabase();
  const { data, error } = await client.rpc("reserve_tutor_lab_interaction", {
    p_handoff_id: handoffId,
    p_idempotency_key: idempotencyKey,
    p_request_hash: requestHash,
  });
  if (error) throw new TutorLabExecutionDenied("SERVICE_UNAVAILABLE");
  const result = tutorLabReservationRpcResultSchema.safeParse(data);
  if (!result.success) throw new TutorLabExecutionDenied("SERVICE_UNAVAILABLE");
  if (!result.data.ok) throw new TutorLabExecutionDenied("SERVICE_UNAVAILABLE");
  return !result.data.duplicate;
}

// The single governed entrypoint for learner-requested Tutor/Lab support.
// Never trusts a caller-supplied role/enrolment/lesson/objective/practical:
// beginTutorLabContentRelease re-derives handoff ownership and destination
// role entirely server-side. Preserves the same critical guarantee as
// Professor's runtime (docs/19-live-professor-execution.md): no SUCCEEDED
// response ever escapes before the content release has closed successfully
// AND the FINALIZE call is itself confirmed by the database.
export async function executeTutorLabSupport(
  request: TutorLabSupportRequest,
): Promise<TutorLabSupportResult> {
  await requireStudentPrincipal();

  let proceed: boolean;
  try {
    proceed = await reserveInteraction(
      request.handoffId,
      request.idempotencyKey,
      request.message,
      // Omitted and false are the same no-note request.
      request.saveAsClassNote === true,
    );
  } catch {
    return { status: "UNAVAILABLE" };
  }
  if (!proceed) return { status: "DUPLICATE" };

  let release: TutorLabContentRelease;
  try {
    release = await beginTutorLabContentRelease(
      randomUUID(),
      request.handoffId,
    );
  } catch (error) {
    if (
      error instanceof TutorLabContentReleaseDenied &&
      error.code === "ACTIVITY_BLOCKED"
    )
      return { status: "ACTIVITY_BLOCKED" };
    return { status: "UNAVAILABLE" };
  }

  let contextBuildOk = false;
  let providerResult: RuntimeResult | null = null;
  let providerExecutionId: string | null = null;
  let providerExecutionStarted = false;
  let providerExecutionAuthorized = false;

  try {
    const context =
      release.role === "TUTOR"
        ? await buildTutorContext(release)
        : await buildLabContext(release);
    contextBuildOk = true;
    const config = await getAgentConfigForEnrolment(
      release.enrolmentId,
      release.role,
    );
    // Correction pass (independent review, final blocker): the context
    // builders (buildTutorContext/buildLabContext) already re-checked
    // capabilities against the configuration THEY read, but that read
    // happened before this one -- an admin narrowing capabilities in
    // between (while leaving the role enabled and its profile ref
    // unchanged) would otherwise let a provider call proceed on content
    // this, the LATEST configuration, no longer authorizes. Re-validate
    // here, against this final config, using the exact same code-owned
    // catalogue (never a second allowlist): the two capabilities every
    // context always needs, plus get_learning_resources ONLY when the
    // already-built Tutor context actually included resources (an
    // optional capability that contributed no content never blocks
    // execution). This check runs BEFORE AUTHORIZE and before any
    // provider call.
    const requiredCapabilities: readonly string[] =
      context.role === "TUTOR" && context.resources !== null
        ? ([
            "get_lesson_context",
            "get_lesson_objectives",
            "get_learning_resources",
          ] as const)
        : (["get_lesson_context", "get_lesson_objectives"] as const);
    const stillAuthorized =
      config.enabled &&
      requiredCapabilities.every((capability) =>
        isCapabilityAuthorized(release.role, capability, config.capabilities),
      );
    // AC-2 LEVEL 3: the effective programme behaviour for the learner's own
    // enrolment, resolved before AUTHORIZE; failure fails closed.
    let behaviour: EffectiveAgentBehaviour | null = null;
    // AC-3: the governed Professor academic handoff projection for this
    // exact release, read only when the pinned role version is told what it
    // means. A refused or malformed read fails closed (POLICY_BLOCKED).
    let teachingRecord: ProfessorTeachingRecord | null = null;
    if (stillAuthorized) {
      try {
        behaviour = await getAgentBehaviourForEnrolment(
          release.enrolmentId,
          release.role,
        );
      } catch {
        behaviour = null;
      }
      // The pinned role behaviour version must have reviewed text here.
      if (
        behaviour &&
        !roleBaselineFor(release.role, behaviour.behaviourVersion)
      )
        behaviour = null;
      if (
        behaviour &&
        PROFESSOR_TEACHING_RECORD_AWARE_VERSIONS.has(behaviour.behaviourVersion)
      ) {
        try {
          teachingRecord = await getProfessorTeachingRecordForRelease(
            release.releaseId,
          );
        } catch {
          behaviour = null;
        }
      }
    }
    if (!stillAuthorized || !behaviour) {
      providerResult = {
        outcome: "ABSTAINED",
        usage: zeroUsage(),
        reason: "POLICY_BLOCKED",
      };
    } else {
      // PR16A: role-bound resolution through the single shared mechanism
      // (src/server/academic-runtime/profile-registry.ts's
      // resolveRoleBoundRuntimeProfile, backed by domain
      // ROLE_RUNTIME_PROFILE_POLICY) replaces this role's own independently-
      // owned TUTOR_LAB_ROLE_PROFILE_REF map -- existence in the shared
      // runtime-profile registry is NEVER sufficient authorization on its
      // own -- the registry also holds PROFESSOR_COMMERCIAL_V1 and every
      // other role's profile, so a stored config naming any resolvable ref
      // would otherwise let Tutor execute with Lab's (or Professor's, or
      // Examiner's) profile and vice versa. The ONLY ref this role may ever
      // execute with is its own exact allowed ref; a null stored ref
      // defaults to it, but a non-null stored ref that names anything else
      // fails closed here, before AUTHORIZE and before any provider call.
      const profile = resolveRoleBoundRuntimeProfile(
        release.role,
        config.modelProfileRef,
      );
      if (!profile) {
        providerResult = {
          outcome: "ABSTAINED",
          usage: zeroUsage(),
          reason: "UNKNOWN_MODEL_PROFILE",
        };
      } else {
        providerExecutionId = randomUUID();
        const budget = {
          maxProviderCalls: TUTOR_LAB_EXECUTION_DB_CEILING.maxProviderCalls,
          maxOutputTokens: Math.min(
            profile.budgetPolicy.maxOutputTokens,
            TUTOR_LAB_EXECUTION_DB_CEILING.maxOutputTokens,
          ),
          maxEstimatedCostMicrousd: Math.min(
            profile.budgetPolicy.maxEstimatedCostMicrousd,
            TUTOR_LAB_EXECUTION_DB_CEILING.maxEstimatedCostMicrousd,
          ),
        };
        try {
          await attestTutorLabExecutionCommand(
            release.role,
            providerExecutionId,
            release,
            { operation: "AUTHORIZE", budget },
          );
          providerExecutionAuthorized = true;
          await attestTutorLabExecutionCommand(
            release.role,
            providerExecutionId,
            release,
            { operation: "START" },
          );
          providerExecutionStarted = true;
          const adapter = resolveAdapterForProfile(profile);
          const effectivePolicy = {
            ...profile.budgetPolicy,
            maxProviderCalls: budget.maxProviderCalls,
            maxOutputTokens: budget.maxOutputTokens,
            maxEstimatedCostMicrousd: budget.maxEstimatedCostMicrousd,
          };
          providerResult = await runGovernedProviderExecution(
            adapter,
            {
              role: release.role,
              capability: "tutor_lab_support",
              context: buildTutorLabProviderContext(
                context,
                request.message,
                behaviour.config.courseContextNotes,
                profile.budgetPolicy.maxInputContextBytes,
                behaviour.behaviourVersion,
                teachingRecord,
              ),
              behaviour,
            },
            effectivePolicy,
          );
        } catch (error) {
          if (!(error instanceof TutorLabExecutionDenied)) throw error;
          providerResult = {
            outcome: "ABSTAINED",
            usage: zeroUsage(),
            reason:
              error.code === "ACTIVITY_BLOCKED"
                ? "ACTIVITY_BLOCKED"
                : "POLICY_BLOCKED",
          };
          // Nothing has STARTED: an admitted execution, or one whose
          // AUTHORIZE response was lost, is abandoned at once (migration
          // 064) unless the database already closed it.
          if (
            (providerExecutionAuthorized ||
              error.code === "SERVICE_UNAVAILABLE") &&
            !error.databaseTerminal
          )
            await closeUnstartedTutorLabExecution(
              release.role,
              providerExecutionId,
              release,
              "INTERNAL_ERROR",
            );
        }
      }
    }
  } catch (error) {
    contextBuildOk = false;
    const activityBlocked =
      error instanceof TutorLabExecutionDenied &&
      error.code === "ACTIVITY_BLOCKED";
    providerResult = {
      outcome: "ABSTAINED",
      usage: zeroUsage(),
      reason: activityBlocked ? "ACTIVITY_BLOCKED" : "POLICY_BLOCKED",
    };
  }

  let releaseClosedOk = false;
  try {
    await closeTutorLabContentRelease(release, contextBuildOk);
    releaseClosedOk = true;
  } catch {
    releaseClosedOk = false;
  }

  if (!releaseClosedOk) {
    if (providerExecutionStarted && providerExecutionId) {
      try {
        await attestTutorLabExecutionCommand(
          release.role,
          providerExecutionId,
          release,
          {
            operation: "FINALIZE",
            state: "FAILED",
            reason: "CONTENT_RELEASE_UNAVAILABLE",
            budgetStage: null,
            usage: providerResult?.usage ?? zeroUsage(),
          },
        );
      } catch {
        // Lazy DB-owned expiry remains the backstop.
      }
    }
    return { status: "UNAVAILABLE" };
  }

  if (!providerResult) return { status: "UNAVAILABLE" };
  if (!providerExecutionStarted || !providerExecutionId)
    return outcomeToResult(
      mapRuntimeResultToTutorLabOutcome(providerResult),
      release.role,
    );

  try {
    const finalizeCommand =
      mapRuntimeResultToTutorLabFinalizeCommand(providerResult);
    const snapshot = await attestTutorLabExecutionCommand(
      release.role,
      providerExecutionId,
      release,
      { operation: "FINALIZE", ...finalizeCommand },
    );
    if (snapshot.state !== finalizeCommand.state)
      return { status: "RETRY_LATER" };
  } catch {
    return { status: "RETRY_LATER" };
  }
  const result = outcomeToResult(
    mapRuntimeResultToTutorLabOutcome(providerResult),
    release.role,
  );
  // AC-4: the ONLY class-note creation point. Reached only after the
  // release closed COMPLETED and FINALIZE was confirmed SUCCEEDED by the
  // database, for the TUTOR role, when the learner asked beforehand. The
  // body is exactly the learner-visible answer returned below; the
  // execution id is this server's own. A note that cannot be kept never
  // changes the confirmed answer: the learner is told why.
  if (
    request.saveAsClassNote === true &&
    result.status === "SUCCEEDED" &&
    release.role === "TUTOR"
  )
    result.classNote = await keepTutorClassNote(
      providerExecutionId,
      result.text,
    );
  return result;
}

async function keepTutorClassNote(
  executionId: string,
  body: string,
): Promise<TutorClassNoteOutcome> {
  if (tutorClassNoteBodyLength(body) > TUTOR_CLASS_NOTE_BODY_MAX)
    return { state: "NOT_SAVED", reason: "TOO_LONG" };
  if (!isStorableTutorClassNoteBody(body))
    return { state: "NOT_SAVED", reason: "UNAVAILABLE" };
  try {
    const recorded = await recordTutorClassNote({ executionId, body });
    return { state: "SAVED", revisionNumber: recorded.revisionNumber };
  } catch (error) {
    return tutorClassNoteOutcomeForRefusal(
      error instanceof TutorClassNoteRefused
        ? error.code
        : "SERVICE_UNAVAILABLE",
    );
  }
}
