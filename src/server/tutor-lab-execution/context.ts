import "server-only";
import { TutorLabExecutionDenied } from "@/domain/tutor-lab-execution";
import { practicalSchema } from "@/domain/course-activation";
import { OBJECTIVE_PAGE_SIZE } from "@/domain/learning-context";
import {
  getStudentLessonContext,
  getStudentLessonObjectives,
} from "../learning-context";
import { getStudentLessonResources } from "../learning-resources";
import { getAgentConfigForEnrolment } from "../academic-agent-config";
import { isCapabilityAuthorized } from "@/domain/academic-capability-policy";
import { createSupabase } from "../supabase";
import { getAuthenticatedActor } from "../identity";
import type { TutorLabContentRelease } from "./release";

// Bounded server-owned context, built ONLY from the exact identifiers the
// governed release proved (release.enrolmentId/lessonId/objectiveId/
// practicalId/reasonCode) -- never from arbitrary caller/browser/package
// JSON. Every underlying read independently re-derives ownership AND
// re-enforces the controlled-assessment explanation firewall for itself
// (see src/server/learning-context.ts / learning-resources.ts), exactly
// like the Professor classroom's getClassroomLessonContent.
export type TutorContext = {
  role: "TUTOR";
  reasonCode: string;
  lesson: { title: string; position: number };
  objectives: { description: string; position: number }[];
  requestedObjective: { description: string } | null;
  resources: { title: string; kind: string }[] | null;
};
export type LabContext = {
  role: "LAB_INSTRUCTOR";
  reasonCode: string;
  lesson: { title: string; position: number };
  practical: {
    kind: "EXERCISE" | "PRACTICAL_LAB";
    title: string;
    instructions: string;
  };
  objectives: { description: string; position: number }[];
};

// COURSE_PACKAGE_V1's own reviewed maximum lesson-objective count is 250
// (src/domain/course-package.ts's lessonSpecSchema); derived from the
// canonical OBJECTIVE_PAGE_SIZE rather than a second hardcoded copy, this is
// the exact, bounded traversal needed to guarantee every objective in even
// the largest legitimate lesson is reachable. A hard cap, never an
// unbounded loop.
const MAX_LESSON_OBJECTIVES = 250;
const MAX_LESSON_OBJECTIVE_PAGES = Math.ceil(
  MAX_LESSON_OBJECTIVES / OBJECTIVE_PAGE_SIZE,
);
type LessonObjective = {
  objectiveId: string;
  description: string;
  position: number;
};

// Pages through the lesson's own objectives (bounded to
// MAX_LESSON_OBJECTIVE_PAGES) until the exact requested objective is found,
// or returns null once every page has been exhausted -- never silently
// stops at the first page. Each page call independently re-derives
// ownership and re-checks the assessment firewall (getStudentLessonObjectives).
async function findLessonObjective(
  enrolmentId: string,
  lessonId: string,
  objectiveId: string,
): Promise<LessonObjective | null> {
  let afterPosition: number | undefined;
  for (let page = 0; page < MAX_LESSON_OBJECTIVE_PAGES; page++) {
    const result = await getStudentLessonObjectives({
      enrolmentId,
      lessonId,
      afterPosition,
    });
    const found = result.objectives.find(
      (o: LessonObjective) => o.objectiveId === objectiveId,
    );
    if (found) return found;
    if (result.nextAfterPosition === null) break;
    afterPosition = result.nextAfterPosition;
  }
  return null;
}

// Pages through the lesson's own objectives (bounded, same cap as above)
// resolving EXACTLY the requested set of institutional objective IDs --
// used by Lab context to resolve every one of a practical's mapped
// objectives, which may be scattered anywhere across up to 250 lesson
// positions, never only the first 50. Returns null if the DB has already
// reported no further pages while some requested ids remain unresolved --
// the caller must treat that as a fail-closed condition, never a partial
// result.
async function resolveLessonObjectives(
  enrolmentId: string,
  lessonId: string,
  objectiveIds: readonly string[],
): Promise<LessonObjective[] | null> {
  const remaining = new Set(objectiveIds);
  const resolved: LessonObjective[] = [];
  let afterPosition: number | undefined;
  for (
    let page = 0;
    page < MAX_LESSON_OBJECTIVE_PAGES && remaining.size > 0;
    page++
  ) {
    const result = await getStudentLessonObjectives({
      enrolmentId,
      lessonId,
      afterPosition,
    });
    for (const objective of result.objectives as LessonObjective[]) {
      if (remaining.delete(objective.objectiveId)) resolved.push(objective);
    }
    if (result.nextAfterPosition === null) break;
    afterPosition = result.nextAfterPosition;
  }
  return remaining.size === 0 ? resolved : null;
}

async function requiredCapability(
  role: "TUTOR" | "LAB_INSTRUCTOR",
  enrolmentId: string,
  capability: string,
): Promise<boolean> {
  const config = await getAgentConfigForEnrolment(enrolmentId, role);
  if (!config.enabled) return false;
  return isCapabilityAuthorized(role, capability, config.capabilities);
}

async function optionalCapability(
  role: "TUTOR" | "LAB_INSTRUCTOR",
  enrolmentId: string,
  capability: string,
): Promise<boolean> {
  return requiredCapability(role, enrolmentId, capability);
}

