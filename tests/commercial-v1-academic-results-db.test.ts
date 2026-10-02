import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  recoveryFixture,
  running as recoveryRunning,
  graded as recoveryGraded,
  govern as recoveryGovern,
  seedOriginalExecution,
  type RecoveryFixture,
} from "./commercial-v1-examiner-recovery-fixture";
import {
  args as regradeArgs,
  govern as regradeGovern,
  graded as regradeGraded,
  running as regradeRunning,
  type RegradeFixture,
} from "./commercial-v1-examiner-regrade-fixture";
import {
  asPolicyUser,
  administrator,
  foreignLearner,
  learner,
} from "./commercial-v1-assessment-policy-fixture";

// Migration 202610020048: read-only academic results operations. Every
// result here is produced through a real governed authority -- Examiner
// recovery, Examiner regrade, human academic review (047) -- except the
// EXAMINER_INITIAL row, which is the shared test-owner seeding helper used by
// the recovery/review suites (an initial SUCCEEDED claim whose header has no
// question marks, i.e. an INVALID highest revision).

let f: RecoveryFixture;
let db: PGlite;
const ids: Record<string, string> = {};

async function value<T = unknown>(sql: string, params: unknown[] = []) {
  return (await db.query<{ v: T }>(sql, params)).rows[0]?.v as T;
}
async function owner() {
  await db.exec("reset role");
}
// Each refusal runs under a savepoint so the per-test transaction survives.
async function rejects(run: () => Promise<unknown>, code: string | RegExp) {
  await db.exec("savepoint refusal");
  await expect(run()).rejects.toThrow(code);
  await db.exec("rollback to savepoint refusal");
}
async function refused(sql: string, params: unknown[], code: string | RegExp) {
  await rejects(() => db.query(sql, params), code);
}
async function grant(user: string, role: string) {
  await owner();
  await db.query("insert into role_grants values($1,$2::platform_role)", [
    user,
    role,
  ]);
}

const LIST =
  "select public.list_commercial_v1_academic_results($1,$2,$3,$4,$5,$6,$7,$8,$9) as v";
const DETAIL = "select public.get_commercial_v1_academic_result($1) as v";
const RECORD =
  "select public.get_commercial_v1_academic_enrolment_record($1) as v";
const FILTERS =
  "select public.get_commercial_v1_academic_results_filters() as v";
const PROGRESS = "select public.get_commercial_v1_course_progress($1) as v";

type Row = {
  resultId: string;
  kind: string;
  revisionNumber: number;
  isCurrent: boolean;
  isValid: boolean;
  origin: string;
  component: string | null;
  practicalId: string | null;
  completed: boolean;
  enrolmentStatus: string;
};
type Page = { results: Row[]; hasMore: boolean; offset: number };
type Filters = {
  query?: string | null;
  kind?: string | null;
  cohortId?: string | null;
  programmeVersionId?: string | null;
  component?: string | null;
  practicalId?: string | null;
  currentOnly?: boolean;
  completion?: string | null;
  offset?: number;
};
async function list(filters: Filters = {}) {
  return value<Page>(LIST, [
    filters.query ?? null,
    filters.kind ?? null,
    filters.cohortId ?? null,
    filters.programmeVersionId ?? null,
    filters.component ?? null,
    filters.practicalId ?? null,
    filters.currentOnly ?? true,
    filters.completion ?? null,
    filters.offset ?? 0,
  ]);
}
const key = (r: Row) => `${r.component ?? "LAB"}#${r.revisionNumber}`;

