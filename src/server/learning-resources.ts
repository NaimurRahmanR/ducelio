import "server-only";
import { z } from "zod";
import { learningResourceSchema } from "@/domain/academy";
import { requireActor, requireAnyRole } from "./identity";
import { createSupabase } from "./supabase";
import { getStudentLessonContext } from "./learning-context";
import { assertStudentExplanationAllowed } from "./academic-activity";
import { AcademicContextUnavailable } from "@/domain/learning-context";
import {
  learningResourcesInputSchema,
  learningResourcesPageSchema,
  permittedResourceSchema,
  RESOURCE_PAGE_SIZE,
} from "@/domain/academic-reads";

const lessonSchema = z.object({
  id: z.uuid(),
  programme_version_id: z.uuid(),
  title: z.string(),
  position: z.number(),
  modules: z.object({ title: z.string(), position: z.number() }),
  programme_versions: z.object({
    label: z.string(),
    status: z.enum(["DRAFT", "PUBLISHED"]),
    title_snapshot: z.string().nullable(),
  }),
});

const resourceSchema = z.object({
  id: z.uuid(),
  lesson_id: z.uuid(),
  programme_version_id: z.uuid(),
  kind: z.enum(["LECTURE_NOTE", "REFERENCE_LINK"]),
  title: z.string(),
  body: z.string().nullable(),
  url: z.string().nullable(),
  position: z.number(),
  lessons: z.object({ title: z.string() }),
  programme_versions: z.object({
    label: z.string(),
    status: z.enum(["DRAFT", "PUBLISHED"]),
    title_snapshot: z.string().nullable(),
  }),
});

export async function getLearningResourceWorkspace() {
  await requireActor("admin");
  const client = await createSupabase();
  const [lessons, resources] = await Promise.all([
    client
      .from("lessons")
      .select(
        "id,programme_version_id,title,position,modules(title,position),programme_versions(label,status,title_snapshot)",
      )
      .order("programme_version_id")
      .order("position")
      .limit(1000),
    client
      .from("learning_resources")
      .select(
        "id,lesson_id,programme_version_id,kind,title,body,url,position,lessons(title),programme_versions(label,status,title_snapshot)",
      )
      .order("programme_version_id")
      .order("lesson_id")
      .order("position")
      .limit(2000),
  ]);

  if (lessons.error || resources.error)
    throw new Error("Learning resource workspace could not be loaded.");

  return {
    lessons: z.array(lessonSchema).parse(lessons.data),
    resources: z.array(resourceSchema).parse(resources.data),
  };
}

export async function createLearningResource(input: unknown) {
  const payload = learningResourceSchema.parse(input);
  await requireAnyRole(["ACADEMIC_ADMIN", "PLATFORM_ADMIN"]);
  const client = await createSupabase();
  const { data, error } = await client.rpc("create_learning_resource", {
    p_lesson_id: payload.lessonId,
    p_kind: payload.kind,
    p_title: payload.title,
    p_body: payload.body,
    p_url: payload.url,
    p_position: payload.position,
    p_reason: payload.reason,
  });
  if (error) throw new Error("Learning resource could not be created.");
  return z.uuid().parse(data);
}

export async function getStudentLearningResources() {
  await requireActor("student");
  const client = await createSupabase();
  const { data, error } = await client
    .from("learning_resources")
    .select(
      "id,lesson_id,programme_version_id,kind,title,body,url,position,lessons(title)",
    )
    .order("lesson_id")
    .order("position")
    .limit(1000);

  if (error) throw new Error("Your learning resources could not be loaded.");

  const rows = z
    .array(
      z.object({
        id: z.uuid(),
        lesson_id: z.uuid(),
        programme_version_id: z.uuid(),
        kind: z.enum(["LECTURE_NOTE", "REFERENCE_LINK"]),
        title: z.string(),
        body: z.string().nullable(),
        url: z.string().nullable(),
        position: z.number(),
        lessons: z.object({ title: z.string() }),
      }),
    )
    .parse(data);

  const versionIds = [
    ...new Set(rows.map((row) => row.programme_version_id)),
  ];
  const versions = new Map<
    string,
    { label: string; title_snapshot: string | null }
  >();
  if (versionIds.length) {
    const { data: versionData, error: versionError } = await client
      .from("programme_versions")
      .select("id,label,title_snapshot")
      .in("id", versionIds);
    if (versionError)
      throw new Error("Your learning resources could not be loaded.");
    for (const version of z
      .array(
        z.object({
          id: z.uuid(),
          label: z.string(),
          title_snapshot: z.string().nullable(),
        }),
      )
      .parse(versionData))
      versions.set(version.id, {
        label: version.label,
        title_snapshot: version.title_snapshot,
      });
  }

  return rows.map(({ programme_version_id, ...row }) => {
    const version = versions.get(programme_version_id);
    if (!version)
      throw new Error("Your learning resources could not be loaded.");
    return { ...row, programme_versions: version };
  });
}

export async function getStudentLessonResources(input: unknown) {
  const payload = learningResourcesInputSchema.parse(input);
  await assertStudentExplanationAllowed();
  const lesson = await getStudentLessonContext({
    enrolmentId: payload.enrolmentId,
    lessonId: payload.lessonId,
  });
  const client = await createSupabase();
  const { data, error } = await client
    .from("learning_resources")
    .select("id,lesson_id,programme_version_id,kind,title,body,url,position")
    .eq("lesson_id", lesson.lessonId)
    .eq("programme_version_id", lesson.programmeVersionId)
    .gt("position", payload.cursor?.afterPosition ?? 0)
    .order("position")
    .limit(RESOURCE_PAGE_SIZE + 1);
  if (error) throw new Error("Lesson resources could not be loaded.");
  const rows = z
    .array(resourceSchema.omit({ lessons: true, programme_versions: true }))
    .max(RESOURCE_PAGE_SIZE + 1)
    .parse(data);
  for (const [index, row] of rows.entries()) {
    if (
      row.lesson_id !== lesson.lessonId ||
      row.programme_version_id !== lesson.programmeVersionId
    )
      throw new AcademicContextUnavailable();
    if (
      row.position <=
      (index ? rows[index - 1].position : (payload.cursor?.afterPosition ?? 0))
    )
      throw new Error("Invalid resource ordering.");
  }
  const projected = rows.map((row) =>
    permittedResourceSchema.parse({
      resourceId: row.id,
      kind: row.kind,
      title: row.title,
      body: row.body,
      url: row.url,
      position: row.position,
    }),
  );
  const page = projected.slice(0, RESOURCE_PAGE_SIZE);
  const result = learningResourcesPageSchema.parse({
    enrolmentId: lesson.enrolmentId,
    programmeVersionId: lesson.programmeVersionId,
    lessonId: lesson.lessonId,
    resources: page,
    nextCursor:
      projected.length > RESOURCE_PAGE_SIZE
        ? { afterPosition: page[page.length - 1].position }
        : null,
  });
  await assertStudentExplanationAllowed();
  return result;
}
