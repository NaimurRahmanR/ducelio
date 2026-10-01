import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { testDatabase } from "./db-helper";

// Hosted PostgREST embeds a relation only through a foreign key between the
// two tables and answers HTTP 400 PGRST200 otherwise. Local test doubles do
// not resolve embeds that way, so these admin workspace reads are checked
// against their source and against the REAL migrated FK graph.

const mocks = vi.hoisted(() => ({ client: vi.fn() }));
vi.mock("@/server/supabase", () => ({ createSupabase: mocks.client }));
vi.mock("@/server/identity", () => ({
  requireActor: vi.fn(),
  requireAnyRole: vi.fn(),
  requireStudentPrincipal: vi.fn(),
}));
vi.mock("@/lib/env", () => ({ config: () => ({ configured: true }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { getLearningResourceWorkspace } from "@/server/learning-resources";
import { getObjectiveMasteryWorkspace } from "@/server/objective-mastery";
import { getAssessmentWorkspace } from "@/server/assessments";

function functionSource(source: string, name: string) {
  const start = source.indexOf(`export async function ${name}`);
  if (start < 0) throw new Error(`Missing function ${name}`);
  const next = source.indexOf("\nexport async function ", start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}

const learningResourcesSource = functionSource(
  readFileSync("src/server/learning-resources.ts", "utf8"),
  "getLearningResourceWorkspace",
);
const objectiveMasterySource = functionSource(
  readFileSync("src/server/objective-mastery.ts", "utf8"),
  "getObjectiveMasteryWorkspace",
);
const assessmentsSource = functionSource(
  readFileSync("src/server/assessments.ts", "utf8"),
  "getAssessmentWorkspace",
);
const classSessionsSource = readFileSync(
  "src/server/class-sessions.ts",
  "utf8",
);

// Every [parent, embedded] edge in a PostgREST select, including nested ones.
function embedEdges(table: string, select: string) {
  const edges: [string, string][] = [];
  const stack = [table];
  for (const match of select.matchAll(/([a-z_]+)(?:![a-z_]+)?\(|\)/g)) {
    if (match[0] === ")") stack.pop();
    else {
      edges.push([stack[stack.length - 1], match[1]]);
      stack.push(match[1]);
    }
  }
  return edges;
}

type Call = { table: string; select: string; filters: [string, unknown][] };
type Result = { data: unknown; error: unknown };

function fakeClient(
  tables: Record<string, Result>,
  rpc: Record<string, Result> = {},
) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      const call: Call = { table, select: "", filters: [] };
      calls.push(call);
      const builder = {
        select(select: string) {
          call.select = select;
          return builder;
        },
        in(column: string, values: unknown) {
          call.filters.push([column, values]);
          return builder;
        },
        order: () => builder,
        limit: () => builder,
        then(resolve: (value: Result) => unknown) {
          return Promise.resolve(
            tables[table] ?? { data: null, error: { message: "unexpected" } },
          ).then(resolve);
        },
      };
      return builder;
    },
    rpc: async (name: string) =>
      rpc[name] ?? { data: null, error: { message: "unexpected" } },
  };
  return { client, calls };
}

const ok = (data: unknown): Result => ({ data, error: null });
const failed: Result = { data: null, error: { message: "denied" } };

let db: PGlite;
beforeAll(async () => {
  db = await testDatabase();
}, 120000);
afterAll(async () => db?.close());
beforeEach(() => mocks.client.mockReset());

async function foreignKeyCount(from: string, to: string) {
  const result = await db.query<{ v: number }>(
    `select count(*)::int as v from pg_constraint
      where contype='f'
        and ((conrelid=to_regclass('public.'||$1) and confrelid=to_regclass('public.'||$2))
          or (conrelid=to_regclass('public.'||$2) and confrelid=to_regclass('public.'||$1)))`,
    [from, to],
  );
  return result.rows[0].v;
}

async function expectResolvableEmbeds(calls: Call[]) {
  const checked: string[] = [];
  for (const { table, select } of calls)
    for (const [parent, relation] of embedEdges(table, select)) {
      expect(
        await foreignKeyCount(parent, relation),
        `${parent} -> ${relation} has no foreign key PostgREST could embed through`,
      ).toBeGreaterThan(0);
      checked.push(`${parent}->${relation}`);
    }
  return checked;
}

describe("migrated FK graph behind the admin workspace projections", () => {
  it("has no direct programme_versions FK from learning_resources, lessons or assessments, nor objective_mastery -> lessons", async () => {
    expect(
      await foreignKeyCount("learning_resources", "programme_versions"),
    ).toBe(0);
    expect(await foreignKeyCount("lessons", "programme_versions")).toBe(0);
    expect(await foreignKeyCount("assessments", "programme_versions")).toBe(0);
    expect(await foreignKeyCount("objective_mastery", "lessons")).toBe(0);
  });

  it("keeps the valid relationships these reads still embed through", async () => {
    for (const [from, to] of [
      ["learning_resources", "lessons"],
      ["lessons", "modules"],
      ["objective_mastery", "lesson_objectives"],
      ["lesson_objectives", "lessons"],
      ["assessments", "cohorts"],
      ["assessments", "lessons"],
      ["class_sessions", "programme_versions"],
    ])
      expect(
        await foreignKeyCount(from, to),
        `${from} -> ${to}`,
      ).toBeGreaterThan(0);
  });
});

describe("getLearningResourceWorkspace", () => {
  const versionA = randomUUID();
  const versionB = randomUUID();
  const lessonA = randomUUID();
  const lessonB = randomUUID();
  const lessonRows = [
    {
      id: lessonA,
      programme_version_id: versionA,
      title: "Lesson A",
      position: 1,
      modules: { title: "Module 1", position: 1 },
    },
    {
      id: lessonB,
      programme_version_id: versionB,
      title: "Lesson B",
      position: 1,
      modules: { title: "Module 1", position: 1 },
    },
  ];
  const resourceRows = [
    {
      id: randomUUID(),
      lesson_id: lessonA,
      programme_version_id: versionA,
      kind: "LECTURE_NOTE",
      title: "Notes",
      body: "Demo note",
      url: null,
      position: 1,
      lessons: { title: "Lesson A" },
    },
  ];
  const versionRows = [
    {
      id: versionA,
      label: "v1",
      status: "PUBLISHED",
      title_snapshot: "Demo A",
    },
    { id: versionB, label: "v2", status: "DRAFT", title_snapshot: null },
  ];

  it("no longer embeds programme_versions from learning_resources or lessons in source", () => {
    expect(learningResourcesSource).toContain(
      "id,lesson_id,programme_version_id,kind,title,body,url,position,lessons(title)",
    );
    expect(learningResourcesSource).toContain(
      "id,programme_version_id,title,position,modules(title,position)",
    );
    expect(learningResourcesSource).not.toContain("programme_versions(");
    expect(learningResourcesSource).toContain('.from("programme_versions")');
    expect(learningResourcesSource).toContain('.in("id", versionIds)');
  });

  it("reads the visible versions separately and preserves the workspace shape", async () => {
    const fake = fakeClient({
      lessons: ok(lessonRows),
      learning_resources: ok(resourceRows),
      programme_versions: ok(versionRows),
    });
    mocks.client.mockResolvedValue(fake.client);
    const workspace = await getLearningResourceWorkspace();

    const versionRead = fake.calls.find(
      (c) => c.table === "programme_versions",
    );
    expect(versionRead?.select).toBe("id,label,status,title_snapshot");
    expect(versionRead?.filters).toEqual([["id", [versionA, versionB]]]);
    expect(await expectResolvableEmbeds(fake.calls)).toEqual(
      expect.arrayContaining([
        "lessons->modules",
        "learning_resources->lessons",
      ]),
    );

    expect(workspace.lessons).toEqual([
      {
        ...lessonRows[0],
        programme_versions: {
          label: "v1",
          status: "PUBLISHED",
          title_snapshot: "Demo A",
        },
      },
      {
        ...lessonRows[1],
        programme_versions: {
          label: "v2",
          status: "DRAFT",
          title_snapshot: null,
        },
      },
    ]);
    expect(workspace.resources).toEqual([
      {
        ...resourceRows[0],
        programme_versions: {
          label: "v1",
          status: "PUBLISHED",
          title_snapshot: "Demo A",
        },
      },
    ]);
  });

  it("skips the version read when nothing is visible", async () => {
    const fake = fakeClient({ lessons: ok([]), learning_resources: ok([]) });
    mocks.client.mockResolvedValue(fake.client);
    expect(await getLearningResourceWorkspace()).toEqual({
      lessons: [],
      resources: [],
    });
    expect(fake.calls.some((c) => c.table === "programme_versions")).toBe(
      false,
    );
  });

  it("fails closed when the version read fails or a version is missing", async () => {
    for (const versions of [failed, ok(versionRows.slice(0, 1))]) {
      mocks.client.mockResolvedValue(
        fakeClient({
          lessons: ok(lessonRows),
          learning_resources: ok(resourceRows),
          programme_versions: versions,
        }).client,
      );
      await expect(getLearningResourceWorkspace()).rejects.toThrow(
        "Learning resource workspace could not be loaded.",
      );
    }
  });
});

describe("getObjectiveMasteryWorkspace", () => {
  const masteryRow = {
    id: randomUUID(),
    enrolment_id: randomUUID(),
    student_id: randomUUID(),
    objective_id: randomUUID(),
    lesson_id: randomUUID(),
    programme_version_id: randomUUID(),
    state: "DEVELOPING",
    evidence_count: 2,
    correct_evidence_count: 1,
    correct_session_count: 1,
    correct_kind_count: 1,
    policy_version: "mastery-v1",
    evaluated_at: "2026-09-30T10:00:00Z",
  };

  it("traverses objective_mastery to lessons through lesson_objectives in source", () => {
    expect(objectiveMasterySource).toContain(
      "lesson_objectives(description,position,lessons(title))",
    );
    expect(objectiveMasterySource).not.toContain(
      "lesson_objectives(description,position),lessons(title)",
    );
  });

  it("lifts the nested lesson title back into the existing workspace shape", async () => {
    const fake = fakeClient({
      objective_mastery: ok([
        {
          ...masteryRow,
          lesson_objectives: {
            description: "Explain the objective",
            position: 2,
            lessons: { title: "Lesson A" },
          },
        },
      ]),
      objective_mastery_history: ok([]),
    });
    mocks.client.mockResolvedValue(fake.client);
    const workspace = await getObjectiveMasteryWorkspace();

    expect(await expectResolvableEmbeds(fake.calls)).toEqual([
      "objective_mastery->lesson_objectives",
      "lesson_objectives->lessons",
    ]);
    expect(workspace).toEqual({
      mastery: [
        {
          ...masteryRow,
          lesson_objectives: {
            description: "Explain the objective",
            position: 2,
          },
          lessons: { title: "Lesson A" },
        },
      ],
      history: [],
    });
  });
});

describe("getAssessmentWorkspace", () => {
  const versionA = randomUUID();
  const versionB = randomUUID();
  const assessmentRow = (programme_version_id: string, title: string) => ({
    id: randomUUID(),
    cohort_id: randomUUID(),
    programme_version_id,
    lesson_id: randomUUID(),
    instructor_id: randomUUID(),
    title,
    instructions: "Demo instructions",
    opens_at: "2026-09-30T10:00:00Z",
    closes_at: "2026-09-30T12:00:00Z",
    duration_minutes: 30,
    attempts_allowed: 1,
    status: "DRAFT",
    created_at: "2026-09-29T10:00:00Z",
    cohorts: { title: "Demo cohort" },
    lessons: { title: "Lesson A" },
  });
  const assessmentRows = [
    assessmentRow(versionA, "Quiz 1"),
    assessmentRow(versionB, "Quiz 2"),
    assessmentRow(versionA, "Quiz 3"),
  ];
  const versionRows = [
    { id: versionA, label: "v1", title_snapshot: "Demo A" },
    { id: versionB, label: "v2", title_snapshot: null },
  ];
  const question = {
    id: randomUUID(),
    position: 1,
    prompt: "Demo prompt",
    max_marks: 2,
  };
  const workspaceClient = (versions: Result) =>
    fakeClient(
      {
        assessments: ok(assessmentRows),
        assessment_attempts: ok([]),
        cohorts: ok([]),
        lessons: ok([]),
        programme_versions: versions,
      },
      {
        list_assignable_instructors: ok([]),
        list_assessment_authoring_questions: ok([question]),
      },
    );

  it("no longer embeds programme_versions from assessments in source", () => {
    expect(assessmentsSource).toContain("cohorts(title),lessons(title)");
    expect(assessmentsSource).not.toContain("programme_versions(");
    expect(assessmentsSource).toContain('.from("programme_versions")');
    expect(assessmentsSource).toContain('.in("id", versionIds)');
  });

  it("reads the visible versions separately and preserves the workspace shape", async () => {
    const fake = workspaceClient(ok(versionRows));
    mocks.client.mockResolvedValue(fake.client);
    const workspace = await getAssessmentWorkspace();

    const versionRead = fake.calls.find(
      (c) => c.table === "programme_versions",
    );
    expect(versionRead?.select).toBe("id,label,title_snapshot");
    expect(versionRead?.filters).toEqual([["id", [versionA, versionB]]]);
    expect(await expectResolvableEmbeds(fake.calls)).toEqual([
      "assessments->cohorts",
      "assessments->lessons",
    ]);

    expect(workspace.assessments).toEqual([
      {
        ...assessmentRows[0],
        programme_versions: { label: "v1", title_snapshot: "Demo A" },
      },
      {
        ...assessmentRows[1],
        programme_versions: { label: "v2", title_snapshot: null },
      },
      {
        ...assessmentRows[2],
        programme_versions: { label: "v1", title_snapshot: "Demo A" },
      },
    ]);
    expect(workspace.questionsByAssessment).toEqual(
      Object.fromEntries(assessmentRows.map((row) => [row.id, [question]])),
    );
  });

  it("fails closed when the version read fails or a version is missing", async () => {
    for (const versions of [failed, ok(versionRows.slice(0, 1))]) {
      mocks.client.mockResolvedValue(workspaceClient(versions).client);
      await expect(getAssessmentWorkspace()).rejects.toThrow(
        "Assessment workspace could not be loaded.",
      );
    }
  });
});

describe("class_sessions control relationship", () => {
  it("still embeds programme_versions directly from class_sessions, through its real FK", () => {
    expect(classSessionsSource).toContain(
      "cohorts(title),lessons(title),staff_profiles!class_sessions_instructor_id_fkey(title,app_users(display_name)),programme_versions(label,title_snapshot)",
    );
  });
});