beforeAll(async () => {
  f = await recoveryFixture();
  db = f.db;

  // QUIZ_1 and the lab: the failed originals' single governed recovery
  // produces revision 1 (EXAMINER_RECOVERY).
  for (const lab of [false, true]) {
    const a = await recoveryRunning(f, lab);
    const done = await recoveryGovern(f, recoveryGraded(f, a, 1));
    if (done.ok !== true) throw new Error(JSON.stringify(done));
  }
  await owner();
  ids.quiz1Rev1 = await value<string>(
    "select id as v from commercial_v1_assessment_result_revisions where enrolment_id=$1 and component='QUIZ_1'",
    [f.learnerEnrolmentId],
  );
  ids.labRev1 = await value<string>(
    "select id as v from commercial_v1_lab_result_revisions where enrolment_id=$1",
    [f.learnerEnrolmentId],
  );

  // QUIZ_1: the existing institutional regrade appends revision 2.
  const rf = {
    ...f,
    assessment: {
      result: ids.quiz1Rev1,
      attempt: f.attemptId,
      questionId: f.questionId,
      max: 10,
    },
    lab: ids.labRev1,
    practical: f.practical!,
    submission: f.submission!,
  } as unknown as RegradeFixture;
  const s = await regradeRunning(rf);
  const regraded = await regradeGovern(rf, regradeGraded(rf, s, 3));
  if (regraded.ok !== true) throw new Error(JSON.stringify(regraded));
  await owner();
  ids.quiz1Rev2 = await value<string>(
    "select id as v from commercial_v1_assessment_result_revisions where enrolment_id=$1 and component='QUIZ_1' and revision_number=2",
    [f.learnerEnrolmentId],
  );

  // QUIZ_2: initial Examiner SUCCEEDED claim whose highest revision is invalid.
  await seedOriginalExecution(f, { component: "QUIZ_2", state: "SUCCEEDED" });
  await owner();
  ids.quiz2Rev1 = await value<string>(
    "select id as v from commercial_v1_assessment_result_revisions where enrolment_id=$1 and component='QUIZ_2'",
    [f.learnerEnrolmentId],
  );

  // MIDTERM: escalated initial claim graded by human academic review (047).
  const reviewCase = await seedOriginalExecution(f, {
    component: "MIDTERM",
    state: "ESCALATED",
  });
  await owner();
  const midtermQuestions = (
    await db.query<{ id: string }>(
      "select id from assessment_questions where assessment_id=$1 order by position",
      [f.assessmentIds.MIDTERM],
    )
  ).rows;
  await asPolicyUser(db, 2);
  const reviewed = await value<{ resultRevisionId: string }>(
    "select public.submit_commercial_v1_academic_review_assessment_grade($1,$2::jsonb,$3) as v",
    [
      reviewCase,
      JSON.stringify(
        midtermQuestions.map((q) => ({ questionId: q.id, marksAwarded: 0 })),
      ),
      "Escalated midterm graded by academic review",
    ],
  );
  ids.midtermRev1 = reviewed.resultRevisionId;
}, 120000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await owner();
  await db.exec("begin");
});
afterEach(async () => {
  await db.exec("rollback");
  await owner();
});

describe("authority (migration 048)", () => {
  const calls: [string, unknown[]][] = [
    [LIST, [null, null, null, null, null, null, true, null, 0]],
    [DETAIL, []],
    [RECORD, []],
    [FILTERS, []],
  ];
  const withTarget = (sql: string, params: unknown[]) =>
    sql === DETAIL
      ? [ids.quiz1Rev2]
      : sql === RECORD
        ? [f.learnerEnrolmentId]
        : params;

  it("admits ACADEMIC_ADMIN and PLATFORM_ADMIN", async () => {
    await asPolicyUser(db, 2);
    for (const [sql, params] of calls)
      await expect(
        db.query(sql, withTarget(sql, params)),
      ).resolves.toBeDefined();
    await owner();
    await db.query(
      "delete from role_grants where user_id=$1 and role='ACADEMIC_ADMIN'",
      [administrator],
    );
    await grant(administrator, "PLATFORM_ADMIN");
    await asPolicyUser(db, 2);
    for (const [sql, params] of calls)
      await expect(
        db.query(sql, withTarget(sql, params)),
      ).resolves.toBeDefined();
  });

  it.each(["INSTRUCTOR", "COUNSELLOR", "REGISTRAR", "STUDENT"])(
    "refuses a %s without an academic/platform admin role",
    async (role) => {
      if (role !== "STUDENT") await grant(foreignLearner, role);
      await asPolicyUser(db, 3);
      for (const [sql, params] of calls)
        await refused(sql, withTarget(sql, params), "FORBIDDEN");
    },
  );

  it("refuses the learner and an unauthenticated session", async () => {
    for (const n of [1, null]) {
      await asPolicyUser(db, n);
      for (const [sql, params] of calls)
        await refused(sql, withTarget(sql, params), "FORBIDDEN");
    }
  });

  it("an admin who is deactivated loses access immediately", async () => {
    await owner();
    await db.query(
      "update app_users set account_status='DEACTIVATED' where id=$1",
      [administrator],
    );
    await asPolicyUser(db, 2);
    await refused(LIST, calls[0][1], "FORBIDDEN");
  });

  it("anon and service_role cannot execute any function; the private schema is closed", async () => {
    await owner();
    const fns = (
      await db.query<{ oid: string; proname: string; nspname: string }>(
        `select p.oid::text,p.proname,n.nspname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='commercial_v1_results_ops_private'
            or p.proname in ('list_commercial_v1_academic_results','get_commercial_v1_academic_result',
              'get_commercial_v1_academic_enrolment_record','get_commercial_v1_academic_results_filters')`,
      )
    ).rows;
    expect(fns.filter((x) => x.nspname === "public")).toHaveLength(4);
    for (const role of ["anon", "service_role", "authenticated"])
      for (const fn of fns)
        expect(
          await value(
            "select has_function_privilege($1,$2::oid,'EXECUTE') as v",
            [role, fn.oid],
          ),
        ).toBe(role === "authenticated" && fn.nspname === "public");
    for (const role of ["anon", "authenticated", "service_role"])
      expect(
        await value(
          "select has_schema_privilege($1,'commercial_v1_results_ops_private','USAGE') as v",
          [role],
        ),
      ).toBe(false);
    for (const role of ["anon", "service_role"]) {
      await db.exec(`set role ${role}`);
      await refused(FILTERS, [], "permission denied");
      await owner();
    }
  });
});

