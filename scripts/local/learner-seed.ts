// LOCAL ONLY seed for scripts/local/learner-stack.mjs. TEST ONLY synthetic
// accounts and two TEST ONLY copies of the repository's demo Security+
// preparation package, driven through the real RPCs exactly as the DB suites
// do. Time is moved only as the database owner (schedule items), never by a
// learner call. Nothing here is course content or production data.
import { randomUUID } from "node:crypto";
import {
  approvedTestPackage,
  people,
  responseBody,
  rpc,
  seedPeople,
  type Person,
  type Query,
} from "../../tests/academy-fixture";
import {
  closeSittingNow,
  sittingClosesIn,
} from "../../tests/academy-release-fixture";
import { validateAcademyCoursePackage } from "@/domain/academy-course-package";

const reason = "TEST ONLY local learner acceptance seed";
const { admin, learnerA, learnerB, learnerC } = people;
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];
const day = (offset: number) =>
  new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

type Pkg = ReturnType<typeof approvedTestPackage>;

export async function seedLocalLearner(q: Query) {
  await seedPeople(q);
  await q(
    "insert into public.role_grants(user_id,role) values($1,'PLATFORM_ADMIN')",
    [admin.id],
  );
  const names: [Person, string][] = [
    [learnerA, "Test Learner (local)"],
    [learnerB, "Test Learner B (local)"],
    [learnerC, "Test Learner C (local)"],
  ];
  for (const [p, name] of names)
    await q("update public.app_users set display_name=$2 where id=$1", [
      p.id,
      name,
    ]);

  const pkgs: Record<string, Pkg> = {};
  async function publish(key: string, title: string) {
    const pkg = approvedTestPackage(key);
    pkg.course.demoContent = true;
    pkg.curriculum.programme.title = title;
    const checked = validateAcademyCoursePackage(pkg);
    if (!checked.valid) throw new Error(JSON.stringify(checked.errors));
    const packageId = await rpc<string>(
      q,
      admin,
      "upload_unified_course_package",
      [JSON.stringify(pkg), reason],
    );
    const stored = await rpc(q, admin, "get_academy_course_package_content", [
      packageId,
    ]);
    const review = validateAcademyCoursePackage(stored);
    if (!review.valid) throw new Error(JSON.stringify(review.errors));
    await rpc(q, admin, "mark_academy_course_package_validated", [
      packageId,
      JSON.stringify(review.review),
      reason,
    ]);
    const published = await rpc<{ courseId: string }>(
      q,
      admin,
      "publish_unified_course",
      [packageId, key, "GBP", 10000, null, reason],
    );
    await rpc(q, admin, "create_course_coupon", [
      `${key.toUpperCase()}-FREE`,
      100,
      new Date(Date.now() + 30 * 86400000).toISOString(),
      50,
      published.courseId,
      reason,
    ]);
    pkgs[key] = pkg;
    return published.courseId;
  }
  async function join(person: Person, key: string) {
    const r = await rpc<{ ok: boolean; enrolmentId: string }>(
      q,
      person,
      "create_unified_course_order",
      [key, `${key.toUpperCase()}-FREE`],
    );
    if (!r.ok) throw new Error(JSON.stringify(r));
    return r.enrolmentId;
  }
  async function confirm(person: Person, enrolment: string, time: string) {
    const r = await rpc<{ ok: boolean }>(
      q,
      person,
      "confirm_my_academy_schedule",
      [
        enrolment,
        "ACCELERATED_2W",
        day(1),
        ALL_DAYS,
        time,
        "Europe/London",
        randomUUID(),
      ],
    );
    if (!r.ok) throw new Error(JSON.stringify(r));
  }
  async function firstRef(enrolment: string, kind: string) {
    return (
      await q(
        `select i.ref from public.academy_schedule_items i join public.academy_schedules s on s.id=i.schedule_id
          where s.enrolment_id=$1 and s.superseded_at is null and i.kind=$2 order by i.sequence limit 1`,
        [enrolment, kind],
      )
    ).rows[0].ref as string;
  }
  async function move(
    enrolment: string,
    kind: string,
    ref: string,
    offset: string,
  ) {
    await q(
      "alter table public.academy_schedule_items disable trigger guard_history",
    );
    try {
      await q(
        `update public.academy_schedule_items i
            set starts_at = now() + $4::interval + (i.part - 1) * interval '1 minute',
                ends_at = now() + $4::interval + (i.part - 1) * interval '1 minute' + make_interval(mins => i.minutes),
                opens_at = now() + $4::interval + (i.part - 1) * interval '1 minute',
                closes_at = now() + $4::interval + (i.part - 1) * interval '1 minute' + interval '1439 minutes'
          where i.enrolment_id = $1 and i.kind = $2 and i.ref = $3
            and i.schedule_id = (select id from public.academy_schedules where enrolment_id = $1 and superseded_at is null)`,
        [enrolment, kind, ref, offset],
      );
    } finally {
      await q(
        "alter table public.academy_schedule_items enable trigger guard_history",
      );
    }
  }
  async function sit(
    person: Person,
    enrolment: string,
    key: string,
    ref: string,
    correct: number,
  ) {
    const s = await rpc<{ ok: boolean; attemptId: string }>(
      q,
      person,
      "start_my_academy_assessment",
      [enrolment, ref],
    );
    if (!s.ok) throw new Error(JSON.stringify(s));
    const template = pkgs[key].curriculum.assessmentTemplates.find(
      (t: { key: string }) => t.key === ref,
    );
    for (const [i, question] of template.questions.entries()) {
      if (i >= correct) continue;
      await rpc(q, person, "record_my_academy_response", [
        s.attemptId,
        question.position,
        responseBody(question, true),
        `k-${randomUUID()}`,
      ]);
    }
    await rpc(q, person, "submit_my_academy_attempt", [s.attemptId]);
  }

  const A = "local-test-course-a";
  const B = "local-test-course-b";
  await publish(A, "TEST ONLY · Security+ Preparation (local copy A)");
  await publish(B, "TEST ONLY · Security+ Preparation (local copy B)");
  const enrolA = await join(learnerA, A);
  const enrolB = await join(learnerA, B);
  const peerB = await join(learnerB, A);
  const peerC = await join(learnerC, A);
  await confirm(learnerA, enrolA, "09:00");
  await confirm(learnerA, enrolB, "15:00");
  await confirm(learnerB, peerB, "09:00");
  await confirm(learnerC, peerC, "09:00");

  // quiz-1 sat and RELEASED for three learners (results, leaderboard).
  const quiz = await firstRef(enrolA, "ASSESSMENT");
  for (const [person, enrolment, correct] of [
    [learnerA, enrolA, 3],
    [learnerB, peerB, 5],
    [learnerC, peerC, 1],
  ] as const) {
    await sittingClosesIn(q, enrolment, quiz, "3 hours");
    await sit(person, enrolment, A, quiz, correct);
    await closeSittingNow(q, enrolment, quiz);
  }
  for (const [person, enrolment] of [
    [learnerA, enrolA],
    [learnerB, peerB],
    [learnerC, peerC],
  ] as const)
    await rpc(q, person, "refresh_my_academy_releases", [enrolment]);

  // Course A for the browser learner: the next assessment open now (Take /
  // resume, results still confidential), a class open now (Give attendance)
  // and a practical open now (Attend Practical Class, evidence upload).
  const quiz2 = (
    await q(
      `select i.ref from public.academy_schedule_items i join public.academy_schedules s on s.id=i.schedule_id
        where s.enrolment_id=$1 and s.superseded_at is null and i.kind='ASSESSMENT' and i.ref<>$2 order by i.sequence limit 1`,
      [enrolA, quiz],
    )
  ).rows[0].ref as string;
  await sittingClosesIn(q, enrolA, quiz2, "20 hours");
  const lesson = await firstRef(enrolA, "LESSON");
  await move(enrolA, "LESSON", lesson, "-30 minutes");
  const lab = await firstRef(enrolA, "LAB");
  await move(enrolA, "LAB", lab, "-5 hours");

  return {
    label: "TEST ONLY local seed",
    learner: learnerA.email,
    enrolments: { courseA: enrolA, courseB: enrolB },
    released: quiz,
    openAssessment: quiz2,
    openClass: lesson,
    openLab: lab,
  };
}
