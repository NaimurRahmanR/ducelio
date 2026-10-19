import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  asPolicyUser,
  buildAssessmentPolicyFixture,
  type AssessmentPolicyFixture,
} from "./commercial-v1-assessment-policy-fixture";
import {
  actAs,
  assessmentClient,
  newAssessmentClientState,
} from "./commercial-v1-assessment-response-client";

// The learner assessment list at hosted-acceptance scale. The hosted
// acceptance learner sees 192 assessments through RLS; the old projection
// read the 100 EARLIEST (opens_at ascending), so a newly published
// assessment never appeared. Everything here is created through the real
// governed RPCs and read under the learner's own authenticated role and RLS
// (PGlite); synthetic content only.

const mocks = vi.hoisted(() => ({ client: vi.fn() }));
vi.mock("@/server/supabase", () => ({ createSupabase: mocks.client }));
vi.mock("@/lib/env", () => ({ config: () => ({ configured: true }) }));

import {
  getStudentAssessments,
  recordAssessmentResponse,
  startAssessmentAttempt,
  studentAssessmentPage,
  STUDENT_ASSESSMENT_PAGE_SIZE,
  StudentAssessmentReadFailure,
} from "@/server/assessments";

const HISTORICAL_CLOSED = 200; // windows entirely in the past
const HISTORICAL_ATTEMPTED = 105; // open windows, one submitted attempt each
const HISTORICAL_RESPONSES = 1005; // revisions on one historical attempt

let f: AssessmentPolicyFixture;
let newAssessmentId: string;
const state = newAssessmentClientState();

async function owner<T>(sql: string, params: unknown[] = []) {
  await f.db.exec("reset role");
  return (await f.db.query<T>(sql, params)).rows;
}
async function asLearner() {
  await actAs(f.db, state, 1);
}
// Every read runs in its own rolled-back transaction (the RPC adapter uses
// savepoints, exactly as the other learner-projection suites).
async function inTransaction<T>(work: () => Promise<T>): Promise<T> {
  await f.db.exec("begin");
  try {
    return await work();
  } finally {
    await f.db.exec("rollback; reset role");
  }
}
async function allPages() {
  const ids: string[] = [];
  const pages: Awaited<ReturnType<typeof getStudentAssessments>>[] = [];
  for (let page = 1; page <= 100; page++) {
    await asLearner();
    const view = await getStudentAssessments({ page });
    pages.push(view);
    ids.push(...view.assessments.map((a) => a.id));
    if (!view.pagination.hasNextPage) break;
  }
  return { ids, pages };
}

beforeAll(async () => {
  f = await buildAssessmentPolicyFixture({ withLabs: false });
  mocks.client.mockImplementation(async () => assessmentClient(f.db, state));
  const [{ lesson_id, instructor_id }] = await owner<{
    lesson_id: string;
    instructor_id: string;
  }>("select lesson_id, instructor_id from assessments where id=$1", [
    f.assessmentIds.QUIZ_1,
  ]);
  // Historical coursework, created by the course administrator through the
  // governed authoring RPCs.
  await asPolicyUser(f.db, 2);
  await f.db.query(
    `do $$ declare a uuid; begin
       for i in 1..${HISTORICAL_CLOSED} loop
         a := public.create_assessment('${f.cohortId}','${lesson_id}','${instructor_id}',
           'Historical closed ' || i, 'Synthetic historical assessment',
           now() - make_interval(days => 400 - i), now() - make_interval(days => 400 - i) + interval '1 hour',
           30, 1, 'Pagination fixture history');
         perform public.add_assessment_question(a, 1, 'Synthetic prompt', 5, 'Synthetic answer', null, 'Pagination fixture question');
         perform public.change_assessment_status(a, 'PUBLISHED', 'Pagination fixture publication');
       end loop;
       for i in 1..${HISTORICAL_ATTEMPTED} loop
         a := public.create_assessment('${f.cohortId}','${lesson_id}','${instructor_id}',
           'Historical attempted ' || i, 'Synthetic attempted assessment',
           now() - interval '2 hours' + make_interval(secs => i), now() + interval '1 day',
           30, 1, 'Pagination fixture history');
         perform public.add_assessment_question(a, 1, 'Synthetic prompt', 5, 'Synthetic answer', null, 'Pagination fixture question');
         perform public.change_assessment_status(a, 'PUBLISHED', 'Pagination fixture publication');
       end loop;
     end $$`,
  );
  // The learner attempts every open historical assessment through the real
  // learner RPCs, saving many revisions on the first one.
  await asLearner();
  await f.db.query(
    `do $$ declare a record; t uuid; q uuid; first boolean := true; begin
       for a in select id from public.assessments where title like 'Historical attempted %' order by opens_at loop
         t := public.start_assessment_attempt(a.id);
         select id into q from public.get_active_assessment_questions(a.id);
         for r in 1..(case when first then ${HISTORICAL_RESPONSES} else 1 end) loop
           perform public.record_assessment_response(t, q, 'Historical revision ' || r, 'hist-' || t || '-' || r);
         end loop;
         perform public.submit_assessment_attempt(t);
         first := false;
       end loop;
     end $$`,
  );
  // The newly published assessment (latest opening time).
  await asPolicyUser(f.db, 2);
  newAssessmentId = (
    await f.db.query<{ v: string }>(
      `select public.create_assessment($1,$2,$3,'Newly published assessment','Synthetic new assessment',
         now() - interval '1 minute', now() + interval '1 day', 30, 1, 'Pagination fixture new') as v`,
      [f.cohortId, lesson_id, instructor_id],
    )
  ).rows[0].v;
  await f.db.query(
    "select public.add_assessment_question($1,1,'Synthetic new prompt',5,'Synthetic answer',null,'Pagination fixture question')",
    [newAssessmentId],
  );
  await f.db.query(
    "select public.change_assessment_status($1,'PUBLISHED','Pagination fixture publication')",
    [newAssessmentId],
  );
  await f.db.exec("reset role");
}, 300000);
afterAll(async () => {
  await f?.db.close();
});

