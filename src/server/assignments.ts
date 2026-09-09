import "server-only";
import { z } from "zod";
import {
  assignmentCreationSchema,
  assignmentDraftUpdateSchema,
  assignmentStatusSchema,
  assignmentSubmissionSchema,
} from "@/domain/academy";
import { requireActor } from "./identity";
import { createSupabase } from "./supabase";

const assignmentSchema = z.object({
  id: z.uuid(),
  cohort_id: z.uuid(),
  programme_version_id: z.uuid(),
  lesson_id: z.uuid(),
  instructor_id: z.uuid(),
  title: z.string(),
  instructions: z.string(),
  opens_at: z.string(),
  due_at: z.string(),
  status: z.enum(["DRAFT", "PUBLISHED", "CLOSED"]),
  created_at: z.string(),
  published_at: z.string().nullable(),
  closed_at: z.string().nullable(),
  cohorts: z.object({ title: z.string() }),
  lessons: z.object({ title: z.string() }),
  programme_versions: z.object({
    label: z.string(),
    title_snapshot: z.string().nullable(),
  }),
});

const submissionSchema = z.object({
  id: z.uuid(),
  assignment_id: z.uuid(),
  enrolment_id: z.uuid(),
  student_id: z.uuid(),
  attempt_number: z.number(),
  submitted_at: z.string(),
});

export async function getAssignmentWorkspace() {
  await requireActor("admin");
  const client = await createSupabase();
  const [assignments, submissions, cohorts, lessons, instructors] =
    await Promise.all([
      client
        .from("assignments")
        .select(
          "id,cohort_id,programme_version_id,lesson_id,instructor_id,title,instructions,opens_at,due_at,status,created_at,published_at,closed_at,cohorts(title),lessons(title),programme_versions(label,title_snapshot)",
        )
        .order("created_at", { ascending: false })
        .limit(500),
      client
        .from("assignment_submissions")
        .select(
          "id,assignment_id,enrolment_id,student_id,attempt_number,submitted_at",
        )
        .order("submitted_at", { ascending: false })
        .limit(1000),
      client
        .from("cohorts")
        .select("id,title,programme_version_id")
        .order("starts_on", { ascending: false })
        .limit(200),
      client
        .from("lessons")
        .select("id,title,programme_version_id")
        .order("title")
        .limit(500),
      client.rpc("list_assignable_instructors"),
    ]);

  if (
    assignments.error ||
    submissions.error ||
    cohorts.error ||
    lessons.error ||
    instructors.error
  )
    throw new Error("Assignment workspace could not be loaded.");

  return {
    assignments: z.array(assignmentSchema).parse(assignments.data),
    submissions: z.array(submissionSchema).parse(submissions.data),
    cohorts: z
      .array(
        z.object({
          id: z.uuid(),
          title: z.string(),
          programme_version_id: z.uuid(),
        }),
      )
      .parse(cohorts.data),
    lessons: z
      .array(
        z.object({
          id: z.uuid(),
          title: z.string(),
          programme_version_id: z.uuid(),
        }),
      )
      .parse(lessons.data),
    instructors: z
      .array(
        z.object({
          user_id: z.uuid(),
          display_name: z.string(),
          title: z.string(),
        }),
      )
      .parse(instructors.data),
  };
}

export async function createAssignment(input: unknown) {
  const payload = assignmentCreationSchema.parse(input);
  await requireActor("admin");
  const client = await createSupabase();
  const { data, error } = await client.rpc("create_assignment", {
    p_cohort_id: payload.cohortId,
    p_lesson_id: payload.lessonId,
    p_instructor_id: payload.instructorId,
    p_title: payload.title,
    p_instructions: payload.instructions,
    p_opens_at: payload.opensAt,
    p_due_at: payload.dueAt,
    p_reason: payload.reason,
  });
  if (error) throw new Error("Assignment could not be created.");
  return z.uuid().parse(data);
}

export async function updateDraftAssignment(input: unknown) {
  const payload = assignmentDraftUpdateSchema.parse(input);
  await requireActor("admin");
  const client = await createSupabase();
  const { data, error } = await client.rpc("update_draft_assignment", {
    p_assignment_id: payload.assignmentId,
    p_title: payload.title,
    p_instructions: payload.instructions,
    p_opens_at: payload.opensAt,
    p_due_at: payload.dueAt,
    p_reason: payload.reason,
  });
  if (error) throw new Error("Draft assignment could not be updated.");
  return z.uuid().parse(data);
}

export async function changeAssignmentStatus(input: unknown) {
  const payload = assignmentStatusSchema.parse(input);
  await requireActor("admin");
  const client = await createSupabase();
  const { data, error } = await client.rpc("change_assignment_status", {
    p_assignment_id: payload.assignmentId,
    p_status: payload.status,
    p_reason: payload.reason,
  });
  if (error) throw new Error("Assignment status could not be changed.");
  return z.uuid().parse(data);
}

export async function getStudentAssignments() {
  await requireActor("student");
  const client = await createSupabase();
  const [assignments, submissions] = await Promise.all([
    client
      .from("assignments")
      .select(
        "id,title,instructions,opens_at,due_at,status,lessons(title),programme_versions(label,title_snapshot)",
      )
      .order("due_at", { ascending: true })
      .limit(200),
    client
      .from("assignment_submissions")
      .select("id,assignment_id,attempt_number,submitted_at")
      .order("submitted_at", { ascending: false })
      .limit(500),
  ]);
  if (assignments.error || submissions.error)
    throw new Error("Your assignments could not be loaded.");
  return {
    assignments: z
      .array(
        z.object({
          id: z.uuid(),
          title: z.string(),
          instructions: z.string(),
          opens_at: z.string(),
          due_at: z.string(),
          status: z.enum(["PUBLISHED", "CLOSED"]),
          lessons: z.object({ title: z.string() }),
          programme_versions: z.object({
            label: z.string(),
            title_snapshot: z.string().nullable(),
          }),
        }),
      )
      .parse(assignments.data),
    submissions: z
      .array(
        submissionSchema.pick({
          id: true,
          assignment_id: true,
          attempt_number: true,
          submitted_at: true,
        }),
      )
      .parse(submissions.data),
  };
}

export async function submitAssignment(input: unknown) {
  const payload = assignmentSubmissionSchema.parse(input);
  await requireActor("student");
  const client = await createSupabase();
  const { data, error } = await client.rpc("submit_assignment", {
    p_assignment_id: payload.assignmentId,
    p_body: payload.body,
    p_idempotency_key: payload.idempotencyKey,
  });
  if (error) throw new Error("Assignment submission could not be recorded.");
  return z.uuid().parse(data);
}