describe("bounded discovery and filters", () => {
  it("defaults to current revisions; history is opt-in and labelled", async () => {
    await asPolicyUser(db, 2);
    const current = await list();
    expect(current.results.map(key).sort()).toEqual(
      ["LAB#1", "MIDTERM#1", "QUIZ_1#2", "QUIZ_2#1"].sort(),
    );
    expect(current.results.every((r) => r.isCurrent)).toBe(true);
    expect(current.hasMore).toBe(false);
    const all = await list({ currentOnly: false });
    expect(all.results.map(key).sort()).toEqual(
      ["LAB#1", "MIDTERM#1", "QUIZ_1#1", "QUIZ_1#2", "QUIZ_2#1"].sort(),
    );
    const old = all.results.find((r) => key(r) === "QUIZ_1#1")!;
    expect(old).toMatchObject({ isCurrent: false, isValid: true });
    const origins = Object.fromEntries(
      all.results.map((r) => [key(r), r.origin]),
    );
    expect(origins).toEqual({
      "LAB#1": "EXAMINER_RECOVERY",
      "MIDTERM#1": "HUMAN_ACADEMIC_REVIEW",
      "QUIZ_1#1": "EXAMINER_RECOVERY",
      "QUIZ_1#2": "EXAMINER_REGRADE",
      "QUIZ_2#1": "EXAMINER_INITIAL",
    });
    expect(all.results.find((r) => key(r) === "QUIZ_2#1")!.isValid).toBe(false);
  });

  it("filters by kind, component, practical, learner, cohort, version and completion", async () => {
    await owner();
    const student = await value<{ name: string; number: string }>(
      "select jsonb_build_object('name',u.display_name,'number',s.student_number) as v from app_users u join student_profiles s on s.user_id=u.id where u.id=$1",
      [learner],
    );
    await asPolicyUser(db, 2);
    expect((await list({ kind: "LAB" })).results.map(key)).toEqual(["LAB#1"]);
    expect((await list({ component: "MIDTERM" })).results.map(key)).toEqual([
      "MIDTERM#1",
    ]);
    expect(
      (await list({ practicalId: f.practical! })).results.map(key),
    ).toEqual(["LAB#1"]);
    expect((await list({ query: student.number })).results).toHaveLength(4);
    expect(
      (await list({ query: student.name.toUpperCase() })).results,
    ).toHaveLength(4);
    expect((await list({ query: "no such learner" })).results).toEqual([]);
    expect((await list({ cohortId: f.cohortId })).results).toHaveLength(4);
    expect((await list({ cohortId: randomUUID() })).results).toEqual([]);
    expect(
      (await list({ programmeVersionId: f.programmeVersionId })).results,
    ).toHaveLength(4);
    expect((await list({ programmeVersionId: randomUUID() })).results).toEqual(
      [],
    );
    expect((await list({ completion: "NOT_COMPLETED" })).results).toHaveLength(
      4,
    );
    expect((await list({ completion: "COMPLETED" })).results).toEqual([]);
    const page2 = await list({ offset: 50 });
    expect(page2).toMatchObject({ results: [], hasMore: false, offset: 50 });
  });

  it("refuses unbounded or malformed filters", async () => {
    await asPolicyUser(db, 2);
    for (const bad of [
      { kind: "ALL" },
      { component: "QUIZ_9" },
      { completion: "MAYBE" },
      { offset: -1 },
      { offset: 100001 },
      { query: "x".repeat(101) },
    ])
      await rejects(() => list(bad), "INVALID_INPUT");
  });

  it("filter options are bounded labels only", async () => {
    await asPolicyUser(db, 2);
    const options = await value<{
      cohorts: { id: string }[];
      programmeVersions: { id: string }[];
      practicals: { id: string }[];
    }>(FILTERS);
    expect(options.cohorts.map((c) => c.id)).toContain(f.cohortId);
    expect(options.programmeVersions.map((v) => v.id)).toContain(
      f.programmeVersionId,
    );
    expect(options.practicals.map((p) => p.id)).toEqual([f.practical]);
  });
});

