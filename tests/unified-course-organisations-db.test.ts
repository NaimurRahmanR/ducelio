import { localPostgresDatabase } from "./local-postgres-database";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { testDatabase } from "./db-helper";
import {
  approvedTestPackage,
  people,
  rpc,
  seedPeople,
  type Query,
} from "./academy-fixture";
import { validateAcademyCoursePackage } from "@/domain/academy-course-package";
import { randomUUID } from "node:crypto";

let db: PGlite | Awaited<ReturnType<typeof localPostgresDatabase>>,
  q: Query,
  orgA: string,
  orgB: string;
let packageA: string, packageB: string, couponA: string, courseA: string;
const reason = "TEST ONLY organisation isolation acceptance";
const {
  admin,
  learnerA: ownerA,
  learnerB: ownerB,
  learnerC: manager,
  instructor: reviewer,
  registrar: outsider,
} = people;
beforeAll(async () => {
  db = process.env.DUCELIO_TEST_POSTGRES_URL
    ? await localPostgresDatabase()
    : await testDatabase({ supabaseDefaultPrivileges: true });
  q = (sql, args) => db.query(sql, args) as ReturnType<Query>;
  await seedPeople(q);
  await db.exec(
    `insert into public.role_grants(user_id,role) values('${admin.id}','PLATFORM_ADMIN')`,
  );
  orgA = await rpc(q, admin, "create_course_organisation", [
    "tenant-one",
    "Synthetic Tenant One",
    ownerA.id,
    reason,
  ]);
  orgB = await rpc(q, admin, "create_course_organisation", [
    "tenant-two",
    "Synthetic Tenant Two",
    ownerB.id,
    reason,
  ]);
}, 180000);
afterAll(async () => {
  await db?.close();
});

