import type { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { testDatabase } from "./db-helper";
import { localPostgresDatabase } from "./local-postgres-database";
import {
  approvedTestPackage,
  people,
  rpc,
  seedPeople,
  type Query,
} from "./academy-fixture";
import { validateAcademyCoursePackage } from "@/domain/academy-course-package";
let db: PGlite | Awaited<ReturnType<typeof localPostgresDatabase>>,
  q: Query,
  sourceId: string,
  nextId: string,
  finalId: string;
const source = approvedTestPackage("synthetic-human-review");
source.pendingDecisions = [
  {
    key: "SOURCE_REVIEW",
    summary: "TEST ONLY independent source review is required.",
  },
  {
    key: "LAB_RUBRICS",
    summary: "TEST ONLY approved laboratory rubrics are required.",
  },
];
const reason = "TEST ONLY human academic decision recording";
const key = randomUUID();
const corrected = () => {
  const raw = structuredClone(source);
  raw.packageRevision = 2;
  raw.curriculum.packageRevision = 2;
  raw.pendingDecisions = raw.pendingDecisions.filter(
    (d: { key: string }) => d.key !== "SOURCE_REVIEW",
  );
  return raw;
};
const evidence = [
  {
    key: "SOURCE_REVIEW",
    evidenceReference: "TEST ONLY synthetic review receipt 001",
    rationale:
      "TEST ONLY a human fixture review approved the synthetic source claims.",
  },
];
function review(raw: unknown) {
  const r = validateAcademyCoursePackage(raw);
  if (!r.valid) throw new Error(JSON.stringify(r.errors));
  return r.review;
}
beforeAll(async () => {
  db = process.env.DUCELIO_TEST_POSTGRES_URL
    ? await localPostgresDatabase()
    : await testDatabase({ supabaseDefaultPrivileges: true });
  q = (sql, args) => db.query(sql, args) as ReturnType<Query>;
  await seedPeople(q);
  sourceId = await rpc(q, people.admin, "upload_unified_course_package", [
    JSON.stringify(source),
    reason,
  ]);
  await rpc(q, people.admin, "mark_academy_course_package_validated", [
    sourceId,
    JSON.stringify(review(source)),
    reason,
  ]);
}, 180000);
afterAll(async () => {
  await db?.close();
});
const revise = (raw: unknown, resolutions: unknown, request = key) =>
  rpc<string>(q, people.admin, "revise_unified_course_package", [
    sourceId,
    JSON.stringify(raw),
    JSON.stringify(resolutions),
    JSON.stringify(review(raw)),
    request,
    reason,
  ]);
it("retains pending academic decisions and refuses direct upload removal without review", async () => {
  await expect(
    rpc(q, people.admin, "publish_unified_course", [
      sourceId,
      "synthetic-human-review",
      "GBP",
      1000,
      null,
      reason,
    ]),
  ).rejects.toThrow("POLICY_PENDING");
  await expect(
    rpc(q, people.admin, "upload_unified_course_package", [
      JSON.stringify(corrected()),
      reason,
    ]),
  ).rejects.toThrow("ACADEMIC_EVIDENCE_REQUIRED");
  expect(
    (
      await q(
        "select count(*)::int n from public.academy_course_packages where package_key=$1",
        [source.packageKey],
      )
    ).rows[0].n,
  ).toBe(1);
});
it("requires bounded human evidence for exactly the removed decisions", async () => {
  await expect(revise(corrected(), [])).rejects.toThrow(
    "ACADEMIC_EVIDENCE_REQUIRED",
  );
  await expect(
    revise(corrected(), [{ ...evidence[0], evidenceReference: "" }]),
  ).rejects.toThrow("ACADEMIC_EVIDENCE_REQUIRED");
  await expect(
    revise(corrected(), [{ ...evidence[0], key: "UNRELATED" }]),
  ).rejects.toThrow("ACADEMIC_EVIDENCE_REQUIRED");
  for (const who of [people.learnerA, people.instructor, people.registrar])
    await expect(
      rpc(q, who, "revise_unified_course_package", [
        sourceId,
        JSON.stringify(corrected()),
        JSON.stringify(evidence),
        JSON.stringify(review(corrected())),
        randomUUID(),
        reason,
      ]),
    ).rejects.toThrow();
});
it("records an immutable validated revision with partial resolution and safe replay", async () => {
  nextId = await revise(corrected(), evidence);
  expect(await revise(corrected(), evidence)).toBe(nextId);
  await expect(
    revise(corrected(), [
      {
        ...evidence[0],
        rationale: "TEST ONLY changed rationale must conflict on replay.",
      },
    ]),
  ).rejects.toThrow("REQUEST_CONFLICT");
  expect(
    await rpc(q, people.admin, "get_unified_academic_resolutions", [nextId]),
  ).toMatchObject([
    {
      key: "SOURCE_REVIEW",
      reviewedBy: people.admin.id,
      evidenceReference: evidence[0].evidenceReference,
    },
  ]);
  expect(
    await rpc(q, people.admin, "get_academy_course_package_content", [
      sourceId,
    ]),
  ).toEqual(source);
  await expect(
    rpc(q, people.admin, "publish_unified_course", [
      nextId,
      "synthetic-human-review",
      "GBP",
      1000,
      null,
      reason,
    ]),
  ).rejects.toThrow("POLICY_PENDING");
  await expect(
    q("delete from public.course_engine_academic_resolutions"),
  ).rejects.toThrow("IMMUTABLE_HISTORY");
  await expect(
    q(
      "update public.course_engine_academic_resolutions set rationale='rewrite history'",
    ),
  ).rejects.toThrow("IMMUTABLE_HISTORY");
  await expect(
    rpc(q, people.learnerA, "get_unified_academic_resolutions", [nextId]),
  ).rejects.toThrow();
});
it("will not resolve missing rubrics through an approval assertion alone", async () => {
  const raw = corrected();
  raw.packageRevision = 3;
  raw.curriculum.packageRevision = 3;
  raw.pendingDecisions = [];
  const graded = raw.labs.find((l: { graded: boolean }) => l.graded);
  graded.rubric = [];
  graded.markingGuidance = null;
  expect(validateAcademyCoursePackage(raw).valid).toBe(false);
  await expect(
    rpc(q, people.admin, "revise_unified_course_package", [
      nextId,
      JSON.stringify(raw),
      JSON.stringify([{ ...evidence[0], key: "LAB_RUBRICS" }]),
      JSON.stringify({ packageKey: raw.packageKey }),
      randomUUID(),
      reason,
    ]),
  ).rejects.toThrow();
});
it("publishes only after every pending decision is explicitly resolved and validation passes", async () => {
  const raw = corrected();
  raw.packageRevision = 3;
  raw.curriculum.packageRevision = 3;
  raw.pendingDecisions = [];
  finalId = await rpc(q, people.admin, "revise_unified_course_package", [
    nextId,
    JSON.stringify(raw),
    JSON.stringify([
      {
        key: "LAB_RUBRICS",
        evidenceReference: "TEST ONLY rubric approval receipt 002",
        rationale:
          "TEST ONLY all synthetic lab criteria and marking guidance were reviewed.",
      },
    ]),
    JSON.stringify(review(raw)),
    randomUUID(),
    reason,
  ]);
  expect(
    await rpc(q, people.admin, "publish_unified_course", [
      finalId,
      "synthetic-human-review",
      "GBP",
      1000,
      null,
      reason,
    ]),
  ).toMatchObject({ replayed: false });
  expect(
    (
      await q(
        "select count(*)::int n from public.course_engine_academic_resolutions",
      )
    ).rows[0].n,
  ).toBe(2);
  expect(
    (
      await q(
        "select raw_package->'pendingDecisions' pending from public.academy_course_packages where id=$1",
        [sourceId],
      )
    ).rows[0].pending,
  ).toHaveLength(2);
});