describe("result detail, provenance and revision history", () => {
  it("shows the regraded current revision with its governed source", async () => {
    await asPolicyUser(db, 2);
    const d = await value<Record<string, unknown>>(DETAIL, [ids.quiz1Rev2]);
    expect(d).toMatchObject({
      kind: "ASSESSMENT",
      component: "QUIZ_1",
      revisionNumber: 2,
      isCurrent: true,
      isValid: true,
      earnedMarks: 3,
      attemptId: f.attemptId,
      origin: "EXAMINER_REGRADE",
      provenance: {
        origin: "EXAMINER_REGRADE",
        sourceResultRevisionId: ids.quiz1Rev1,
        sourceRevisionNumber: 1,
        reason: "Independent institutional review",
      },
    });
    expect((d.provenance as { actorName: string }).actorName).toBeTruthy();
    expect(
      (d.history as { revisionNumber: number; isCurrent: boolean }[]).map(
        (h) => [h.revisionNumber, h.isCurrent],
      ),
    ).toEqual([
      [1, false],
      [2, true],
    ]);
    const marks = d.questionMarks as Record<string, unknown>[];
    expect(marks.length).toBeGreaterThan(0);
    for (const m of marks)
      expect(Object.keys(m).sort()).toEqual(
        ["marksAwarded", "maxMarks", "position", "questionId"].sort(),
      );
    expect(
      (d.objectiveOutcomes as Record<string, unknown>[]).length,
    ).toBeGreaterThan(0);
  });

  it("shows the superseded revision as history with its recovery provenance", async () => {
    await asPolicyUser(db, 2);
    const d = await value<Record<string, unknown>>(DETAIL, [ids.quiz1Rev1]);
    expect(d).toMatchObject({
      revisionNumber: 1,
      isCurrent: false,
      provenance: {
        origin: "EXAMINER_RECOVERY",
        reason: "Independent institutional recovery review",
      },
    });
  });

  it("shows human academic review provenance truthfully", async () => {
    await asPolicyUser(db, 2);
    const d = await value<Record<string, unknown>>(DETAIL, [ids.midtermRev1]);
    expect(d).toMatchObject({
      component: "MIDTERM",
      origin: "HUMAN_ACADEMIC_REVIEW",
      provenance: {
        origin: "HUMAN_ACADEMIC_REVIEW",
        caseKind: "INITIAL_ESCALATION",
        reason: "Escalated midterm graded by academic review",
      },
    });
  });

  it("shows an invalid current revision truthfully and lab detail", async () => {
    await asPolicyUser(db, 2);
    expect(
      await value<Record<string, unknown>>(DETAIL, [ids.quiz2Rev1]),
    ).toMatchObject({
      isCurrent: true,
      isValid: false,
      provenance: { origin: "EXAMINER_INITIAL" },
      questionMarks: [],
    });
    const lab = await value<Record<string, unknown>>(DETAIL, [ids.labRev1]);
    expect(lab).toMatchObject({
      kind: "LAB",
      practicalId: f.practical,
      submissionId: f.submission,
      maxMarks: 10,
      weightBp: 2000,
      scoreBp: null,
      provenance: { origin: "EXAMINER_RECOVERY" },
    });
  });

  it("unknown result ids fail closed", async () => {
    await asPolicyUser(db, 2);
    await refused(DETAIL, [randomUUID()], "NOT_FOUND");
    await refused(RECORD, [randomUUID()], "NOT_FOUND");
  });

  it("never returns prompts, answer keys, guidance, responses, submissions, digests or MACs", async () => {
    await owner();
    const secrets = (
      await db.query<{ s: string }>(
        `select prompt as s from assessment_questions
         union all select expected_answer from assessment_answer_keys
         union all select marking_guidance from assessment_answer_keys where marking_guidance is not null
         union all select grade_digest from commercial_v1_examiner_executions where grade_digest is not null
         union all select grade_digest from commercial_v1_examiner_recovery_executions where grade_digest is not null
         union all select grade_digest from commercial_v1_examiner_regrade_executions where grade_digest is not null
         union all select body from commercial_v1_lab_submissions`,
      )
    ).rows.map((r) => r.s);
    expect(secrets.length).toBeGreaterThan(3);
    await asPolicyUser(db, 2);
    const outputs = [
      await list({ currentOnly: false }),
      ...(await Promise.all(
        Object.values(ids).map((id) =>
          value<Record<string, unknown>>(DETAIL, [id]),
        ),
      )),
      await value(RECORD, [f.learnerEnrolmentId]),
      await value(FILTERS),
    ];
    const text = JSON.stringify(outputs);
    for (const s of secrets) expect(text).not.toContain(s);
    for (const sentinel of [
      "Protected learner response sentinel",
      "Protected lab submission sentinel",
      "Protected grading guidance sentinel",
    ])
      expect(text).not.toContain(sentinel);
    for (const field of [
      "prompt",
      "answerKey",
      "expectedAnswer",
      "markingGuidance",
      "gradeDigest",
      "mac",
      "body",
      "maxEstimatedCostMicrousd",
    ])
      expect(text).not.toContain(`"${field}"`);
  });
});

