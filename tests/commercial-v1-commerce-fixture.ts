import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { testDatabase } from "./db-helper";
import { buildPackage } from "./activation-fixture";
import { validateCoursePackage } from "@/domain/course-package";
import {
  administrator,
  learner,
  foreignLearner,
  learnerAuth,
  asPolicyUser,
} from "./commercial-v1-assessment-policy-fixture";

export { administrator, learner, foreignLearner, learnerAuth, asPolicyUser };

async function value<T = string>(
  db: PGlite,
  sql: string,
  args: unknown[] = [],
) {
  return (await db.query<{ v: T }>(sql, args)).rows[0].v;
}

// A fresh, isolated PGlite database with one real activated course --
// deliberately built directly from the raw import/apply/publish/activate
// primitives (never buildAssessmentPolicyFixture, which unconditionally
// enrols `learner` in its cohort -- Commercial V1 commerce tests need an
// UNENROLLED learner by default so purchase/entitlement/enrolment
// invariants can be exercised from a clean slate; tests that need an
// existing enrolment create one explicitly). Reuses the same seeded
// identity constants/helpers as commercial-v1-assessment-policy-fixture.ts
// (administrator/learner/foreignLearner/learnerAuth/asPolicyUser) so
// `administrator` inherits its seeded staff_profiles row for free.
export async function buildCommerceFixture(
  opts: { db?: PGlite; throughMigration?: number } = {},
) {
  const db =
    opts.db ??
    (await testDatabase({ throughMigration: opts.throughMigration ?? 34 }));
  if (!opts.db) {
    await db.exec("alter table auth.users disable trigger academy_identity");
    for (const [n, id] of [
      [1, learner],
      [2, administrator],
      [3, foreignLearner],
    ] as const) {
      await db.query(
        "insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())",
        [learnerAuth(n), `commerce${n}@test.example`],
      );
      await db.query(
        "update public.app_users set auth_user_id=$1,is_demo=false where id=$2",
        [learnerAuth(n), id],
      );
    }
    await db.exec("alter table auth.users enable trigger academy_identity");
    await db.query(
      "insert into public.role_grants values($1,'ACADEMIC_ADMIN'),($1,'INSTRUCTOR') on conflict do nothing",
      [administrator],
    );
  }

  const pkg = buildPackage();
  pkg.packageKey = `commercial-v1-commerce-${randomUUID()}`;
  await asPolicyUser(db, 2);
  const validated = validateCoursePackage(pkg);
  if (!validated.valid)
    throw new Error(
      `Invalid commerce fixture package: ${JSON.stringify(validated.errors)}`,
    );
  const importId = await value(
    db,
    "select public.import_course_package($1,1,$2,$3::jsonb,$4) as v",
    [
      pkg.packageKey,
      pkg.schemaVersion,
      JSON.stringify(pkg),
      "Commerce fixture import",
    ],
  );
  await db.query(
    "select public.mark_course_package_validated($1,$2::jsonb,$3)",
    [importId, JSON.stringify(validated.report), "Commerce fixture validated"],
  );
  const programmeVersionId = await value(
    db,
    "select public.apply_course_package($1,$2) as v",
    [importId, "Apply commerce fixture"],
  );
  await db.query("select public.publish_course_package($1,$2)", [
    importId,
    "Publish commerce fixture",
  ]);
  await db.exec("reset role");

  const cohortId = randomUUID();
  await db.query(
    "insert into public.cohorts(id,programme_version_id,title,starts_on) values($1,$2,'Commerce cohort',current_date+14)",
    [cohortId, programmeVersionId],
  );

  await asPolicyUser(db, 2);
  const now = new Date();
  const assessmentWindows = [
    {
      templateKey: "assess-1",
      opensAt: new Date(now.getTime() - 3600_000).toISOString(),
      closesAt: new Date(now.getTime() + 3600_000).toISOString(),
    },
  ];
  const activationId = await value(
    db,
    "select public.activate_course_package($1,$2,$3,$4::jsonb,$5::jsonb,$6) as v",
    [
      importId,
      cohortId,
      administrator,
      JSON.stringify([]),
      JSON.stringify(assessmentWindows),
      "Commerce fixture activation",
    ],
  );
  await db.exec("reset role");

  return { db, importId, programmeVersionId, cohortId, activationId };
}
export type CommerceFixture = Awaited<ReturnType<typeof buildCommerceFixture>>;