async function stage(
  org: string,
  actor: { id: string; auth: string; email: string; role: string },
) {
  const raw = approvedTestPackage("same-source-key");
  raw.course.demoContent = true;
  const id = await rpc<string>(q, actor, "upload_organisation_course_package", [
    org,
    JSON.stringify(raw),
    reason,
  ]);
  const stored = await rpc(q, actor, "get_academy_course_package_content", [
    id,
  ]);
  const checked = validateAcademyCoursePackage(stored);
  if (!checked.valid) throw new Error(JSON.stringify(checked.errors));
  await rpc(q, actor, "mark_academy_course_package_validated", [
    id,
    JSON.stringify(checked.review),
    reason,
  ]);
  return id;
}
it("has row-enforced organisation visibility, no global role escalation and no client writes", async () => {
  const list = await rpc<{ id: string }[]>(
    q,
    ownerA,
    "list_my_course_organisations",
  );
  expect(list.map((r) => r.id)).toEqual([orgA]);
  await q("select set_config('request.jwt.claim.sub',$1,false)", [ownerA.auth]);
  await q("set role authenticated");
  try {
    expect(
      (await q("select id from public.course_engine_organisations")).rows.map(
        (r) => r.id,
      ),
    ).toEqual([orgA]);
    expect(
      (
        await q("select organisation_id from public.course_engine_memberships")
      ).rows.map((r) => r.organisation_id),
    ).toEqual([orgA]);
    await expect(
      q("update public.course_engine_memberships set role='OWNER'"),
    ).rejects.toThrow();
    expect(
      (await q("select public.has_role('PLATFORM_ADMIN') allowed")).rows[0]
        .allowed,
    ).toBe(false);
  } finally {
    await q("reset role");
  }
  await expect(
    rpc(q, ownerA, "create_course_organisation", [
      "evil-org",
      "Unapproved Org",
      ownerA.id,
      reason,
    ]),
  ).rejects.toThrow();
  await expect(
    rpc(q, ownerA, "set_course_organisation_member", [
      orgB,
      ownerA.id,
      "OWNER",
      true,
      reason,
    ]),
  ).rejects.toThrow();
  await expect(
    rpc(q, ownerA, "set_course_organisation_member", [
      orgA,
      ownerA.id,
      "OWNER",
      false,
      reason,
    ]),
  ).rejects.toThrow("LAST_OWNER");
});
it("uploads identical source keys independently and denies foreign draft read and modification", async () => {
  packageA = await stage(orgA, ownerA);
  packageB = await stage(orgB, ownerB);
  expect(packageA).not.toBe(packageB);
  for (const [actor, id] of [
    [ownerB, packageA],
    [ownerA, packageB],
    [outsider, packageA],
  ] as const) {
    await expect(
      rpc(q, actor, "get_academy_course_package_content", [id]),
    ).rejects.toThrow();
    await expect(
      rpc(q, actor, "reject_academy_course_package", [id, reason]),
    ).rejects.toThrow();
    await expect(
      rpc(q, actor, "publish_unified_course", [
        id,
        "tenant-stolen",
        "GBP",
        10000,
        null,
        reason,
      ]),
    ).rejects.toThrow();
  }
  expect(
    (
      await rpc<{ id: string }[]>(q, ownerA, "list_unified_course_packages")
    ).map((r) => r.id),
  ).toEqual([packageA]);
});
it("publishes through the same materialisation/agent/test authorities without cohorts", async () => {
  const a = await rpc<{ courseId: string }>(
    q,
    ownerA,
    "publish_unified_course",
    [packageA, "tenant-one-course", "GBP", 10000, null, reason],
  );
  const b = await rpc<{ courseId: string }>(
    q,
    ownerB,
    "publish_unified_course",
    [packageB, "tenant-two-course", "GBP", 10000, null, reason],
  );
  courseA = a.courseId;
  expect(a.courseId).not.toBe(b.courseId);
  const imports = await q(
    "select i.id,i.programme_id,i.programme_version_id,u.organisation_id from public.course_package_imports i join public.academy_course_packages p on p.package_key=i.package_key and p.package_revision=i.package_revision join public.course_engine_packages u on u.package_id=p.id",
  );
  expect(new Set(imports.rows.map((r) => r.programme_id)).size).toBe(2);
  for (const row of imports.rows.filter((r) => r.organisation_id === orgA)) {
    for (const name of [
      "get_course_package_content",
      "get_course_package_preview",
      "get_course_package_test_status",
      "publish_course_package",
    ])
      await expect(
        rpc(
          q,
          ownerB,
          name,
          name === "publish_course_package" ? [row.id, reason] : [row.id],
        ),
      ).rejects.toThrow();
    await expect(
      rpc(q, ownerB, "list_agent_configs", [row.programme_version_id]),
    ).rejects.toThrow();
  }
  expect(
    (
      await q(
        "select count(*)::int n from public.cohorts where programme_version_id in (select programme_version_id from public.course_package_imports)",
      )
    ).rows[0].n,
  ).toBe(0);
});
it("scopes coupon codes, management and reporting to the selling organisation", async () => {
  const expires = new Date(Date.now() + 86400000).toISOString();
  couponA = await rpc(q, ownerA, "create_organisation_course_coupon", [
    orgA,
    "SAME100",
    100,
    expires,
    5,
    null,
    reason,
  ]);
  const couponB = await rpc(q, ownerB, "create_organisation_course_coupon", [
    orgB,
    "SAME100",
    50,
    expires,
    5,
    null,
    reason,
  ]);
  expect(couponA).not.toBe(couponB);
  await expect(
    rpc(q, ownerB, "set_course_coupon_active", [couponA, false, reason]),
  ).rejects.toThrow();
  await expect(
    rpc(q, ownerB, "get_course_coupon_redemptions", [couponA]),
  ).rejects.toThrow();
  await expect(
    rpc(q, ownerB, "create_organisation_course_coupon", [
      orgB,
      "FOREIGN",
      100,
      expires,
      5,
      courseA,
      reason,
    ]),
  ).rejects.toThrow();
  const free = await rpc<{ ok: boolean; enrolmentId: string }>(
    q,
    manager,
    "create_unified_course_order",
    ["tenant-one-course", "SAME100"],
  );
  expect(free.ok).toBe(true);
  expect(free.enrolmentId).toBeTruthy();
  const paid = await rpc<{ ok: boolean; orderId: string }>(
    q,
    manager,
    "create_unified_course_order",
    ["tenant-two-course", "SAME100"],
  );
  expect(paid.ok).toBe(true);
  expect(paid.orderId).toBeTruthy();
  const reportA = await rpc<{ id: string }[]>(
    q,
    ownerA,
    "list_organisation_course_orders",
  );
  const reportB = await rpc<{ id: string }[]>(
    q,
    ownerB,
    "list_organisation_course_orders",
  );
  expect(reportA.some((o) => o.id === paid.orderId)).toBe(false);
  expect(reportB.some((o) => o.id === paid.orderId)).toBe(true);
  expect(
    (
      await rpc<unknown[]>(q, ownerA, "get_course_coupon_redemptions", [
        couponA,
      ])
    ).length,
  ).toBe(1);
});
it("enforces operation roles and revocation immediately, independent of JWT metadata", async () => {
  await rpc(q, ownerA, "set_course_organisation_member", [
    orgA,
    manager.id,
    "COURSE_MANAGER",
    true,
    reason,
  ]);
  await rpc(q, ownerA, "set_course_organisation_member", [
    orgA,
    reviewer.id,
    "ACADEMIC_REVIEWER",
    true,
    reason,
  ]);
  await expect(
    rpc(q, manager, "set_course_organisation_member", [
      orgA,
      outsider.id,
      "OWNER",
      true,
      reason,
    ]),
  ).rejects.toThrow();
  await expect(
    rpc(q, reviewer, "create_organisation_course_coupon", [
      orgA,
      "NOAUTH",
      100,
      new Date(Date.now() + 86400000).toISOString(),
      2,
      null,
      reason,
    ]),
  ).rejects.toThrow();
  await rpc(q, ownerA, "set_course_organisation_member", [
    orgA,
    manager.id,
    "COURSE_MANAGER",
    false,
    reason,
  ]);
  expect(await rpc(q, manager, "list_my_course_organisations")).toEqual([]);
  await expect(
    rpc(q, manager, "get_academy_course_package_review", [packageA]),
  ).rejects.toThrow();
  await q(
    "delete from public.role_grants where user_id=$1 and role='PLATFORM_ADMIN'",
    [admin.id],
  );
  // Institutional ACADEMIC_ADMIN is not a global external-tenant authority.
  await expect(
    rpc(q, admin, "get_academy_course_package_review", [packageA]),
  ).rejects.toThrow();
});

