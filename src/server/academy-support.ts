import "server-only";
import { z } from "zod";
import { getAuthenticatedActor } from "./identity";
import { createSupabase } from "./supabase";

// Ducelio Academy (B2C) AI Tutor and Lab Instructor, learner side
// (migration 063). A support request is the learner's own Tutor thread for
// one objective of a released lesson, or Lab Instructor thread for one
// started practical session; the database decides ownership, release,
// revocation and the exam firewall every time.

export const ACADEMY_SUPPORT_DENIAL_TEXT: Record<string, string> = {
  NOT_YET_STARTED:
    "This practical session has not started yet. Help opens at its scheduled time.",
  NOT_RELEASED:
    "This lesson or practical is not open in your current timetable.",
  ACTIVITY_BLOCKED:
    "AI support is closed while a controlled assessment is active.",
  ACCESS_REVOKED: "Your access to this course has ended.",
  ENROLMENT_CLOSED: "This course enrolment is no longer active.",
  SCHEDULE_SUPERSEDED:
    "Your timetable has changed. Open the practical from your current timetable.",
  NOT_A_PRACTICAL: "Lab Instructor help is available for practical sessions.",
  RATE_LIMITED:
    "Too many requests in this conversation just now. Wait a minute and try again.",
  CAPACITY_REACHED: "This conversation has reached its request limit.",
};
export const academySupportDenialText = (code: string) =>
  ACADEMY_SUPPORT_DENIAL_TEXT[code] ?? "AI support is not available here.";

export class AcademySupportUnavailable extends Error {
  constructor(readonly code: string) {
    super("Academy support unavailable.");
    this.name = "AcademySupportUnavailable";
  }
}

async function learnerRpc(name: string, args: Record<string, unknown>) {
  const actor = await getAuthenticatedActor();
  if (!actor?.roles.includes("STUDENT"))
    throw new AcademySupportUnavailable("FORBIDDEN");
  const { data, error } = await (await createSupabase()).rpc(name, args);
  if (error) throw new AcademySupportUnavailable("SERVICE_UNAVAILABLE");
  return data as unknown;
}
const refusal = z.strictObject({
  ok: z.literal(false),
  code: z.string().max(64),
});
const openedSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    requestId: z.uuid(),
    resumed: z.boolean(),
  }),
  refusal,
]);
function opened(data: unknown) {
  const parsed = openedSchema.safeParse(data);
  if (!parsed.success)
    throw new AcademySupportUnavailable("SERVICE_UNAVAILABLE");
  if (!parsed.data.ok) throw new AcademySupportUnavailable(parsed.data.code);
  return parsed.data.requestId;
}

export async function openMyAcademyTutorSupport(
  enrolmentId: unknown,
  lessonRef: unknown,
  objectiveId: unknown,
) {
  return opened(
    await learnerRpc("open_my_academy_tutor_support", {
      p_enrolment_id: z.uuid().parse(enrolmentId),
      p_lesson_ref: z.string().min(1).max(80).parse(lessonRef),
      p_objective_id: z.uuid().parse(objectiveId),
    }),
  );
}

export async function openMyAcademyLabSupport(
  enrolmentId: unknown,
  scheduleItemId: unknown,
) {
  return opened(
    await learnerRpc("open_my_academy_lab_support", {
      p_enrolment_id: z.uuid().parse(enrolmentId),
      p_schedule_item_id: z.uuid().parse(scheduleItemId),
    }),
  );
}

const requestSchema = z.strictObject({
  requestId: z.uuid(),
  enrolmentId: z.uuid(),
  role: z.enum(["TUTOR", "LAB_INSTRUCTOR"]),
  courseTitle: z.string().max(500),
  lessonRef: z.string().max(80),
  lessonTitle: z.string().max(500),
  objective: z.string().max(4000).nullable(),
  practical: z
    .strictObject({
      kind: z.enum(["EXERCISE", "PRACTICAL_LAB"]),
      title: z.string().max(200),
      instructions: z.string().max(12000),
    })
    .nullable(),
  graded: z.boolean().nullable(),
});
export type AcademySupportView = z.infer<typeof requestSchema>;

export async function getMyAcademySupportRequest(
  requestId: string,
): Promise<AcademySupportView> {
  const parsed = z
    .union([
      z.strictObject({ ok: z.literal(true), request: requestSchema }),
      refusal,
    ])
    .safeParse(
      await learnerRpc("get_my_academy_support_request", {
        p_request_id: z.uuid().parse(requestId),
      }),
    );
  if (!parsed.success)
    throw new AcademySupportUnavailable("SERVICE_UNAVAILABLE");
  if (!parsed.data.ok) throw new AcademySupportUnavailable(parsed.data.code);
  return parsed.data.request;
}

const transcriptSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    totalTurns: z.number().int().min(0),
    unrecordedExchanges: z.number().int().min(0),
    turns: z
      .array(
        z.strictObject({
          turnNumber: z.number().int().min(1).max(200),
          learnerMessage: z.string().min(1).max(2000),
          agentMessage: z.string().min(1).max(12000),
          recordedAt: z.string().min(1).max(64),
        }),
      )
      .max(50),
  }),
  refusal,
]);
export type AcademySupportTranscript = {
  turns: { learnerMessage: string; agentMessage: string }[];
  unrecordedExchanges: number;
};

// Any refusal (another learner, an active controlled assessment, revoked
// access) shows nothing.
export async function getMyAcademySupportTranscript(
  requestId: string,
): Promise<AcademySupportTranscript> {
  try {
    const parsed = transcriptSchema.safeParse(
      await learnerRpc("list_my_academy_support_turns", {
        p_request_id: z.uuid().parse(requestId),
        p_limit: 50,
      }),
    );
    if (!parsed.success || !parsed.data.ok)
      return { turns: [], unrecordedExchanges: 0 };
    return {
      turns: parsed.data.turns.map((t) => ({
        learnerMessage: t.learnerMessage,
        agentMessage: t.agentMessage,
      })),
      unrecordedExchanges: parsed.data.unrecordedExchanges,
    };
  } catch {
    return { turns: [], unrecordedExchanges: 0 };
  }
}
