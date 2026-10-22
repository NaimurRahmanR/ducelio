import "server-only";
import { z } from "zod";
import { getAuthenticatedActor } from "./identity";
import { createSupabase } from "./supabase";
import {
  getAcademyClassroomState,
  listAcademyClassroomTurns,
} from "./academic-runtime/academy-professor";
import type { LearnerClassroomTranscript } from "./academic-runtime/professor-teaching";

// Ducelio Academy (B2C) AI classroom, learner side (migration 062). The
// classroom identity is derived by the database from the learner's own
// scheduled LESSON session; nothing about ownership, timing, release,
// revocation or the exam firewall is decided here.

export const ACADEMY_CLASS_DENIAL_TEXT: Record<string, string> = {
  NOT_YET_STARTED:
    "This class has not started yet. It opens at its scheduled time.",
  NOT_RELEASED:
    "This lesson is not released by your current timetable, so the class is closed.",
  ACTIVITY_BLOCKED:
    "Classes and lesson content are closed while a controlled assessment is active.",
  ACCESS_REVOKED: "Your access to this course has ended.",
  ENROLMENT_CLOSED: "This course enrolment is no longer active.",
  SCHEDULE_SUPERSEDED:
    "Your timetable has changed. Enter the class from your current timetable.",
  NOT_A_CLASS: "Only scheduled lessons have an AI class.",
};
export const academyClassDenialText = (code: string) =>
  ACADEMY_CLASS_DENIAL_TEXT[code] ?? "This class is not available.";

export class AcademyClassDenied extends Error {
  constructor(readonly code: string) {
    super("Academy class unavailable.");
    this.name = "AcademyClassDenied";
  }
}

async function learnerRpc(name: string, args: Record<string, unknown>) {
  const actor = await getAuthenticatedActor();
  if (!actor?.roles.includes("STUDENT"))
    throw new AcademyClassDenied("FORBIDDEN");
  const { data, error } = await (await createSupabase()).rpc(name, args);
  if (error) throw new AcademyClassDenied("SERVICE_UNAVAILABLE");
  return data as unknown;
}
const refusal = z.strictObject({
  ok: z.literal(false),
  code: z.string().max(64),
});

// "Enter AI class" from the timetable: opens (or resumes) the classroom of
// one scheduled LESSON session. Opening is recorded as "class opened"
// only; it is not attendance, study, evidence or mastery.
export async function openMyAcademyClass(
  enrolmentId: unknown,
  scheduleItemId: unknown,
): Promise<{ classroomId: string; resumed: boolean }> {
  const parsed = z
    .union([
      z.strictObject({
        ok: z.literal(true),
        classroomId: z.uuid(),
        resumed: z.boolean(),
      }),
      refusal,
    ])
    .safeParse(
      await learnerRpc("open_my_academy_professor_classroom", {
        p_enrolment_id: z.uuid().parse(enrolmentId),
        p_schedule_item_id: z.uuid().parse(scheduleItemId),
      }),
    );
  if (!parsed.success) throw new AcademyClassDenied("SERVICE_UNAVAILABLE");
  if (!parsed.data.ok) throw new AcademyClassDenied(parsed.data.code);
  return { classroomId: parsed.data.classroomId, resumed: parsed.data.resumed };
}

// Reserved before any provider call; false means this exact learner action
// was already submitted.
export async function reserveAcademyClassInteraction(
  classroomId: string,
  idempotencyKey: string,
): Promise<boolean> {
  const parsed = z
    .union([
      z.strictObject({ ok: z.literal(true), duplicate: z.boolean() }),
      refusal,
    ])
    .safeParse(
      await learnerRpc("reserve_my_academy_professor_interaction", {
        p_classroom_id: z.uuid().parse(classroomId),
        p_idempotency_key: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .parse(idempotencyKey),
      }),
    );
  if (!parsed.success) throw new AcademyClassDenied("SERVICE_UNAVAILABLE");
  if (!parsed.data.ok) throw new AcademyClassDenied(parsed.data.code);
  return !parsed.data.duplicate;
}

export async function getMyAcademyClass(classroomId: string) {
  try {
    return await getAcademyClassroomState(classroomId);
  } catch (error) {
    throw new AcademyClassDenied(
      error instanceof Error && "code" in error
        ? String((error as { code: unknown }).code)
        : "SERVICE_UNAVAILABLE",
    );
  }
}

export async function getMyAcademyClassTranscript(
  classroomId: string,
): Promise<LearnerClassroomTranscript> {
  try {
    const memory = await listAcademyClassroomTurns(classroomId, 50);
    return {
      turns: memory.turns.map((turn) => ({
        learnerMessage: turn.learnerMessage,
        professorMessage: turn.professorMessage,
      })),
      unrecordedExchanges: memory.unrecordedExchanges,
      capacityReached: memory.capacityReached,
    };
  } catch {
    return { turns: [], unrecordedExchanges: 0, capacityReached: false };
  }
}
