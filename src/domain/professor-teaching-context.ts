import { z } from "zod";
import type { CapabilityOutput } from "./academic-capabilities";
import type { ProfessorClassroomInteraction } from "./professor-classroom";

// AC-2: the Professor's LEVEL-4 runtime context, built deterministically from
// server-derived facts only, and bounded to the runtime profile's input
// budget. Pure: no server built-ins, no database, no environment.
//
// Everything here is provider DATA, never instructions. Authoritative state
// (curriculum, published objectives, persisted mastery, classroom timing) is
// labelled separately from non-authoritative state (the learner-visible
// classroom memory and any instructional estimate the model forms).

export const PROFESSOR_TEACHING_CONTEXT_POLICY =
  "PROFESSOR_TEACHING_CONTEXT_V1" as const;

// Deterministic per-item caps for OPTIONAL context, applied before
// whole-context budgeting. Objectives are never capped or dropped: the
// complete authoritative objective set is mandatory, or the call is refused.
export const TEACHING_CONTEXT_LIMITS = Object.freeze({
  memoryTurns: 12,
  memoryMessageChars: 1200,
  resourceExcerptChars: 2000,
  safetyMarginBytes: 256,
});

const timestamp = z.string().min(1).max(64);

export const classroomStateSchema = z.strictObject({
  classroomId: z.uuid(),
  classSessionId: z.uuid(),
  enrolmentId: z.uuid(),
  programmeVersionId: z.uuid(),
  lessonId: z.uuid(),
  lessonTitle: z.string().max(500),
  lessonPosition: z.number().int().positive(),
  moduleTitle: z.string().max(500),
  scheduledStart: timestamp,
  scheduledEnd: timestamp,
  serverNow: timestamp,
  mode: z.enum(["LIVE", "CATCH_UP"]),
});
export type ClassroomState = z.infer<typeof classroomStateSchema>;
export const classroomStateResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), state: classroomStateSchema }),
  z.strictObject({ ok: z.literal(false), code: z.string().max(64) }),
]);

export const classroomTurnSchema = z.strictObject({
  turnNumber: z.number().int().min(1).max(200),
  interactionKind: z.enum(["BEGIN_LESSON", "LEARNER_QUESTION"]),
  learnerMessage: z.string().min(1).max(2000).nullable(),
  professorMessage: z.string().min(1).max(12000),
  recordedAt: timestamp,
});
export type ClassroomTurn = z.infer<typeof classroomTurnSchema>;
export const CLASSROOM_MEMORY_CAPACITY = 200;
export const classroomTurnsResultSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    totalTurns: z.number().int().min(0).max(CLASSROOM_MEMORY_CAPACITY),
    capacity: z.literal(CLASSROOM_MEMORY_CAPACITY),
    capacityReached: z.boolean(),
    // Exchanges shown to the learner whose turn was never recorded.
    unrecordedExchanges: z.number().int().min(0),
    turns: z.array(classroomTurnSchema).max(50),
  }),
  z.strictObject({ ok: z.literal(false), code: z.string().max(64) }),
]);

export type TeachingContextInput = {
  classroom: ClassroomState;
  objectives: CapabilityOutput<"get_lesson_objectives">;
  mastery: CapabilityOutput<"get_current_mastery_state"> | null;
  resources: CapabilityOutput<"get_learning_resources"> | null;
  turns: readonly ClassroomTurn[];
  totalTurns: number;
  unrecordedExchanges: number;
  courseContextNotes: string | null;
  // The role behaviour version pinned by the programme version's binding.
  behaviourVersion: string;
  interaction: ProfessorClassroomInteraction;
};

export type TeachingContextReport = {
  objectivesIncluded: number;
  memoryTurnsIncluded: number;
  resourcesIncluded: number;
  resourceExcerptsTruncated: boolean;
  courseContextNotesOmitted: boolean;
  bytes: number;
};

export type TeachingContextResult =
  | {
      ok: true;
      context: Record<string, unknown>;
      report: TeachingContextReport;
    }
  | {
      ok: false;
      reason:
        | "MANDATORY_CONTEXT_EXCEEDS_BUDGET"
        | "NO_OBJECTIVES"
        | "OBJECTIVES_INCOMPLETE";
    };