describe("canonical progress and current-result truth", () => {
  it("progress uses the regraded revision and treats the invalid highest revision as PENDING", async () => {
    await asPolicyUser(db, 2);
    const progress = await value<{
      components: Record<string, { status: string; scoreBp?: number }>;
      courseScoreBp: number | null;
      enrolmentStatus: string;
    }>(PROGRESS, [f.learnerEnrolmentId]);
    expect(progress.components.QUIZ_1.status).toBe("FINALIZED");
    expect(progress.components.QUIZ_2.status).toBe("PENDING");
    expect(progress.components.MIDTERM.status).toBe("FINALIZED");
    expect(progress.courseScoreBp).toBeNull();
    expect(progress.enrolmentStatus).toBe("ACTIVE");
    const d = await value<{ scoreBp: number }>(DETAIL, [ids.quiz1Rev2]);
    expect(progress.components.QUIZ_1.scoreBp).toBe(d.scoreBp);
  });
});

describe("correction semantics: append-only, regrade only", () => {
  it("result revisions cannot be updated or deleted, even by the table owner", async () => {
    await owner();
    await refused(
      "update commercial_v1_assessment_result_revisions set earned_marks_total=0 where id=$1",
      [ids.quiz1Rev2],
      /immutable|append-only|cannot/i,
    );
    await refused(
      "delete from commercial_v1_lab_result_revisions where id=$1",
      [ids.labRev1],
      /immutable|append-only|cannot/i,
    );
  });

  it("an admin session has no raw table write path", async () => {
    await asPolicyUser(db, 2);
    await refused(
      "update commercial_v1_assessment_result_revisions set earned_marks_total=0 where id=$1",
      [ids.quiz1Rev2],
      "permission denied",
    );
    await refused(
      "insert into commercial_v1_assessment_question_marks values($1,$2,0,10)",
      [ids.quiz1Rev2, f.questionId],
      "permission denied",
    );
  });

  it("regrade never re-grades a superseded revision and refuses an invalid current one", async () => {
    const rf = {
      ...f,
      assessment: {
        result: ids.quiz1Rev1,
        attempt: f.attemptId,
        questionId: f.questionId,
        max: 10,
      },
    } as unknown as RegradeFixture;
    await asPolicyUser(db, 2);
    // The superseded revision 1 already has its institutional regrade: the
    // request replays that outcome (revision 2) and creates nothing new.
    expect(await regradeGovern(rf, regradeArgs(rf))).toMatchObject({
      ok: true,
      transitioned: false,
      execution: { resultRevisionId: ids.quiz1Rev2, sourceRevisionNumber: 1 },
    });
    await owner();
    expect(
      await value(
        "select count(*)::int as v from commercial_v1_assessment_result_revisions where enrolment_id=$1 and component='QUIZ_1'",
        [f.learnerEnrolmentId],
      ),
    ).toBe(2);
    await asPolicyUser(db, 2);
    expect(
      await regradeGovern(rf, {
        ...regradeArgs(rf),
        p_source_id: ids.quiz2Rev1,
      }),
    ).toEqual({ ok: false, code: "CURRENT_RESULT_INVALID" });
  });

  it("a learner who is also an admin can neither see nor regrade their own record", async () => {
    await grant(learner, "ACADEMIC_ADMIN");
    await asPolicyUser(db, 1);
    expect((await list({ currentOnly: false })).results).toEqual([]);
    await refused(DETAIL, [ids.quiz1Rev2], "SELF_RECORD_FORBIDDEN");
    await refused(RECORD, [f.learnerEnrolmentId], "SELF_RECORD_FORBIDDEN");
    const rf = {
      ...f,
      assessment: {
        result: ids.quiz1Rev2,
        attempt: f.attemptId,
        questionId: f.questionId,
        max: 10,
      },
    } as unknown as RegradeFixture;
    await rejects(
      () => regradeGovern(rf, regradeArgs(rf), { actor: learner }),
      "SELF_REGRADE_FORBIDDEN",
    );
    await owner();
    expect(
      await value(
        "select count(*)::int as v from commercial_v1_examiner_regrade_executions where actor_id=$1",
        [learner],
      ),
    ).toBe(0);
  });
});

