import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  describe,
  it,
  expect,
} from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  executionFixture,
  asExecutionUser,
  learner,
  administrator,
  foreignLearner,
} from "./execution-fixture";
import { buildPackage } from "./activation-fixture";
import { validateCoursePackage } from "@/domain/course-package";
import { activationInput, practicalSchema } from "@/domain/course-activation";
let db: PGlite, imp: string, version: string, cohort: string, enrolment: string;
const tables = [
  "course_activation_versions",
  "course_activation_lessons",
  "course_activation_objectives",
  "course_activations",
  "course_practicals",
  "course_practical_objectives",
  "course_assignment_bindings",
  "course_assignment_objectives",
  "course_assignment_rubrics",
  "course_assessment_bindings",
  "course_assessment_objectives",
];
async function value<T = string>(sql: string, args: unknown[] = []) {
  return (await db.query<{ v: T }>(sql, args)).rows[0].v;
}
async function owner() {
  await db.exec("reset role");
}
async function user(n = 2) {
  await asExecutionUser(db, n);
}
async function denied(sql: string, args: unknown[] = [], message?: string) {
  await db.exec("savepoint denial");
  try {
    await expect(db.query(sql, args)).rejects.toThrow(message);
  } finally {
    await db.exec("rollback to savepoint denial;release savepoint denial");
  }
}
const pkg = buildPackage();
pkg.packageKey = "activation-fixture";
pkg.modules[0].lessons[0].practicalActivities = [
  {
    key: "exercise",
    kind: "EXERCISE",
    title: "Exercise",
    instructions: "Practical instructions sentinel",
    position: 1,
    objectiveRefs: ["obj-1"],
  },
  {
    key: "lab",
    kind: "PRACTICAL_LAB",
    title: "Lab",
    instructions: "Lab instructions sentinel",
    position: 2,
    objectiveRefs: ["obj-1"],
  },
];
pkg.assignmentTemplates = [
  {
    key: "assignment",
    title: "Course assignment",
    instructions: "Assignment instructions sentinel",
    lessonRef: "lesson-1",
    objectiveRefs: ["obj-1"],
    rubric: [{ description: "Rubric sentinel", maxMarks: 10 }],
  },
];
pkg.assessmentTemplates[0].questions[0].expectedAnswer =
  "Expected answer sentinel";
pkg.assessmentTemplates[0].questions[0].markingGuidance =
  "Marking guidance sentinel";
function windows() {
  return {
    assignments: [
      {
        templateKey: "assignment",
        opensAt: "2026-01-01T00:00:00Z",
        dueAt: "2030-01-01T00:00:00Z",
      },
    ],
    assessments: [
      {
        templateKey: "assess-1",
        opensAt: "2026-01-01T00:00:00Z",
        closesAt: "2030-01-01T00:00:00Z",
      },
    ],
  };
}
function args(
  overrides: Partial<{
    importId: string;
    cohortId: string;
    instructorId: string;
    assignments: unknown;
    assessments: unknown;
    reason: string;
  }> = {},
) {
  const p = {
    importId: imp,
    cohortId: cohort,
    instructorId: administrator,
    ...windows(),
    reason: "Reviewed course activation",
    ...overrides,
  };
  return [
    p.importId,
    p.cohortId,
    p.instructorId,
    JSON.stringify(p.assignments),
    JSON.stringify(p.assessments),
    p.reason,
  ];
}
const activateSql =
  "select public.activate_course_package($1,$2,$3,$4::jsonb,$5::jsonb,$6) as v";
