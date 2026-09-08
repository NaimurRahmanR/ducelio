import "server-only";
import { z } from "zod";
import { learningResourceSchema } from "@/domain/academy";
import { requireActor } from "./identity";
import { createSupabase } from "./supabase";

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
  await requireActor("admin");
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
      "id,lesson_id,kind,title,body,url,position,lessons(title),programme_versions(label,title_snapshot)",
    )
    .order("lesson_id")
    .order("position")
    .limit(1000);

  if (error) throw new Error("Your learning resources could not be loaded.");

  return z
    .array(
      z.object({
        id: z.uuid(),
        lesson_id: z.uuid(),
        kind: z.enum(["LECTURE_NOTE", "REFERENCE_LINK"]),
        title: z.string(),
        body: z.string().nullable(),
        url: z.string().nullable(),
        position: z.number(),
        lessons: z.object({ title: z.string() }),
        programme_versions: z.object({
          label: z.string(),
          title_snapshot: z.string().nullable(),
        }),
      }),
    )
    .parse(data);
}