type Detail = {
  resultId: string;
  revisionNumber: number;
  isCurrent: boolean;
  history: { revisionNumber: number; isCurrent: boolean; isValid: boolean }[];
  historyHasMore: boolean;
  historyLimit: number;
  regradeClaim: Record<string, unknown> | null;
};

describe("bounded revision history (read bound, not a data limit)", () => {
  // Appends legitimate lab revisions through the unchanged migration 030
  // insert guards (sequence, identity, policy max/contribution) and the
  // unchanged objective derivation -- the same test-owner path as the
  // regrade suite's copy helper. Nothing is weakened to build the chain.
  async function appendLabRevisions(count: number) {
    await owner();
    for (let i = 0; i < count; i++) {
      const id = await value<string>(
        `insert into commercial_v1_lab_result_revisions(activation_id,enrolment_id,student_id,practical_id,submission_id,revision_number,earned_marks,max_marks,contribution_bp)
         select activation_id,enrolment_id,student_id,practical_id,submission_id,revision_number+1,earned_marks,max_marks,contribution_bp
         from commercial_v1_lab_result_revisions where enrolment_id=$1 and practical_id=$2
         order by revision_number desc limit 1 returning id as v`,
        [f.learnerEnrolmentId, f.practical],
      );
      await db.query(
        "select commercial_v1_private.derive_and_insert_lab_objective_outcomes($1)",
        [id],
      );
    }
  }
  async function newestLab() {
    await owner();
    return value<string>(
      "select id as v from commercial_v1_lab_result_revisions where enrolment_id=$1 order by revision_number desc limit 1",
      [f.learnerEnrolmentId],
    );
  }

  it("returns at most the newest 100 revisions, flags older history and keeps every revision", async () => {
    // Exactly 100 revisions: the whole chain fits, nothing more exists.
    await appendLabRevisions(99);
    await asPolicyUser(db, 2);
    let d = await value<Detail>(DETAIL, [await newestLab()]);
    expect(d.history).toHaveLength(100);
    expect(d.historyHasMore).toBe(false);
    expect(d.historyLimit).toBe(100);

    // 102 revisions: still bounded to the newest 100.
    await appendLabRevisions(2);
    const newest = await newestLab();
    await asPolicyUser(db, 2);
    d = await value<Detail>(DETAIL, [newest]);
    expect(d.revisionNumber).toBe(102);
    expect(d.history).toHaveLength(100);
    expect(d.historyHasMore).toBe(true);
    expect(d.history.map((h) => h.revisionNumber)).toEqual(
      Array.from({ length: 100 }, (_, i) => i + 3),
    );
    expect(d.history.at(-1)).toMatchObject({
      revisionNumber: 102,
      isCurrent: true,
      isValid: true,
    });

    // The selected revision loads even when older than the history window.
    const oldest = await value<Detail>(DETAIL, [ids.labRev1]);
    expect(oldest).toMatchObject({
      resultId: ids.labRev1,
      revisionNumber: 1,
      isCurrent: false,
      historyHasMore: true,
    });
    expect(oldest.history).toHaveLength(100);
    expect(oldest.history.map((h) => h.revisionNumber)).not.toContain(1);

    // Older revisions stay discoverable through the paginated listing.
    const seen: number[] = [];
    for (let offset = 0; ; offset += 50) {
      const page = await list({ kind: "LAB", currentOnly: false, offset });
      seen.push(...page.results.map((r) => r.revisionNumber));
      expect(page.results.length).toBeLessThanOrEqual(50);
      if (!page.hasMore) break;
    }
    expect(seen.sort((a, b) => a - b)).toEqual(
      Array.from({ length: 102 }, (_, i) => i + 1),
    );

    // Nothing was deleted or invalidated: 102 rows, every one valid.
    await owner();
    expect(
      await value(
        "select count(*)::int as v from commercial_v1_lab_result_revisions where enrolment_id=$1",
        [f.learnerEnrolmentId],
      ),
    ).toBe(102);
    expect(
      await value(
        "select bool_and(commercial_v1_private.lab_result_is_valid(id)) as v from commercial_v1_lab_result_revisions where enrolment_id=$1",
        [f.learnerEnrolmentId],
      ),
    ).toBe(true);
  });
});