async function activate(overrides: Parameters<typeof args>[0] = {}) {
  return value(activateSql, args(overrides));
}
async function counts() {
  await owner();
  const result: Record<string, number> = {};
  for (const t of [
    ...tables,
    "assignments",
    "assessments",
    "assessment_questions",
    "assessment_answer_keys",
    "academic_agent_configs",
  ])
    result[t] = await value<number>(
      "select count(*)::int as v from public." + t,
    );
  await user();
  return result;
}
beforeAll(async () => {
  ({ db } = await executionFixture());
  await user();
  imp = await value(
    "select public.import_course_package($1,1,$2,$3::jsonb,$4) as v",
    [
      pkg.packageKey,
      pkg.schemaVersion,
      JSON.stringify(pkg),
      "Activation package fixture",
    ],
  );
  const validated = validateCoursePackage(pkg);
  if (!validated.valid) throw new Error("Invalid test package");
  await db.query(
    "select public.mark_course_package_validated($1,$2::jsonb,$3)",
    [imp, JSON.stringify(validated.report), "Validated fixture package"],
  );
  version = await value("select public.apply_course_package($1,$2) as v", [
    imp,
    "Apply fixture package",
  ]);
  // PR15: publish_course_package now requires a current passing
  // pre-publication test. This fixture does not exercise agent
  // configuration semantics, so every role is saved explicitly disabled
  // (the same default CourseAgentForm starts from) purely to satisfy the
  // governed test gate.
  for (const role of [
    "PROFESSOR",
    "TUTOR",
    "LAB_INSTRUCTOR",
    "EXAMINER",
    "COUNSELLOR",
  ]) {
    await db.query(
      "select public.set_agent_config($1,$2,false,null,null,'{}',$3,$4)",
      [version, role, "NONE", "Activation fixture agent configuration"],
    );
  }
  const testRun = await value(
    "select outcome as v from public.run_course_package_test($1,$2)",
    [imp, "Activation fixture pre-publication test"],
  );
  if (testRun !== "PASS")
    throw new Error(
      `Activation fixture pre-publication test did not pass: ${testRun}`,
    );
  await db.query("select public.publish_course_package($1,$2)", [
    imp,
    "Publish fixture package",
  ]);
  await owner();
  cohort = randomUUID();
  await db.query(
    "insert into public.cohorts(id,programme_version_id,title,starts_on) values($1,$2,'Activation cohort',current_date)",
    [cohort, version],
  );
  await user();
  enrolment = await value(
    "select public.create_enrolment($1,$2,'Reviewed fixture enrolment') as v",
    [learner, cohort],
  );
  await owner();
});
beforeEach(async () => {
  await db.exec("begin");
  await user();
});
afterEach(async () => {
  await db.exec("rollback;reset role");
});
afterAll(async () => {
  await db?.close();
});
describe("atomic cohort activation", () => {
  it.each(["STUDENT", "INSTRUCTOR", "COUNSELLOR", "REGISTRAR"])(
    "%s cannot activate",
    async (role) => {
      await owner();
      await db.query("delete from public.role_grants where user_id=$1", [
        administrator,
      ]);
      await db.query("insert into public.role_grants values($1,$2)", [
        administrator,
        role,
      ]);
      await user();
      await denied(activateSql, args(), "FORBIDDEN");
    },
  );
  it.each(["ACADEMIC_ADMIN", "PLATFORM_ADMIN"])(
    "%s materialises published coursework and five config rows",
    async (role) => {
      await owner();
      await db.query(
        "delete from public.role_grants where user_id=$1 and role<>'INSTRUCTOR'",
        [administrator],
      );
      await db.query("insert into public.role_grants values($1,$2)", [
        administrator,
        role,
      ]);
      await user();
      const id = await activate();
      expect(id).toMatch(/^[a-f0-9-]{36}$/);
      const c = await counts();
      expect(c.course_practicals).toBe(2);
      expect(c.course_assignment_rubrics).toBe(1);
      expect(c.course_assessment_objectives).toBe(1);
      expect(c.academic_agent_configs).toBe(5);
      await owner();
      expect(
        await value<boolean>(
          "select bool_and(status='PUBLISHED') as v from public.assignments where cohort_id=$1",
          [cohort],
        ),
      ).toBe(true);
    },
  );
  it("replay creates zero duplicate objects, including reordered/timezone-equivalent schedule input", async () => {
    const id = await activate();
    const before = await counts();
    expect(
      await activate({
        assignments: [
          {
            templateKey: "assignment",
            opensAt: "2026-01-01T01:00:00+01:00",
            dueAt: "2030-01-01T00:00:00Z",
          },
        ],
      }),
    ).toBe(id);
    expect(await counts()).toEqual(before);
  });
  it("rejects conflicting replay without changing canonical delivery", async () => {
    await activate();
    const before = await counts();
    await denied(
      activateSql,
      args({
        assignments: [
          { ...windows().assignments[0], dueAt: "2029-01-01T00:00:00Z" },
        ],
      }),
      "ACTIVATION_CONFLICT",
    );
    expect(await counts()).toEqual(before);
  });
  it("second cohort reuses version practicals/config while creating separate coursework", async () => {
    await activate();
    const before = await counts();
    await owner();
    const c = randomUUID();
    await db.query(
      "insert into public.cohorts(id,programme_version_id,title,starts_on) values($1,$2,'Second cohort',current_date)",
      [c, version],
    );
    await user();
    await activate({ cohortId: c });
    const after = await counts();
    expect(after.course_practicals).toBe(before.course_practicals);
    expect(after.academic_agent_configs).toBe(before.academic_agent_configs);
    expect(after.course_assignment_bindings).toBe(2);
    expect(after.course_assessment_bindings).toBe(2);
  });
  it("late config conflict rolls back every materialisation table and canonical coursework", async () => {
    await db.query(
      "select public.set_agent_config($1,'COUNSELLOR',true,null,null,array[]::text[],'NONE','Reviewed conflicting config')",
      [version],
    );
    const before = await counts();
    await denied(activateSql, args(), "CONFIG_CONFLICT");
    expect(await counts()).toEqual(before);
  });
  it("audit persistence failure rolls back all materialisation", async () => {
    const before = await counts();
    await owner();
    await db.exec(
      "create function course_activation_private.fail_audit() returns trigger language plpgsql as $$begin if NEW.action='COURSE_ACTIVATED' then raise exception 'audit failure'; end if; return NEW; end$$;create trigger fail_activation_audit before insert on public.audit_events for each row execute function course_activation_private.fail_audit()",
    );
    await user();
    await denied(activateSql, args(), "audit failure");
    expect(await counts()).toEqual(before);
  });
  it("unknown import, wrong version/cohort and substituted instructor fail closed", async () => {
    for (const change of [
      { importId: randomUUID() },
      { cohortId: "50000000-0000-4000-8000-000000000001" },
      { instructorId: foreignLearner },
    ])
      await denied(activateSql, args(change));
  });
  it("imported package cannot be activated", async () => {
    const p = structuredClone(pkg);
    p.packageKey = "unvalidated-activation";
    const id = await value(
      "select public.import_course_package($1,1,$2,$3::jsonb,$4) as v",
      [
        p.packageKey,
        p.schemaVersion,
        JSON.stringify(p),
        "Unvalidated package fixture",
      ],
    );
    await denied(activateSql, args({ importId: id }), "INVALID_STATE");
  });
  it("position-based provenance resolves exact published lesson/objective UUIDs", async () => {
    await activate();
    await owner();
    expect(
      await value<boolean>(
        "select bool_and(b.lesson_id=o.lesson_id and b.programme_version_id=o.programme_version_id and b.local_key='obj-1') as v from public.course_activation_objectives b join public.lesson_objectives o on o.id=b.objective_id",
      ),
    ).toBe(true);
    await denied(
      "update public.course_activation_lessons set local_key='forged'",
      [],
      "immutable",
    );
  });
  it.each(["assignments", "assessments"] as const)(
    "%s reject missing/extra/duplicate/unknown bindings and invalid dates",
    async (kind) => {
      const valid = windows()[kind][0];
      for (const list of [
        [],
        [valid, valid],
        [{ ...valid, templateKey: "unknown" }],
        [valid, { ...valid, templateKey: "extra" }],
        [{ ...valid, opensAt: "bad" }],
        [{ ...valid, opensAt: "2031-01-01T00:00:00Z" }],
        [{ ...valid, opensAt: "2030-01-01T00:00:00Z" }],
        [{ ...valid, actorId: learner }],
      ])
        await denied(activateSql, args({ [kind]: list }));
    },
  );
  it("activation options reveal only metadata and no protected or instructional text", async () => {
    const options = await value(
      "select public.get_course_activation_options($1) as v",
      [imp],
    );
    expect(JSON.stringify(options)).not.toMatch(
      /Expected answer|Marking guidance|Practical instructions|Rubric sentinel|raw_package|prompt/,
    );
  });
  it("audit contains identifiers and counts, not package/content/answers", async () => {
    await activate();
    await owner();
    const audit = await value(
      "select jsonb_agg(after_state) as v from public.audit_events where source='COURSE_ACTIVATION_V1'",
    );
    expect(JSON.stringify(audit)).toContain("assignment_count");
    expect(JSON.stringify(audit)).not.toMatch(
      /instructions|raw_package|expectedAnswer|expected_answer|markingGuidance|Marking guidance|Rubric sentinel/,
    );
  });
  // Acceptance correction: the bounded administrative reason supplied at
  // activation time must be the durable audit reason for the COURSE_ACTIVATED
  // receipt -- never a hardcoded string -- and must never be copied into the
  // content-minimised after_state.
  it("audit reason stores the bounded, trimmed administrative reason -- never the previous hardcoded string, never in after_state", async () => {
    await activate({
      reason: "  Reviewed course activation with extra detail  ",
    });
    await owner();
    const row = await value<{ reason: string; after_state: unknown }>(
      "select row_to_json(e) as v from public.audit_events e where source='COURSE_ACTIVATION_V1' and action='COURSE_ACTIVATED'",
    );
    expect(row.reason).toBe("Reviewed course activation with extra detail");
    expect(row.reason).not.toBe("Governed cohort activation");
    expect(JSON.stringify(row.after_state)).not.toMatch(
      /Reviewed course activation|extra detail/,
    );
    await user();
  });
  it("idempotent replay does not rewrite the original activation's audit reason, and creates zero duplicate receipts", async () => {
    await activate({ reason: "Original activation reason" });
    await owner();
    const before = await value<string>(
      "select reason as v from public.audit_events where source='COURSE_ACTIVATION_V1' and action='COURSE_ACTIVATED'",
    );
    await user();
    // Same logical activation (identical import/cohort/instructor/schedule
    // fingerprint) replayed with a DIFFERENT reason string.
    await activate({ reason: "Different replay reason" });
    await owner();
    const after = await value<string>(
      "select reason as v from public.audit_events where source='COURSE_ACTIVATION_V1' and action='COURSE_ACTIVATED'",
    );
    const receipts = await value<number>(
      "select count(*)::int as v from public.audit_events where source='COURSE_ACTIVATION_V1' and action='COURSE_ACTIVATED'",
    );
    expect(before).toBe("Original activation reason");
    expect(after).toBe("Original activation reason");
    expect(receipts).toBe(1);
    await user();
  });
});

