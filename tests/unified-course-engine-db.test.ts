import { readFileSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "./db-helper";
import {
  approvedTestPackage,
  academyPackage,
  as,
  people,
  publishAcademyCourse,
  rpc,
  seedPeople,
  type Query,
} from "./academy-fixture";
import { validateAcademyCoursePackage } from "@/domain/academy-course-package";
import { academyCatalogueSchema } from "@/domain/academy-delivery";

let db: PGlite;
let q: Query;
let legacy: Awaited<ReturnType<typeof publishAcademyCourse>>;
let packageId: string;
let publication: { courseId: string; offerId: string; replayed: boolean };
const reason = "Synthetic unified publication acceptance test";
const { admin, learnerA, instructor, registrar } = people;

async function stage(pkg = approvedTestPackage("unified-synthetic-test")) {
  pkg.course.demoContent = true;
  pkg.curriculum.programme.title = "SYNTHETIC course engine acceptance";
  const checked = validateAcademyCoursePackage(pkg);
  if (!checked.valid) throw new Error(JSON.stringify(checked.errors));
  const id = await rpc<string>(q, admin, "upload_unified_course_package", [
    JSON.stringify(pkg),
    reason,
  ]);
  await rpc(q, admin, "mark_academy_course_package_validated", [
    id,
    JSON.stringify(checked.review),
    reason,
  ]);
  return id;
}
const publish = (
  id: string,
  slug = "unified-synthetic-test",
  price = 12345,
  currency = "GBP",
  summary: string | null = "Synthetic acceptance content",
) =>
  rpc<typeof publication>(q, admin, "publish_unified_course", [
    id,
    slug,
    currency,
    price,
    summary,
    reason,
  ]);

beforeAll(async () => {
  db = await testDatabase({
    supabaseDefaultPrivileges: true,
    throughMigration: 72,
  });
  q = (sql, params) => db.query(sql, params) as ReturnType<Query>;
  await seedPeople(q);
  legacy = await publishAcademyCourse(
    q,
    "legacy-excluded-test",
    approvedTestPackage("legacy-excluded-test"),
  );
  await rpc(q, admin, "enable_academy_public_sale", [
    legacy.offerId,
    true,
    reason,
  ]);
  await db.exec(
    readFileSync(
      "supabase/migrations/202611030073_unified_legacy_retirement.sql",
      "utf8",
    ),
  );
}, 180000);
afterAll(async () => {
  await db?.close();
});

describe("unified publication authority on real migrations", () => {
  it("starts empty even when a legacy public course exists", async () => {
    expect(await rpc(q, null, "list_unified_course_catalogue")).toEqual([]);
    expect(
      (await rpc<unknown[]>(q, null, "list_academy_catalogue")).length,
    ).toBe(0);
  });

  it("keeps historical packages outside the new administration register", async () => {
    expect(await rpc(q, admin, "list_unified_course_packages")).toEqual([]);
    await expect(
      rpc(q, admin, "upload_unified_course_package", [
        JSON.stringify(legacy.pkg),
        reason,
      ]),
    ).rejects.toThrow("REVISION_CONFLICT");
    await expect(
      publish(legacy.packageId, "legacy-excluded-test"),
    ).rejects.toThrow("INVALID_STATE");
  });

  it("rejects unauthorised callers before reading a package", async () => {
    for (const person of [learnerA, instructor, registrar])
      await expect(
        rpc(q, person, "publish_unified_course", [
          legacy.packageId,
          "forged-course",
          "GBP",
          10,
          null,
          reason,
        ]),
      ).rejects.toThrow("FORBIDDEN");
    await expect(
      rpc(q, null, "publish_unified_course", [
        legacy.packageId,
        "forged-course",
        "GBP",
        10,
        null,
        reason,
      ]),
    ).rejects.toThrow(/permission denied/);
  });

  it("publishes from a validated upload in one call, without a cohort, activation or staff allocation", async () => {
    const before = await q(
      "select (select count(*) from public.cohorts)::int as cohorts, (select count(*) from public.course_activations)::int as activations",
    );
    packageId = await stage();
    publication = await publish(packageId);
    expect(publication.replayed).toBe(false);
    expect(
      await q(
        "select (select count(*) from public.cohorts)::int as cohorts, (select count(*) from public.course_activations)::int as activations",
      ),
    ).toEqual(before);
    const catalogue = academyCatalogueSchema.parse(
      await rpc(q, null, "list_unified_course_catalogue"),
    );
    expect(catalogue).toHaveLength(1);
    expect(catalogue[0]).toMatchObject({
      offerId: publication.offerId,
      demoContent: true,
      currency: "GBP",
    });
    expect(catalogue[0].formats).toHaveLength(5);
    expect(new Set(catalogue[0].formats.map((f) => f.amountMinor))).toEqual(
      new Set([12345]),
    );
    const rows = await q(
      "select i.status, v.status as version_status from public.academy_courses c join public.course_package_imports i on i.id=c.curriculum_import_id join public.programme_versions v on v.id=c.programme_version_id where c.id=$1",
      [publication.courseId],
    );
    expect(rows.rows[0]).toMatchObject({
      status: "PUBLISHED",
      version_status: "PUBLISHED",
    });
  });

  it("replays exactly once and refuses changed publication terms", async () => {
    expect(await publish(packageId)).toEqual({
      ...publication,
      replayed: true,
    });
    for (const args of [
      [
        packageId,
        "unified-synthetic-test",
        "GBP",
        12346,
        "Synthetic acceptance content",
        reason,
      ],
      [
        packageId,
        "unified-synthetic-test",
        "USD",
        12345,
        "Synthetic acceptance content",
        reason,
      ],
      [
        packageId,
        "different-slug",
        "GBP",
        12345,
        "Synthetic acceptance content",
        reason,
      ],
      [
        packageId,
        "unified-synthetic-test",
        "GBP",
        12345,
        "Changed summary",
        reason,
      ],
    ])
      await expect(
        rpc(q, admin, "publish_unified_course", args),
      ).rejects.toThrow("PUBLICATION_CONFLICT");
    expect(
      (
        await q(
          "select count(*)::int n from public.audit_events where action='UNIFIED_COURSE_PUBLISHED' and target_id=$1",
          [publication.courseId],
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it("refuses invalid prices and unsupported currencies without materialising curriculum", async () => {
    const id = await stage(approvedTestPackage("invalid-price-test"));
    for (const price of [0, -1, 100000001])
      await expect(publish(id, "invalid-price-test", price)).rejects.toThrow(
        "INVALID_PRICE",
      );
    await expect(publish(id, "invalid-price-test", 100, "JPY")).rejects.toThrow(
      "INVALID_PRICE",
    );
    expect(
      (
        await q(
          "select count(*)::int n from public.course_package_imports where package_key='invalid-price-test'",
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it("keeps unresolved academic decisions out of the catalogue", async () => {
    const pkg = academyPackage();
    pkg.packageKey = pkg.curriculum.packageKey = "unresolved-policy-test";
    const id = await stage(pkg);
    await expect(publish(id, "unresolved-policy-test")).rejects.toThrow(
      "POLICY_PENDING",
    );
    expect(
      (
        await q(
          "select count(*)::int n from public.course_package_imports where package_key='unresolved-policy-test'",
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it("rolls back materialisation and curriculum publication on a late slug conflict", async () => {
    const id = await stage(approvedTestPackage("late-conflict-test"));
    await expect(publish(id)).rejects.toThrow("SLUG_CONFLICT");
    expect(
      (
        await q(
          "select count(*)::int n from public.course_package_imports where package_key='late-conflict-test'",
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await q(
          "select status from public.academy_course_packages where id=$1",
          [id],
        )
      ).rows[0].status,
    ).toBe("VALIDATED");
  });

  it("does not leak answer keys or protected package bodies", async () => {
    const text = JSON.stringify(
      await rpc(q, learnerA, "list_unified_course_catalogue"),
    );
    for (const key of [
      "answerKey",
      "markingGuidance",
      "raw_package",
      "correctAnswer",
      "modelProfileRef",
    ])
      expect(text).not.toContain(key);
    await expect(
      as(q, learnerA, "select * from public.course_engine_publications"),
    ).rejects.toThrow(/permission denied/);
  });

  it("closes effective table, column and service-role function privileges under Supabase defaults", async () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      const r = (
        await q(
          "select has_table_privilege($1,'public.course_engine_publications','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') t, has_any_column_privilege($1,'public.course_engine_publications','SELECT,INSERT,UPDATE,REFERENCES') c, has_function_privilege($1,'public.publish_unified_course(uuid,text,text,integer,text,text)','EXECUTE') f",
          [role],
        )
      ).rows[0];
      expect(r).toEqual({ t: false, c: false, f: role === "authenticated" });
    }
    expect(
      (
        await q(
          "select relrowsecurity from pg_class where oid='public.course_engine_publications'::regclass",
        )
      ).rows[0].relrowsecurity,
    ).toBe(true);
    await expect(
      q("update public.course_engine_publications set amount_minor=1"),
    ).rejects.toThrow("IMMUTABLE_HISTORY");
    await expect(
      q("delete from public.course_engine_publications"),
    ).rejects.toThrow("IMMUTABLE_HISTORY");
  });
});
