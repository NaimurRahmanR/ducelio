import "server-only";
import { z } from "zod";
import {
  AcademicContextUnavailable,
  lessonContextInputSchema,
  lessonContextSchema,
  lessonObjectivesInputSchema,
  lessonObjectivesSchema,
  OBJECTIVE_PAGE_SIZE,
} from "@/domain/learning-context";
import { getOwnedStudentEnrolment } from "./academy";
import { createSupabase } from "./supabase";
import { assertStudentExplanationAllowed } from "./academic-activity";

async function readOwnedLesson(enrolmentId: string, lessonId: string) {
  const enrolment = await getOwnedStudentEnrolment({ enrolmentId });
  const client = await createSupabase();
  const { data, error } = await client
    .from("lessons")
    .select("id,module_id,programme_version_id,title,position")
    .eq("id", lessonId)
    .eq("programme_version_id", enrolment.programmeVersionId)
    .maybeSingle();
  if (error) throw new Error("Lesson context could not be loaded.");
  if (!data) throw new AcademicContextUnavailable();
  const row = z
    .object({
      id: z.uuid(),
      module_id: z.uuid(),
      programme_version_id: z.uuid(),
      title: z.string(),
      position: z.number(),
    })
    .parse(data);
  if (
    row.id !== lessonId ||
    row.programme_version_id !== enrolment.programmeVersionId
  )
    throw new AcademicContextUnavailable();
  return lessonContextSchema.parse({
    enrolmentId,
    programmeVersionId: row.programme_version_id,
    lessonId: row.id,
    moduleId: row.module_id,
    title: row.title,
    position: row.position,
  });
}

export async function getStudentLessonContext(input: unknown) {
  const { enrolmentId, lessonId } = lessonContextInputSchema.parse(input);
  await assertStudentExplanationAllowed();
  const result = await readOwnedLesson(enrolmentId, lessonId);
  await assertStudentExplanationAllowed();
  return result;
}

export async function getStudentLessonObjectives(input: unknown) {
  const payload = lessonObjectivesInputSchema.parse(input);
  await assertStudentExplanationAllowed();
  const lesson = await readOwnedLesson(payload.enrolmentId, payload.lessonId);
  const client = await createSupabase();
  const { data, error } = await client
    .from("lesson_objectives")
    .select("id,lesson_id,programme_version_id,description,position")
    .eq("lesson_id", lesson.lessonId)
    .eq("programme_version_id", lesson.programmeVersionId)
    .gt("position", payload.afterPosition ?? 0)
    .order("position")
    .limit(OBJECTIVE_PAGE_SIZE + 1);
  if (error) throw new Error("Lesson objectives could not be loaded.");
  const rows = z
    .array(
      z.object({
        id: z.uuid(),
        lesson_id: z.uuid(),
        programme_version_id: z.uuid(),
        description: z.string(),
        position: z.number().int().positive(),
      }),
    )
    .max(OBJECTIVE_PAGE_SIZE + 1)
    .parse(data);
  if (
    rows.some(
      (row, index) =>
        row.lesson_id !== lesson.lessonId ||
        row.programme_version_id !== lesson.programmeVersionId ||
        row.position <=
          (index ? rows[index - 1].position : (payload.afterPosition ?? 0)),
    )
  )
    throw new AcademicContextUnavailable();
  const page = rows.slice(0, OBJECTIVE_PAGE_SIZE);
  const result = lessonObjectivesSchema.parse({
    enrolmentId: lesson.enrolmentId,
    programmeVersionId: lesson.programmeVersionId,
    lessonId: lesson.lessonId,
    objectives: page.map((row) => ({
      objectiveId: row.id,
      description: row.description,
      position: row.position,
    })),
    nextAfterPosition:
      rows.length > OBJECTIVE_PAGE_SIZE ? page[page.length - 1].position : null,
  });
  await assertStudentExplanationAllowed();
  return result;
}