function clip(text: string, chars: number): { text: string; clipped: boolean } {
  const points = Array.from(text);
  return points.length <= chars
    ? { text, clipped: false }
    : { text: `${points.slice(0, chars).join("")}…`, clipped: true };
}
const encoder = new TextEncoder();
export function contextBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}

// Remaining minutes are derived only from database-supplied instants, and
// only in a LIVE class. A catch-up classroom has no class clock.
export function deriveTiming(classroom: ClassroomState) {
  const end = Date.parse(classroom.scheduledEnd);
  const now = Date.parse(classroom.serverNow);
  const live = classroom.mode === "LIVE";
  return {
    authority: "AUTHORITATIVE_DATABASE_CLOCK",
    mode: classroom.mode,
    scheduledStart: classroom.scheduledStart,
    scheduledEnd: classroom.scheduledEnd,
    serverNow: classroom.serverNow,
    remainingMinutes: live
      ? Math.max(0, Math.floor((end - now) / 60_000))
      : null,
    note: live
      ? "Live class: remaining minutes are derived by Ducelio from the scheduled end and the database clock."
      : "Catch-up after the scheduled class: no class clock applies and no remaining time exists.",
  };
}

// Mandatory: role, behaviour version, lesson identity, the COMPLETE
// authoritative objective set (full descriptions, in published order),
// authoritative timing and the learner interaction. If they do not fit, or
// the governed read reports more objectives than it returned, the call is
// refused before any provider call: the Professor never teaches a partial
// curriculum. Optional context is then added in order and may be dropped
// or truncated deterministically: course context notes, recent classroom
// memory (newest first), then resources (full, then identity only).
export function buildProfessorTeachingContext(
  input: TeachingContextInput,
  budgetBytes: number,
): TeachingContextResult {
  if (input.objectives.nextAfterPosition !== null)
    return { ok: false, reason: "OBJECTIVES_INCOMPLETE" };
  const objectives = input.objectives.objectives;
  if (objectives.length === 0) return { ok: false, reason: "NO_OBJECTIVES" };

  const limit = budgetBytes - TEACHING_CONTEXT_LIMITS.safetyMarginBytes;
  const fits = (value: unknown) => contextBytes(value) <= limit;
  const masteryByObjective = new Map(
    (input.mastery?.records ?? []).map((r) => [r.objectiveId, r.state]),
  );

  const context = {
    role: "PROFESSOR",
    behaviourVersion: input.behaviourVersion,
    contextPolicy: PROFESSOR_TEACHING_CONTEXT_POLICY,
    programmeContextNotes: {
      authority: "PROGRAMME_AUTHORED_SUBORDINATE_DATA",
      text: null as string | null,
      omitted: input.courseContextNotes !== null,
    },
    serverContext: {
      authority: "AUTHORITATIVE_SERVER_DERIVED",
      lesson: {
        programmeVersionId: input.classroom.programmeVersionId,
        moduleTitle: input.classroom.moduleTitle,
        lessonId: input.classroom.lessonId,
        lessonTitle: input.classroom.lessonTitle,
        lessonPosition: input.classroom.lessonPosition,
      },
      timing: deriveTiming(input.classroom),
      // Complete and in published order; never truncated.
      objectives: objectives.map((objective) => ({
        objectiveId: objective.objectiveId,
        position: objective.position,
        description: objective.description,
        authoritativeMasteryState: input.mastery
          ? (masteryByObjective.get(objective.objectiveId) ?? "NO_RECORD")
          : "NOT_AVAILABLE",
      })),
      objectiveListComplete: true,
      authoritativeMastery: input.mastery
        ? {
            available: true,
            note: "Persisted mastery produced by Ducelio's evidence process. It is not changed by this conversation.",
          }
        : {
            available: false,
            note: "Authoritative mastery is not available to this Professor configuration.",
          },
      lessonProgress: {
        available: false,
        note: "Lesson segment progress is not part of the Professor's governed read boundary.",
      },
      resources: [] as Record<string, unknown>[],
      resourcesOmitted: 0,
      moreResourcesExist: Boolean(input.resources?.nextCursor),
    },
    classroomMemory: {
      authority: "NON_AUTHORITATIVE_LEARNER_VISIBLE_TRANSCRIPT",
      continuity: input.unrecordedExchanges > 0 ? "DEGRADED" : "COMPLETE",
      unrecordedExchanges: input.unrecordedExchanges,
      note:
        input.unrecordedExchanges > 0
          ? "Some earlier exchanges in this classroom were shown to the learner but could not be recorded. Do not assume you know everything already discussed; ask the learner when it matters."
          : "Recorded learner-visible exchanges of this classroom. Older turns beyond those included are not shown here.",
      totalTurns: input.totalTurns,
      turns: [] as Record<string, unknown>[],
    },
    instructionalState: {
      authority: "NON_AUTHORITATIVE",
      note: "Any understanding estimate you form is a teaching signal only, never mastery, a grade, evidence, progress or completion.",
    },
    learnerInteraction: input.interaction,
  };

  // 1. Mandatory context, including every objective.
  if (!fits(context))
    return { ok: false, reason: "MANDATORY_CONTEXT_EXCEEDS_BUDGET" };

  // 2. Optional: programme course-context notes, whole or not at all.
  if (input.courseContextNotes !== null) {
    context.programmeContextNotes = {
      ...context.programmeContextNotes,
      text: input.courseContextNotes,
      omitted: false,
    };
    if (!fits(context))
      context.programmeContextNotes = {
        ...context.programmeContextNotes,
        text: null,
        omitted: true,
      };
  }

  // 3. Optional: recent learner-visible memory, newest first, then restored
  //    to order.
  const recent = [...input.turns]
    .sort((a, b) => b.turnNumber - a.turnNumber)
    .slice(0, TEACHING_CONTEXT_LIMITS.memoryTurns);
  const kept: Record<string, unknown>[] = [];
  for (const turn of recent) {
    const entry = {
      turnNumber: turn.turnNumber,
      interactionKind: turn.interactionKind,
      learnerMessage:
        turn.learnerMessage === null
          ? null
          : clip(
              turn.learnerMessage,
              TEACHING_CONTEXT_LIMITS.memoryMessageChars,
            ).text,
      professorMessage: clip(
        turn.professorMessage,
        TEACHING_CONTEXT_LIMITS.memoryMessageChars,
      ).text,
    };
    context.classroomMemory.turns = [entry, ...kept];
    if (!fits(context)) {
      context.classroomMemory.turns = kept;
      break;
    }
    kept.unshift(entry);
  }
  context.classroomMemory.turns = kept;

  // 4. Optional: supplementary curriculum resources, full then identity
  //    only, in published order.
  let excerptsTruncated = false;
  const resources = input.resources?.resources ?? [];
  for (const resource of resources) {
    const excerpt =
      resource.kind === "LECTURE_NOTE"
        ? clip(resource.body, TEACHING_CONTEXT_LIMITS.resourceExcerptChars)
        : null;
    const full = {
      title: resource.title,
      kind: resource.kind,
      position: resource.position,
      url: resource.kind === "REFERENCE_LINK" ? resource.url : null,
      excerpt: excerpt?.text ?? null,
    };
    context.serverContext.resources.push(full);
    if (fits(context)) {
      excerptsTruncated ||= excerpt?.clipped ?? false;
      continue;
    }
    context.serverContext.resources.pop();
    const identityOnly = { ...full, excerpt: null };
    context.serverContext.resources.push(identityOnly);
    if (fits(context)) {
      excerptsTruncated ||= excerpt !== null;
      continue;
    }
    context.serverContext.resources.pop();
    break;
  }
  context.serverContext.resourcesOmitted =
    resources.length - context.serverContext.resources.length;

  return {
    ok: true,
    context,
    report: {
      objectivesIncluded: context.serverContext.objectives.length,
      memoryTurnsIncluded: context.classroomMemory.turns.length,
      resourcesIncluded: context.serverContext.resources.length,
      resourceExcerptsTruncated: excerptsTruncated,
      courseContextNotesOmitted: context.programmeContextNotes.omitted,
      bytes: contextBytes(context),
    },
  };
}