// Blocker 1 regression: COURSE_PACKAGE_V1 scopes objective and
// practical-activity local keys to their OWNING LESSON, not the whole
// package (src/domain/course-package.ts's own duplicate-key rules validate
// exactly this: "within a lesson", never "within the package"). Two
// different lessons legitimately reusing the same objective key ("obj-1")
// and the same practical key ("lab") must activate successfully, with each
// lesson's own provenance/objective/rubric mappings staying strictly
// scoped to that lesson -- never resolving to the other lesson merely
// because the local key text is identical.
describe("multi-lesson reused local keys (Blocker 1 regression)", () => {
  let imp2: string, version2: string, cohort2: string;
  const multiLessonPkg = buildPackage();
  multiLessonPkg.packageKey = "activation-multi-lesson-fixture";
  multiLessonPkg.modules[0].lessons = [
    {
      key: "lesson-1",
      title: "Access Control",
      position: 1,
      objectives: [
        {
          key: "obj-1",
          description: "Explain authentication for lesson one",
          position: 1,
        },
      ],
      resources: [],
      practicalActivities: [
        {
          key: "lab",
          kind: "PRACTICAL_LAB",
          title: "Lesson 1 lab",
          instructions: "Lesson 1 lab instructions",
          position: 1,
          objectiveRefs: ["obj-1"],
        },
      ],
    },
    {
      key: "lesson-2",
      title: "Network Security",
      position: 2,
      objectives: [
        {
          key: "obj-1",
          description: "Explain segmentation for lesson two",
          position: 1,
        },
      ],
      resources: [],
      practicalActivities: [
        {
          key: "lab",
          kind: "PRACTICAL_LAB",
          title: "Lesson 2 lab",
          instructions: "Lesson 2 lab instructions",
          position: 1,
          objectiveRefs: ["obj-1"],
        },
      ],
    },
  ];
  multiLessonPkg.assignmentTemplates = [
    {
      key: "assignment-lesson-1",
      title: "Lesson 1 assignment",
      instructions: "Lesson 1 assignment instructions",
      lessonRef: "lesson-1",
      objectiveRefs: ["obj-1"],
      rubric: [{ description: "Criterion", maxMarks: 5 }],
    },
    {
      key: "assignment-lesson-2",
      title: "Lesson 2 assignment",
      instructions: "Lesson 2 assignment instructions",
      lessonRef: "lesson-2",
      objectiveRefs: ["obj-1"],
      rubric: [{ description: "Criterion", maxMarks: 5 }],
    },
  ];
  multiLessonPkg.assessmentTemplates = [
    {
      key: "assess-lesson-1",
      title: "Lesson 1 checkpoint",
      instructions: "Answer under exam conditions.",
      lessonRef: "lesson-1",
      durationMinutes: 30,
      attemptsAllowed: 1,
      questions: [
        {
          position: 1,
          prompt: "Define authentication.",
          maxMarks: 5,
          expectedAnswer: "The process of verifying identity.",
          markingGuidance: null,
          objectiveRefs: ["obj-1"],
        },
      ],
    },
    {
      key: "assess-lesson-2",
      title: "Lesson 2 checkpoint",
      instructions: "Answer under exam conditions.",
      lessonRef: "lesson-2",
      durationMinutes: 30,
      attemptsAllowed: 1,
      questions: [
        {
          position: 1,
          prompt: "Define segmentation.",
          maxMarks: 5,
          expectedAnswer: "Dividing a network into isolated zones.",
          markingGuidance: null,
          objectiveRefs: ["obj-1"],
        },
      ],
    },
  ];
  function multiLessonActivationArgs() {
    return [
      imp2,
      cohort2,
      administrator,
      JSON.stringify([
        {
          templateKey: "assignment-lesson-1",
          opensAt: "2026-01-01T00:00:00Z",
          dueAt: "2030-01-01T00:00:00Z",
        },
        {
          templateKey: "assignment-lesson-2",
          opensAt: "2026-01-01T00:00:00Z",
          dueAt: "2030-01-01T00:00:00Z",
        },
      ]),
      JSON.stringify([
        {
          templateKey: "assess-lesson-1",
          opensAt: "2026-01-01T00:00:00Z",
          closesAt: "2030-01-01T00:00:00Z",
        },
        {
          templateKey: "assess-lesson-2",
          opensAt: "2026-01-01T00:00:00Z",
          closesAt: "2030-01-01T00:00:00Z",
        },
      ]),
      "Multi-lesson reused-key activation",
    ];
  }

  it("validateCoursePackage accepts the same objective/practical key reused across different lessons", () => {
    const result = validateCoursePackage(multiLessonPkg);
    expect(result.valid).toBe(true);
  });

  beforeAll(async () => {
    const validated = validateCoursePackage(multiLessonPkg);
    if (!validated.valid)
      throw new Error("Invalid multi-lesson regression fixture package");
    await user();
    imp2 = await value(
      "select public.import_course_package($1,1,$2,$3::jsonb,$4) as v",
      [
        multiLessonPkg.packageKey,
        multiLessonPkg.schemaVersion,
        JSON.stringify(multiLessonPkg),
        "Multi-lesson fixture import",
      ],
    );
    // Database package validation (course_engineering_private.
    // assert_full_package_valid) must also accept the reused per-lesson
    // keys -- this throws (failing the whole describe block) if it does not.
    await db.query(
      "select public.mark_course_package_validated($1,$2::jsonb,$3)",
      [
        imp2,
        JSON.stringify(validated.report),
        "Multi-lesson validated fixture",
      ],
    );
    version2 = await value("select public.apply_course_package($1,$2) as v", [
      imp2,
      "Apply multi-lesson fixture",
    ]);
    // PR15: publish_course_package now requires a current passing
    // pre-publication test.
    for (const role of [
      "PROFESSOR",
      "TUTOR",
      "LAB_INSTRUCTOR",
      "EXAMINER",
      "COUNSELLOR",
    ]) {
      await db.query(
        "select public.set_agent_config($1,$2,false,null,null,'{}',$3,$4)",
        [version2, role, "NONE", "Multi-lesson fixture agent configuration"],
      );
    }
    const testRun2 = await value(
      "select outcome as v from public.run_course_package_test($1,$2)",
      [imp2, "Multi-lesson fixture pre-publication test"],
    );
    if (testRun2 !== "PASS")
      throw new Error(
        `Multi-lesson fixture pre-publication test did not pass: ${testRun2}`,
      );
    await db.query("select public.publish_course_package($1,$2)", [
      imp2,
      "Publish multi-lesson fixture",
    ]);
    await owner();
    cohort2 = randomUUID();
    await db.query(
      "insert into public.cohorts(id,programme_version_id,title,starts_on) values($1,$2,'Multi-lesson cohort',current_date)",
      [cohort2, version2],
    );
    await user();
  });

  it("course application and publication succeed for the reused-per-lesson-key package", async () => {
    await owner();
    expect(
      await value<string>(
        "select status as v from public.course_package_imports where id=$1",
        [imp2],
      ),
    ).toBe("PUBLISHED");
    await user();
  });

  it("cohort activation succeeds, materialising both lessons' objectives/practicals/assignments/assessments without cross-lesson resolution", async () => {
    const id = await value(
      "select public.activate_course_package($1,$2,$3,$4::jsonb,$5::jsonb,$6) as v",
      multiLessonActivationArgs(),
    );
    expect(id).toMatch(/^[a-f0-9-]{36}$/);
    await owner();

    // Two objective provenance rows for local key "obj-1", one per lesson,
    // each pointing at a DIFFERENT institutional objective UUID.
    const objectiveRows = (
      await db.query<{ lesson_id: string; objective_id: string }>(
        "select lesson_id,objective_id from public.course_activation_objectives where import_id=$1 and local_key='obj-1' order by lesson_id",
        [imp2],
      )
    ).rows;
    expect(objectiveRows).toHaveLength(2);
    expect(new Set(objectiveRows.map((r) => r.lesson_id)).size).toBe(2);
    expect(new Set(objectiveRows.map((r) => r.objective_id)).size).toBe(2);
    // Each objective provenance row maps to the correct institutional
    // objective UUID for its OWN lesson.
    for (const row of objectiveRows) {
      expect(
        await value<string>(
          "select lesson_id as v from public.lesson_objectives where id=$1",
          [row.objective_id],
        ),
      ).toBe(row.lesson_id);
    }

    // Two practical rows for local key "lab", one per lesson.
    const practicalRows = (
      await db.query<{ id: string; lesson_id: string }>(
        "select id,lesson_id from public.course_practicals where import_id=$1 and local_key='lab' order by lesson_id",
        [imp2],
      )
    ).rows;
    expect(practicalRows).toHaveLength(2);
    expect(new Set(practicalRows.map((r) => r.lesson_id)).size).toBe(2);
    // Each practical's objective mapping resolves to exactly one objective,
    // belonging to that SAME practical's own lesson -- never the other
    // lesson's objective, even though the local key text ("obj-1") matches.
    for (const practical of practicalRows) {
      const mapped = (
        await db.query<{ objective_id: string; lesson_id: string }>(
          "select po.objective_id,o.lesson_id from public.course_practical_objectives po join public.lesson_objectives o on o.id=po.objective_id where po.practical_id=$1",
          [practical.id],
        )
      ).rows;
      expect(mapped).toHaveLength(1);
      expect(mapped[0].lesson_id).toBe(practical.lesson_id);
    }

    // Assignment objective mapping cannot cross lessons.
    const assignmentRows = (
      await db.query<{ assignment_id: string; lesson_id: string }>(
        "select assignment_id,lesson_id from public.course_assignment_bindings where import_id=$1",
        [imp2],
      )
    ).rows;
    expect(assignmentRows).toHaveLength(2);
    for (const a of assignmentRows) {
      const mapped = (
        await db.query<{ objective_id: string; lesson_id: string }>(
          "select ao.objective_id,o.lesson_id from public.course_assignment_objectives ao join public.lesson_objectives o on o.id=ao.objective_id where ao.assignment_id=$1",
          [a.assignment_id],
        )
      ).rows;
      expect(mapped).toHaveLength(1);
      expect(mapped[0].lesson_id).toBe(a.lesson_id);
    }

    // Assessment question objective mapping cannot cross lessons either.
    const assessmentRows = (
      await db.query<{ assessment_id: string; lesson_id: string }>(
        "select assessment_id,lesson_id from public.course_assessment_bindings where import_id=$1",
        [imp2],
      )
    ).rows;
    expect(assessmentRows).toHaveLength(2);
    for (const a of assessmentRows) {
      const mapped = (
        await db.query<{ objective_id: string; lesson_id: string }>(
          "select qo.objective_id,o.lesson_id from public.course_assessment_objectives qo join public.lesson_objectives o on o.id=qo.objective_id where qo.assessment_id=$1",
          [a.assessment_id],
        )
      ).rows;
      expect(mapped).toHaveLength(1);
      expect(mapped[0].lesson_id).toBe(a.lesson_id);
    }
    await user();
  });
});