describe("outgoing regrade claim (existing migration 032 authority)", () => {
  const forSource = (source: string) =>
    ({
      ...f,
      assessment: {
        result: source,
        attempt: f.attemptId,
        questionId: f.questionId,
        max: 10,
      },
    }) as unknown as RegradeFixture;
  async function claimFor(id: string) {
    await asPolicyUser(db, 2);
    return (await value<Detail>(DETAIL, [id])).regradeClaim;
  }
  async function executionsFor(source: string) {
    await owner();
    return value<number>(
      "select count(*)::int as v from commercial_v1_examiner_regrade_executions where source_result_revision_id=$1",
      [source],
    );
  }

  it("a current revision without a claim reports none", async () => {
    expect(await claimFor(ids.quiz1Rev2)).toBeNull();
    expect(await claimFor(ids.labRev1)).toBeNull();
  });

  it("a successful claim links the source to the revision it produced", async () => {
    const claim = await claimFor(ids.quiz1Rev1);
    expect(claim).toMatchObject({
      state: "SUCCEEDED",
      reasonCode: "GRADED",
      requestReason: "Independent institutional review",
      producedResultRevisionId: ids.quiz1Rev2,
      expired: false,
    });
    expect(claim!.actorName).toBeTruthy();
    expect(claim!.terminalAt).toBeTruthy();
    expect(Object.keys(claim!).sort()).toEqual(
      [
        "actorName",
        "createdAt",
        "executionId",
        "expired",
        "producedResultRevisionId",
        "reasonCode",
        "requestReason",
        "state",
        "terminalAt",
      ].sort(),
    );
  });

  it("an in-progress claim is reported as RUNNING", async () => {
    await regradeRunning(forSource(ids.quiz1Rev2));
    expect(await claimFor(ids.quiz1Rev2)).toMatchObject({
      state: "RUNNING",
      reasonCode: null,
      terminalAt: null,
      producedResultRevisionId: null,
      expired: false,
    });
    expect(await executionsFor(ids.quiz1Rev2)).toBe(1);
  });

  it.each([
    ["FAILED", "NO_PROVIDER_CONFIGURED"],
    ["ESCALATED", "HUMAN_REVIEW_REQUIRED"],
  ])(
    "a terminal %s claim stays durable after reload; replay creates nothing",
    async (state, reason) => {
      const rf = forSource(ids.quiz1Rev2);
      const s = await regradeRunning(rf);
      expect(
        await regradeGovern(rf, {
          ...s,
          p_operation: "FINALIZE",
          p_state: state,
          p_reason: reason,
          p_budget_stage: "NONE",
        }),
      ).toMatchObject({ ok: true, execution: { state } });

      const claim = await claimFor(ids.quiz1Rev2);
      expect(claim).toMatchObject({
        state,
        reasonCode: reason,
        requestReason: "Independent institutional review",
        producedResultRevisionId: null,
        expired: false,
      });
      expect(claim!.terminalAt).toBeTruthy();
      const text = JSON.stringify(claim);
      for (const field of [
        "gradeDigest",
        "reviewPath",
        "budget",
        "usage",
        "mac",
        "maxEstimatedCostMicrousd",
      ])
        expect(text).not.toContain(`"${field}"`);

      // The revision is still current and valid; its one claim is used.
      await asPolicyUser(db, 2);
      expect(
        await value<Detail & { isValid: boolean }>(DETAIL, [ids.quiz1Rev2]),
      ).toMatchObject({ isCurrent: true, isValid: true });

      // A direct replay through the existing authority returns the same
      // terminal outcome and creates no second execution or revision.
      await asPolicyUser(db, 2);
      expect(await regradeGovern(rf, regradeArgs(rf))).toMatchObject({
        ok: true,
        transitioned: false,
        execution: { state },
      });
      expect(await executionsFor(ids.quiz1Rev2)).toBe(1);
      await owner();
      expect(
        await value(
          "select count(*)::int as v from commercial_v1_assessment_result_revisions where enrolment_id=$1 and component='QUIZ_1'",
          [f.learnerEnrolmentId],
        ),
      ).toBe(2);
    },
  );
});