it("isolates learner submissions and recovery decisions with academic role separation", async () => {
  const enrol = (
    await q(
      "select id from public.academy_enrolments where course_id=$1 and learner_id=$2",
      [courseA, manager.id],
    )
  ).rows[0].id;
  const raw = approvedTestPackage();
  const lab = raw.labs.find((l: { graded: boolean }) => l.graded);
  const submission = (
    await q(
      "insert into public.academy_lab_submissions(enrolment_id,learner_id,lab_ref,body,request_key) values($1,$2,$3,'TEST ONLY synthetic submission',$4) returning id",
      [enrol, manager.id, lab.activityRef, randomUUID()],
    )
  ).rows[0].id;
  await expect(
    rpc(q, ownerB, "mark_academy_lab_submission", [
      submission,
      JSON.stringify({ "test-criterion": 7 }),
      reason,
    ]),
  ).rejects.toThrow("FORBIDDEN");
  await rpc(q, ownerA, "set_course_organisation_member", [
    orgA,
    manager.id,
    "COURSE_MANAGER",
    true,
    reason,
  ]);
  await expect(
    rpc(q, manager, "mark_academy_lab_submission", [
      submission,
      JSON.stringify({ "test-criterion": 7 }),
      reason,
    ]),
  ).rejects.toThrow("FORBIDDEN");
  const foreign = await rpc<{ submissionId: string }[]>(
    q,
    ownerB,
    "list_academy_lab_submissions_for_review",
  );
  expect(foreign.some((s) => s.submissionId === submission)).toBe(false);
  expect(
    await rpc(q, reviewer, "mark_academy_lab_submission", [
      submission,
      JSON.stringify({ "test-criterion": 7 }),
      reason,
    ]),
  ).toMatchObject({ ok: true, marks: 7 });
  await rpc(q, manager, "confirm_my_academy_schedule", [
    enrol,
    "STANDARD_6W",
    new Date(Date.now() + 86400000).toISOString().slice(0, 10),
    [1, 2, 3, 4, 5, 6],
    "09:00",
    "Europe/London",
    randomUUID(),
  ]);
  const item = (
    await q(
      "select id from public.academy_schedule_items where enrolment_id=$1 order by sequence limit 1",
      [enrol],
    )
  ).rows[0].id;
  const recovery = (
    await q(
      "insert into public.course_engine_recoveries(enrolment_id,root_item_id,request_key,opens_at,reason_code) values($1,$2,$3,clock_timestamp()+interval '2 days','MISSED_WINDOW') returning id",
      [enrol, item, randomUUID()],
    )
  ).rows[0].id;
  await expect(
    rpc(q, ownerB, "review_course_recovery", [recovery, false, reason]),
  ).rejects.toThrow("FORBIDDEN");
  await expect(
    rpc(q, manager, "review_course_recovery", [recovery, false, reason]),
  ).rejects.toThrow("FORBIDDEN");
  expect(
    await rpc(q, reviewer, "review_course_recovery", [recovery, false, reason]),
  ).toMatchObject({ ok: true, state: "DENIED" });
});