describe("learner practical and canonical coursework integration", () => {
  it("own practicals are bounded institutional projections with no engagement writes", async () => {
    await activate();
    await user(1);
    const rows = await value<unknown[]>(
      "select public.list_my_practicals($1) as v",
      [enrolment],
    );
    expect(rows).toHaveLength(2);
    rows.forEach((x) => practicalSchema.parse(x));
    await owner();
    for (const t of [
      "learning_evidence",
      "objective_mastery",
      "lesson_progress",
      "attendance_records",
    ])
      expect(
        await value<number>(
          "select count(*)::int as v from public." +
            t +
            " where enrolment_id=$1",
          [enrolment],
        ),
      ).toBe(0);
  });
  it("foreign and multi-role learner cannot inherit staff scope", async () => {
    await activate();
    await owner();
    await db.query(
      "insert into public.role_grants values($1,'ACADEMIC_ADMIN')",
      [foreignLearner],
    );
    await user(3);
    await denied(
      "select public.list_my_practicals($1)",
      [enrolment],
      "NOT_FOUND_OR_FORBIDDEN",
    );
    await user(1);
    expect(
      await value<unknown[]>("select public.list_my_practicals($1) as v", [
        enrolment,
      ]),
    ).toHaveLength(2);
  });
  it("pagination and unactivated version have explicit empty pages", async () => {
    await activate();
    await user(1);
    expect(
      await value<unknown[]>("select public.list_my_practicals($1,20) as v", [
        enrolment,
      ]),
    ).toEqual([]);
    await denied(
      "select public.list_my_practicals($1,-1)",
      [enrolment],
      "INVALID_INPUT",
    );
  });
  it.each([
    ["EXERCISE", "TUTOR"],
    ["PRACTICAL_LAB", "LAB_INSTRUCTOR"],
  ])("%s creates only a learner referral to %s", async (kind, destination) => {
    await activate();
    await owner();
    const id = await value(
      "select id as v from public.course_practicals where kind=$1",
      [kind],
    );
    await user(1);
    const req = randomUUID();
    const h = await value(
      "select public.request_practical_support($1,$2,$3) as v",
      [enrolment, id, req],
    );
    expect(
      await value("select public.request_practical_support($1,$2,$3) as v", [
        enrolment,
        id,
        req,
      ]),
    ).toBe(h);
    await owner();
    expect(
      await value(
        "select destination_profile as v from public.delivery_handoffs where id=$1",
        [h],
      ),
    ).toBe(destination);
    expect(
      await value<number>(
        "select count(*)::int as v from public.objective_mastery where enrolment_id=$1",
        [enrolment],
      ),
    ).toBe(0);
  });
  it("assignment submission and controlled question release/submission remain canonical", async () => {
    await activate();
    await owner();
    const assignment = await value(
      "select assignment_id as v from public.course_assignment_bindings",
    );
    const assessment = await value(
      "select assessment_id as v from public.course_assessment_bindings",
    );
    const practical = await value(
      "select id as v from public.course_practicals limit 1",
    );
    await user(1);
    expect(
      await value<number>(
        "select count(*)::int as v from public.assignments where id=$1",
        [assignment],
      ),
    ).toBe(1);
    await db.query(
      "select public.submit_assignment($1,'Learner response fixture',$2)",
      [assignment, randomUUID()],
    );
    await denied("select * from public.assessment_answer_keys");
    await denied("select * from public.get_active_assessment_questions($1)", [
      assessment,
    ]);
    const attempt = await value(
      "select public.start_assessment_attempt($1) as v",
      [assessment],
    );
    const questions = (
      await db.query<{ id: string; prompt: string }>(
        "select * from public.get_active_assessment_questions($1)",
        [assessment],
      )
    ).rows;
    expect(JSON.stringify(questions)).not.toMatch(
      /Expected answer|Marking guidance|expected_answer|marking_guidance/,
    );
    await denied("select public.assert_academic_action_allowed('EXPLAIN')");
    await denied("select public.list_my_practicals($1)", [enrolment]);
    await denied("select public.request_practical_support($1,$2,$3)", [
      enrolment,
      practical,
      randomUUID(),
    ]);
    await db.query(
      "select public.record_assessment_response($1,$2,'Learner answer fixture',$3)",
      [attempt, questions[0].id, randomUUID()],
    );
    await db.query("select public.submit_assessment_attempt($1)", [attempt]);
    expect(
      await value<unknown[]>("select public.list_my_practicals($1) as v", [
        enrolment,
      ]),
    ).toHaveLength(2);
  });
});
describe("activation ACL and strict contracts", () => {
  it.each(["anon", "authenticated", "service_role"])(
    "%s has no direct table/column or private helper authority",
    async (role) => {
      await owner();
      for (const t of tables) {
        expect(
          await value<boolean>("select has_table_privilege($1,$2,$3) as v", [
            role,
            "public." + t,
            "SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER",
          ]),
        ).toBe(false);
        expect(
          await value<boolean>(
            "select has_any_column_privilege($1,$2,$3) as v",
            [role, "public." + t, "SELECT,INSERT,UPDATE,REFERENCES"],
          ),
        ).toBe(false);
      }
      expect(
        await value<boolean>(
          "select has_schema_privilege($1,'course_activation_private','USAGE,CREATE') as v",
          [role],
        ),
      ).toBe(false);
      expect(
        await value<boolean>(
          "select bool_or(has_function_privilege($1,p.oid,'EXECUTE')) as v from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='course_activation_private'",
          [role],
        ),
      ).toBe(false);
    },
  );
  it("service_role cannot invoke activation or read protected staging/answers", async () => {
    await owner();
    await db.exec("set role service_role");
    await denied(activateSql, args(), "permission denied");
    await denied(
      "select * from public.course_package_imports",
      [],
      "permission denied",
    );
    await denied(
      "select * from public.assessment_answer_keys",
      [],
      "permission denied",
    );
  });
  it("contracts reject client role, actor, mappings, capability, profile and arbitrary JSON", () => {
    const valid = {
      importId: imp,
      cohortId: cohort,
      instructorId: administrator,
      ...windows(),
      reason: "Reviewed activation",
    };
    expect(activationInput.safeParse(valid).success).toBe(true);
    for (const field of [
      "actorId",
      "role",
      "provider",
      "model",
      "capability",
      "mapping",
      "payload",
    ])
      expect(
        activationInput.safeParse({ ...valid, [field]: "forged" }).success,
      ).toBe(false);
  });
  // Commercial V1 — Governed Tutor + Lab Instructor Execution added a real,
  // separately governed Tutor/Lab execution path (src/server/tutor-lab-
  // execution), reachable from this exact file -- so the original "no
  // provider/model text anywhere in this file" assertion is now
  // intentionally too strong (this file legitimately imports and documents
  // that governed path). What must still hold, unchanged: Professor's own
  // executeRoleCapability entrypoint is never reachable from here (Tutor/Lab
  // execution is composed through its own separate boundary, never through
  // executeRoleCapability or ROLES_WITH_REVIEWED_EXECUTION_PATH), and the
  // browser can never supply a role/provider/model/capability/budget/
  // destination form field that would let it choose an execution target.
  it("Professor's executeRoleCapability remains the only entrypoint reached via ROLES_WITH_REVIEWED_EXECUTION_PATH, and Tutor/Lab execution never accepts a browser-selected role/provider/model/capability/budget", async () => {
    const source = await readFile(
      "src/server/academic-runtime/index.ts",
      "utf8",
    );
    expect(source).toMatch(
      /ROLES_WITH_REVIEWED_EXECUTION_PATH[^=]*= new Set\(\[\s*"PROFESSOR",?\s*\]\)/,
    );
    const practicalsActions = await readFile(
      "src/app/student/practicals/actions.ts",
      "utf8",
    );
    expect(practicalsActions).not.toMatch(/executeRoleCapability/);
    expect(practicalsActions).not.toMatch(
      /form\.get\(\s*["'](role|provider|model|capability|budget|destination)["']\s*\)/i,
    );
  });
});

describe("activation independent adversarial review", () => {
  it.each(tables)(
    "%s cannot be changed or deleted after activation",
    async (table) => {
      await activate();
      await owner();
      await denied("delete from public." + table, [], "immutable");
      const col = await value(
        "select attname as v from pg_attribute where attrelid=$1::regclass and attnum=1",
        ["public." + table],
      );
      await denied(
        "update public." + table + " set " + col + "=" + col,
        [],
        "immutable",
      );
    },
  );
  it.each([
    "select",
    "insert",
    "update",
    "delete",
    "truncate",
    "references",
    "trigger",
    "select(id)",
    "update(id)",
  ])(
    "inherited service_role %s fails effective ACL acceptance",
    async (permission) => {
      await owner();
      await db.exec(
        "create role unsafe_activation_member;grant unsafe_activation_member to service_role;grant " +
          permission +
          " on public.course_activations to unsafe_activation_member",
      );
      const migration = await readFile(
        "supabase/migrations/202609140027_commercial_v1_course_activation.sql",
        "utf8",
      );
      const acceptance = migration.slice(
        migration.indexOf("-- Effective activation ACL acceptance:"),
      );
      await denied(acceptance, [], "Unsafe activation privileges");
    },
  );
  it("inherited private helper execution fails acceptance even without schema usage", async () => {
    await owner();
    await db.exec(
      "create role unsafe_activation_member;grant unsafe_activation_member to service_role;grant execute on function course_activation_private.require_admin() to unsafe_activation_member",
    );
    const migration = await readFile(
      "supabase/migrations/202609140027_commercial_v1_course_activation.sql",
      "utf8",
    );
    await denied(
      migration.slice(
        migration.indexOf("-- Effective activation ACL acceptance:"),
      ),
      [],
      "Unsafe activation privileges",
    );
  });
  it("package config cannot widen role policy even via direct validation RPC", async () => {
    const p = structuredClone(pkg);
    p.packageKey = "bad-activation-policy";
    p.agentConfiguration.TUTOR.capabilities = ["unrestricted_sql"];
    const id = await value(
      "select public.import_course_package($1,1,$2,$3::jsonb,$4) as v",
      [
        p.packageKey,
        p.schemaVersion,
        JSON.stringify(p),
        "Policy fixture import",
      ],
    );
    await denied(
      "select public.mark_course_package_validated($1,'{}'::jsonb,'Forged validation report')",
      [id],
    );
    await denied(activateSql, args({ importId: id }), "INVALID_STATE");
  });
  it("second cohort conflict preserves prior materialisation and configuration", async () => {
    await activate();
    await db.query(
      "select public.set_agent_config($1,'TUTOR',true,null,null,array[]::text[],'NONE','Separate reviewed config change')",
      [version],
    );
    await owner();
    const c = randomUUID();
    await db.query(
      "insert into public.cohorts(id,programme_version_id,title,starts_on) values($1,$2,'Conflicting cohort',current_date)",
      [c, version],
    );
    await user();
    const before = await counts();
    await denied(activateSql, args({ cohortId: c }), "CONFIG_CONFLICT");
    expect(await counts()).toEqual(before);
  });
  it("forged objective mapping violates the exact lesson/version composite FK", async () => {
    await activate();
    await owner();
    const row = (
      await db.query<{
        assignment_id: string;
        import_id: string;
        lesson_id: string;
        programme_version_id: string;
      }>("select * from public.course_assignment_bindings")
    ).rows[0];
    const foreign = await value(
      "select id as v from public.lesson_objectives where programme_version_id<>$1 limit 1",
      [version],
    );
    await denied(
      "insert into public.course_assignment_objectives values($1,$2,$3,$4,$5)",
      [
        row.assignment_id,
        row.import_id,
        row.lesson_id,
        row.programme_version_id,
        foreign,
      ],
      "foreign key",
    );
  });
  it("unauthenticated activation, practical reads and support cannot execute", async () => {
    await asExecutionUser(db, null);
    await denied(activateSql, args(), "FORBIDDEN");
    await denied(
      "select public.list_my_practicals($1)",
      [enrolment],
      "FORBIDDEN",
    );
    await denied(
      "select public.request_practical_support($1,$2,$3)",
      [enrolment, randomUUID(), randomUUID()],
      "FORBIDDEN",
    );
  });
  it("activation has database locks and unique canonical keys rather than a client check-then-insert", async () => {
    await owner();
    const definition = await value(
      "select pg_get_functiondef('public.activate_course_package(uuid,uuid,uuid,jsonb,jsonb,text)'::regprocedure) as v",
    );
    expect(definition).toMatch(
      /course_package_imports where id=p_import_id for update/,
    );
    expect(definition).toMatch(
      /programme_versions where id=imp.programme_version_id and status='PUBLISHED' for update/,
    );
    expect(definition).toMatch(/cohorts where id=p_cohort_id for update/);
    expect(
      await value<number>(
        "select count(*)::int as v from pg_constraint where conrelid='public.course_activations'::regclass and contype='u'",
      ),
    ).toBeGreaterThan(0);
  });
});