describe("enrolment record and completion visibility", () => {
  it("shows ACTIVE without a receipt; reading never completes", async () => {
    await asPolicyUser(db, 2);
    expect(await value(RECORD, [f.learnerEnrolmentId])).toMatchObject({
      enrolmentStatus: "ACTIVE",
      receipt: null,
      cohortTitle: expect.any(String),
      programmeTitle: expect.any(String),
    });
    await owner();
    expect(
      await value(
        "select count(*)::int as v from commercial_v1_completion_receipts",
      ),
    ).toBe(0);
    expect(
      await value("select status as v from enrolments where id=$1", [
        f.learnerEnrolmentId,
      ]),
    ).toBe("ACTIVE");
  });

  it("the existing admin completion authority refuses incomplete progress", async () => {
    await asPolicyUser(db, 2);
    const attempt = await value<{ ok: boolean; code: string }>(
      "select public.attempt_commercial_v1_course_completion($1,'Operations completion check') as v",
      [f.learnerEnrolmentId],
    );
    expect(attempt.ok).toBe(false);
    expect(attempt.code).not.toBe("NOT_FOUND_OR_FORBIDDEN");
  });

  it("a PAUSED enrolment is shown truthfully and cannot complete", async () => {
    await asPolicyUser(db, 2);
    await db.query(
      "select public.change_enrolment_status($1,'PAUSED','Learner paused studies')",
      [f.learnerEnrolmentId],
    );
    expect(await value(RECORD, [f.learnerEnrolmentId])).toMatchObject({
      enrolmentStatus: "PAUSED",
    });
    expect(
      (await list()).results.every((r) => r.enrolmentStatus === "PAUSED"),
    ).toBe(true);
    expect(
      await value<{ enrolmentStatus: string }>(PROGRESS, [
        f.learnerEnrolmentId,
      ]),
    ).toMatchObject({ enrolmentStatus: "PAUSED" });
    expect(
      await value(
        "select public.attempt_commercial_v1_course_completion($1,'Operations completion check') as v",
        [f.learnerEnrolmentId],
      ),
    ).toMatchObject({ ok: false, code: "ENROLMENT_NOT_ACTIVE" });
  });
});