// Thrown when a required, code-owned-catalogue capability is not present in
// the enrolment's own stored academic-agent configuration: configuration
// can only narrow what a role may do, never widen it, and a disabled/
// missing configuration must fail closed rather than silently proceed with
// an incomplete or over-broad context.
//
// The reason code passed to the provider is ALWAYS the server-derived
// release.reasonCode (the real handoff reason -- MISSED_LESSON_PRACTICE/
// OBJECTIVE_REINFORCEMENT/PRACTICAL_PREREQUISITE), never the role name and
// never caller-supplied.
export async function buildTutorContext(
  release: TutorLabContentRelease,
): Promise<TutorContext> {
  if (
    !(await requiredCapability(
      "TUTOR",
      release.enrolmentId,
      "get_lesson_context",
    )) ||
    !(await requiredCapability(
      "TUTOR",
      release.enrolmentId,
      "get_lesson_objectives",
    ))
  )
    throw new TutorLabExecutionDenied("POLICY_BLOCKED");
  const lesson = await getStudentLessonContext({
    enrolmentId: release.enrolmentId,
    lessonId: release.lessonId,
  });
  // A bounded first-page sample only, for general orientation ("objectives
  // covered in this lesson") -- never automatically dumping all 250 merely
  // because they exist. The learner's actually-requested objective (below)
  // is resolved exactly, regardless of its position.
  const overviewPage = await getStudentLessonObjectives({
    enrolmentId: release.enrolmentId,
    lessonId: release.lessonId,
  });
  let requestedObjective: LessonObjective | null = null;
  if (release.objectiveId) {
    requestedObjective = await findLessonObjective(
      release.enrolmentId,
      release.lessonId,
      release.objectiveId,
    );
    // OBJECTIVE_REINFORCEMENT (the only reason that ever carries an
    // objectiveId for Tutor) must never reach the provider with a null
    // requestedObjective -- fail closed rather than silently omit it.
    if (!requestedObjective)
      throw new TutorLabExecutionDenied("CONTEXT_CONFLICT");
  }
  let resources: { title: string; kind: string }[] | null = null;
  if (
    await optionalCapability(
      "TUTOR",
      release.enrolmentId,
      "get_learning_resources",
    )
  ) {
    const page = await getStudentLessonResources({
      enrolmentId: release.enrolmentId,
      lessonId: release.lessonId,
    });
    resources = page.resources.map((r: { title: string; kind: string }) => ({
      title: r.title,
      kind: r.kind,
    }));
  }
  return {
    role: "TUTOR",
    reasonCode: release.reasonCode,
    lesson: { title: lesson.title, position: lesson.position },
    objectives: overviewPage.objectives.map(
      (o: { description: string; position: number }) => ({
        description: o.description,
        position: o.position,
      }),
    ),
    requestedObjective: requestedObjective
      ? { description: requestedObjective.description }
      : null,
    resources,
  };
}

// Reads the exact institutional course_practicals row the governed release
// already proved belongs to this learner's own activated cohort/version
// (migration 028's get_owned_practical, itself re-deriving ownership a
// second time server-side, defense in depth). Never reads
// course_package_imports.raw_package. Resolves EVERY one of the practical's
// own mapped objective IDs, not only whichever happen to fall on the first
// page -- a practical's objectiveRefs may reference objectives anywhere
// across up to 250 lesson positions (src/domain/course-package.ts).
export async function buildLabContext(
  release: TutorLabContentRelease,
): Promise<LabContext> {
  if (
    !(await requiredCapability(
      "LAB_INSTRUCTOR",
      release.enrolmentId,
      "get_lesson_context",
    )) ||
    !(await requiredCapability(
      "LAB_INSTRUCTOR",
      release.enrolmentId,
      "get_lesson_objectives",
    ))
  )
    throw new TutorLabExecutionDenied("POLICY_BLOCKED");
  if (!release.practicalId)
    throw new TutorLabExecutionDenied("CONTEXT_CONFLICT");
  const lesson = await getStudentLessonContext({
    enrolmentId: release.enrolmentId,
    lessonId: release.lessonId,
  });
  const actor = await getAuthenticatedActor();
  if (!actor) throw new TutorLabExecutionDenied("UNAUTHENTICATED");
  const client = await createSupabase();
  const { data, error } = await client.rpc("get_owned_practical", {
    p_enrolment_id: release.enrolmentId,
    p_practical_id: release.practicalId,
  });
  if (error) throw new TutorLabExecutionDenied("CONTEXT_CONFLICT");
  const practical = practicalSchema.parse(data);
  if (practical.lessonId !== release.lessonId)
    throw new TutorLabExecutionDenied("CONTEXT_CONFLICT");
  const objectives = await resolveLessonObjectives(
    release.enrolmentId,
    release.lessonId,
    practical.objectiveIds,
  );
  // Never send a partial practical-objective set: every mapped objective
  // must resolve, or this fails closed rather than silently narrowing scope.
  if (!objectives || objectives.length !== practical.objectiveIds.length)
    throw new TutorLabExecutionDenied("CONTEXT_CONFLICT");
  return {
    role: "LAB_INSTRUCTOR",
    reasonCode: release.reasonCode,
    lesson: { title: lesson.title, position: lesson.position },
    practical: {
      kind: practical.kind,
      title: practical.title,
      instructions: practical.instructions,
    },
    objectives: objectives.map((o) => ({
      description: o.description,
      position: o.position,
    })),
  };
}