describe("learner assessment pagination at hosted scale", () => {
  it("the fixture reproduces the hosted defect: >=192 visible assessments, and the old earliest-100 read omits the new one", async () => {
    await asLearner();
    const [{ visible, attempts, responses }] = (
      await f.db.query<{
        visible: number;
        attempts: number;
        responses: number;
      }>(
        `select (select count(*) from public.assessments where status in ('PUBLISHED','CLOSED'))::int as visible,
                (select count(*) from public.assessment_attempts)::int as attempts,
                (select count(*) from public.assessment_responses)::int as responses`,
      )
    ).rows;
    expect(visible).toBeGreaterThanOrEqual(192);
    expect(attempts).toBeGreaterThan(100);
    expect(responses).toBeGreaterThan(1000);
    const oldRead = (
      await f.db.query<{ id: string }>(
        "select id from public.assessments where status in ('PUBLISHED','CLOSED') order by opens_at asc limit 100",
      )
    ).rows.map((r) => r.id);
    expect(oldRead).not.toContain(newAssessmentId);
  });

  it("page 1 shows the newly published assessment, newest opening first", async () => {
    await inTransaction(async () => {
      await asLearner();
      const view = await getStudentAssessments();
      expect(view.pagination).toEqual({
        page: 1,
        pageSize: STUDENT_ASSESSMENT_PAGE_SIZE,
        hasPreviousPage: false,
        hasNextPage: true,
      });
      expect(view.assessments).toHaveLength(STUDENT_ASSESSMENT_PAGE_SIZE);
      // Newest opening first: the fixture's later-opening (upcoming)
      // components precede it, and it is on the first page.
      expect(view.assessments.map((a) => a.id)).toContain(newAssessmentId);
      const opens = view.assessments.map((a) => Date.parse(a.opens_at));
      expect(opens).toEqual([...opens].sort((a, b) => b - a));
      expect(view.activeAssessment).toBeNull();
      expect(view.responses).toEqual([]);
    });
  });

  it("navigating every page lists each RLS-visible assessment exactly once, newest first", async () => {
    await inTransaction(async () => {
      await asLearner();
      const expected = (
        await f.db.query<{ id: string }>(
          "select id from public.assessments where status in ('PUBLISHED','CLOSED') and cohort_id=$1 order by opens_at desc, id desc",
          [f.cohortId],
        )
      ).rows.map((r) => r.id);
      const { ids, pages } = await allPages();
      expect(ids).toEqual(expected);
      expect(new Set(ids).size).toBe(ids.length);
      expect(pages.at(-1)!.pagination.hasNextPage).toBe(false);
      expect(pages.slice(1).every((p) => p.pagination.hasPreviousPage)).toBe(
        true,
      );
    });
  });

  it("each listed assessment carries its exact attempt history, even with more than 100 historical attempts", async () => {
    await inTransaction(async () => {
      const { pages } = await allPages();
      for (const view of pages)
        for (const assessment of view.assessments) {
          const own = view.attempts.filter(
            (a) => a.assessment_id === assessment.id,
          );
          expect(own).toHaveLength(
            assessment.title.startsWith("Historical attempted") ? 1 : 0,
          );
        }
    });
  });

  it("an active attempt is visible and resumable from any page, with exactly its own saved revisions", async () => {
    await f.db.exec("begin");
    try {
      await asLearner();
      const attemptId = await startAssessmentAttempt(newAssessmentId);
      const [question] = (await getStudentAssessments()).activeQuestions;
      for (const body of ["First answer", "Second answer", "Third answer"])
        expect(
          await recordAssessmentResponse({
            attemptId,
            questionId: question.id,
            body,
            idempotencyKey: randomUUID(),
          }),
        ).toMatchObject({ ok: true });
      for (const page of [1, 5, 9]) {
        await asLearner();
        const view = await getStudentAssessments({ page });
        expect(view.activityState).toBe("CONTROLLED_ASSESSMENT_ACTIVE");
        expect(view.activeAssessment?.id).toBe(newAssessmentId);
        expect(view.activeAssessment?.programme_versions).toBeTruthy();
        const active = view.attempts.filter((a) => a.state === "ACTIVE");
        expect(active.map((a) => a.id)).toEqual([attemptId]);
        expect(view.activeQuestions.map((q) => q.id)).toEqual([question.id]);
        // CP2 resume: the authoritative latest answer and revision count
        // come from get_active_assessment_exam_state, whatever page is open.
        expect(view.activeQuestions[0]).toMatchObject({
          question_type: "FREE_TEXT",
          saved_body: "Third answer",
          revision_count: 3,
        });
        // Only the active attempt's revisions, complete and in order --
        // never the 1000+ historical revisions of other attempts.
        expect(
          view.responses
            .map((r) => [r.attempt_id, r.question_id, r.revision_number])
            .sort(),
        ).toEqual([
          [attemptId, question.id, 1],
          [attemptId, question.id, 2],
          [attemptId, question.id, 3],
        ]);
        if (page > 1)
          expect(view.assessments.map((a) => a.id)).not.toContain(
            newAssessmentId,
          );
      }
    } finally {
      await f.db.exec("rollback; reset role");
    }
  });

  it("fails closed rather than presenting a truncated revision history", async () => {
    await f.db.exec("begin");
    try {
      await asLearner();
      const attemptId = await startAssessmentAttempt(newAssessmentId);
      const [{ id: questionId }] = (
        await f.db.query<{ id: string }>(
          "select id from public.get_active_assessment_questions($1)",
          [newAssessmentId],
        )
      ).rows;
      await f.db.query(
        `do $$ begin for r in 1..901 loop
           perform public.record_assessment_response('${attemptId}','${questionId}','Revision ' || r, 'cap-${attemptId}-' || r);
         end loop; end $$`,
      );
      await asLearner();
      const error = await getStudentAssessments().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(StudentAssessmentReadFailure);
      expect((error as StudentAssessmentReadFailure).stage).toBe(
        "READ_RESPONSES",
      );
    } finally {
      await f.db.exec("rollback; reset role");
    }
  });

  it("another learner sees none of this cohort's assessments", async () => {
    await inTransaction(async () => {
      await actAs(f.db, state, 3);
      const view = await getStudentAssessments();
      expect(view.assessments).toEqual([]);
      expect(view.attempts).toEqual([]);
      expect(view.responses).toEqual([]);
    });
  });

  it("parses the page query parameter strictly", () => {
    expect(studentAssessmentPage(undefined)).toBe(1);
    expect(studentAssessmentPage("2")).toBe(2);
    expect(studentAssessmentPage(["3", "4"])).toBe(3);
    expect(studentAssessmentPage("9999")).toBe(1000);
    for (const bad of ["0", "-1", "1.5", "2e3", " 2", "abc", "", "01"])
      expect(studentAssessmentPage(bad)).toBe(1);
  });
});
