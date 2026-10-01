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
// not resolve embeds that way, so the admin and learner assignment reads are
// checked against their source and against the REAL migrated FK graph.

const mocks = vi.hoisted(() => ({ client: vi.fn(), scope: vi.fn() }));
vi.mock("@/server/supabase", () => ({ createSupabase: mocks.client }));
vi.mock("@/server/identity", () => ({
  requireActor: vi.fn(),
  requireAnyRole: vi.fn(),
}));
vi.mock("@/server/course-activation", () => ({
  getMyCourseworkScope: mocks.scope,
}));

import {
  getAssignmentWorkspace,
  getStudentAssignments,
} from "@/server/assignments";

function functionSource(source: string, name: string) {
  const start = source.indexOf(`export async function ${name}`);
  if (start < 0) throw new Error(`Missing function ${name}`);
  const next = source.indexOf("\nexport async function ", start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}

const assignmentsFile = readFileSync("src/server/assignments.ts", "utf8");
const workspaceSource = functionSource(
  assignmentsFile,
  "getAssignmentWorkspace",
);
const studentSource = functionSource(assignmentsFile, "getStudentAssignments");

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
        eq(column: string, value: unknown) {
          call.filters.push([column, value]);
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
beforeEach(() => {
  mocks.client.mockReset();
  mocks.scope.mockReset();
});

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

const versionA = randomUUID();
const versionB = randomUUID();
const versionRows = [
  { id: versionA, label: "v1", title_snapshot: "Demo A" },
  { id: versionB, label: "v2", title_snapshot: null },
];

describe("migrated FK graph behind the assignment projections", () => {
  it("has no direct programme_versions FK from assignments, nor from lessons", async () => {
    expect(await foreignKeyCount("assignments", "programme_versions")).toBe(0);
    expect(await foreignKeyCount("lessons", "programme_versions")).toBe(0);
  });

  it("has no junction table PostgREST could resolve assignments -> programme_versions through", async () => {
    const result = await db.query<{ v: number }>(
      `select count(distinct a.conrelid)::int as v
         from pg_constraint a
         join pg_constraint p on p.conrelid=a.conrelid and p.contype='f'
        where a.contype='f'
          and a.confrelid='public.assignments'::regclass
          and p.confrelid='public.programme_versions'::regclass`,
    );
    expect(result.rows[0].v).toBe(0);
  });

  it("keeps the valid relationships the assignment reads still embed through", async () => {
    for (const [from, to] of [
      ["assignments", "cohorts"],
      ["assignments", "lessons"],
      ["cohorts", "programme_versions"],
    ])
      expect(
        await foreignKeyCount(from, to),
        `${from} -> ${to}`,
      ).toBeGreaterThan(0);
  });
});

describe("getAssignmentWorkspace", () => {
  const assignmentRow = (programme_version_id: string, title: string) => ({
    id: randomUUID(),
    cohort_id: randomUUID(),
    programme_version_id,
    lesson_id: randomUUID(),
    instructor_id: randomUUID(),
    title,
    instructions: "Demo instructions",
    opens_at: "2026-09-30T10:00:00Z",
    due_at: "2026-10-07T10:00:00Z",
    status: "PUBLISHED",
    created_at: "2026-09-29T10:00:00Z",
    published_at: "2026-09-29T11:00:00Z",
    closed_at: null,
    cohorts: { title: "Demo cohort" },
    lessons: { title: "Lesson A" },
  });
  const assignmentRows = [
    assignmentRow(versionA, "Assignment 1"),
    assignmentRow(versionB, "Assignment 2"),
    assignmentRow(versionA, "Assignment 3"),
  ];
  const workspaceClient = (versions: Result, rows = assignmentRows) =>
    fakeClient(
      {
        assignments: ok(rows),
        assignment_submissions: ok([]),
        cohorts: ok([]),
        lessons: ok([]),
        programme_versions: versions,
      },
      { list_assignable_instructors: ok([]) },
    );

  it("no longer embeds programme_versions from assignments in source", () => {
    expect(workspaceSource).toContain(
      "id,cohort_id,programme_version_id,lesson_id,instructor_id,title,instructions,opens_at,due_at,status,created_at,published_at,closed_at,cohorts(title),lessons(title)",
    );
    expect(workspaceSource).not.toContain("programme_versions(");
    expect(assignmentsFile).toContain('.from("programme_versions")');
    expect(assignmentsFile).toContain('.in("id", versionIds)');
  });

  it("reads the visible versions separately and preserves the workspace shape", async () => {
    const fake = workspaceClient(ok(versionRows));
    mocks.client.mockResolvedValue(fake.client);
    const workspace = await getAssignmentWorkspace();

    const versionReads = fake.calls.filter(
      (c) => c.table === "programme_versions",
    );
    expect(versionReads).toEqual([
      {
        table: "programme_versions",
        select: "id,label,title_snapshot",
        filters: [["id", [versionA, versionB]]],
      },
    ]);
    expect(await expectResolvableEmbeds(fake.calls)).toEqual([
      "assignments->cohorts",
      "assignments->lessons",
    ]);

    expect(workspace.assignments).toEqual([
      {
        ...assignmentRows[0],
        programme_versions: { label: "v1", title_snapshot: "Demo A" },
      },
      {
        ...assignmentRows[1],
        programme_versions: { label: "v2", title_snapshot: null },
      },
      {
        ...assignmentRows[2],
        programme_versions: { label: "v1", title_snapshot: "Demo A" },
      },
    ]);
    expect(workspace.assignments[0].programme_version_id).toBe(versionA);
  });

  it("skips the version read when no assignment is visible", async () => {
    const fake = workspaceClient(failed, []);
    mocks.client.mockResolvedValue(fake.client);
    expect((await getAssignmentWorkspace()).assignments).toEqual([]);
    expect(fake.calls.some((c) => c.table === "programme_versions")).toBe(
      false,
    );
  });

  it("fails closed when the version read fails or a version is missing", async () => {
    for (const versions of [failed, ok(versionRows.slice(0, 1))]) {
      mocks.client.mockResolvedValue(workspaceClient(versions).client);
      await expect(getAssignmentWorkspace()).rejects.toThrow(
        "Assignment workspace could not be loaded.",
      );
    }
  });
});

describe("getStudentAssignments", () => {
  const actorId = randomUUID();
  const cohortId = randomUUID();
  const assignmentRow = (programme_version_id: string, title: string) => ({
    id: randomUUID(),
    title,
    instructions: "Demo instructions",
    opens_at: "2026-09-30T10:00:00Z",
    due_at: "2026-10-07T10:00:00Z",
    status: "PUBLISHED",
    programme_version_id,
    lessons: { title: "Lesson A" },
  });
  const assignmentRows = [
    assignmentRow(versionA, "Assignment 1"),
    assignmentRow(versionB, "Assignment 2"),
  ];
  const submissionRow = {
    id: randomUUID(),
    assignment_id: assignmentRows[0].id,
    attempt_number: 1,
    submitted_at: "2026-10-01T10:00:00Z",
  };
  const studentClient = (versions: Result) =>
    fakeClient({
      assignments: ok(assignmentRows),
      assignment_submissions: ok([submissionRow]),
      programme_versions: versions,
    });

  beforeEach(() =>
    mocks.scope.mockResolvedValue({ actorId, cohortIds: [cohortId] }),
  );

  it("no longer embeds programme_versions from assignments in source", () => {
    expect(studentSource).toContain(
      "id,title,instructions,opens_at,due_at,status,programme_version_id,lessons(title)",
    );
    expect(studentSource).not.toContain("programme_versions(");
  });

  it("reads the visible versions separately and preserves the learner shape", async () => {
    const fake = studentClient(ok(versionRows));
    mocks.client.mockResolvedValue(fake.client);
    const result = await getStudentAssignments();

    expect(fake.calls.find((c) => c.table === "assignments")?.filters).toEqual([
      ["cohort_id", [cohortId]],
      ["status", ["PUBLISHED", "CLOSED"]],
    ]);
    expect(fake.calls.filter((c) => c.table === "programme_versions")).toEqual([
      {
        table: "programme_versions",
        select: "id,label,title_snapshot",
        filters: [["id", [versionA, versionB]]],
      },
    ]);
    expect(await expectResolvableEmbeds(fake.calls)).toEqual([
      "assignments->lessons",
    ]);

    // The existing learner-facing shape, exactly: no programme_version_id.
    const learnerView = (
      row: (typeof assignmentRows)[number],
      programme_versions: { label: string; title_snapshot: string | null },
    ) => ({
      id: row.id,
      title: row.title,
      instructions: row.instructions,
      opens_at: row.opens_at,
      due_at: row.due_at,
      status: row.status,
      lessons: row.lessons,
      programme_versions,
    });
    expect(result).toEqual({
      assignments: [
        learnerView(assignmentRows[0], {
          label: "v1",
          title_snapshot: "Demo A",
        }),
        learnerView(assignmentRows[1], { label: "v2", title_snapshot: null }),
      ],
      submissions: [submissionRow],
    });
    for (const assignment of result.assignments)
      expect(assignment).not.toHaveProperty("programme_version_id");
  });

  it("fails closed when the version read fails or a version is missing", async () => {
    for (const versions of [failed, ok(versionRows.slice(0, 1))]) {
      mocks.client.mockResolvedValue(studentClient(versions).client);
      await expect(getStudentAssignments()).rejects.toThrow(
        "Your assignments could not be loaded.",
      );
    }
  });

  it("returns empty coursework for zero cohorts without any assignment or version read", async () => {
    mocks.scope.mockResolvedValue({ actorId, cohortIds: [] });
    const fake = studentClient(ok(versionRows));
    mocks.client.mockResolvedValue(fake.client);
    expect(await getStudentAssignments()).toEqual({
      assignments: [],
      submissions: [],
    });
    expect(mocks.client).not.toHaveBeenCalled();
    expect(fake.calls).toEqual([]);
  });
});
