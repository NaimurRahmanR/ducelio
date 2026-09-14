import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildAssessmentPolicyFixture,
  asPolicyUser,
  COMPONENTS,
  administrator,
  type AssessmentPolicyFixture,
} from "./commercial-v1-assessment-policy-fixture";

const databases: PGlite[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) await db.close();
});
async function fixture(
  options: Parameters<typeof buildAssessmentPolicyFixture>[0] = {
    withLabs: false,
  },
) {
  const f = await buildAssessmentPolicyFixture(options);
  if (!databases.includes(f.db)) databases.push(f.db);
  return f;
}
async function value<T = string>(
  db: PGlite,
  sql: string,
  args: unknown[] = [],
) {
  return (await db.query<{ v: T }>(sql, args)).rows[0].v;
}
async function start(f: AssessmentPolicyFixture, id = f.assessmentIds.QUIZ_1) {
  await asPolicyUser(f.db, 1);
  return value(f.db, "select public.start_assessment_attempt($1) as v", [id]);
}
async function snapshot(db: PGlite, id: string) {
  await db.exec("reset role");
  return value<Record<string, unknown>>(
    db,
    "select to_jsonb(t) as v from public.assessment_attempts t where id=$1",
    [id],
  );
}
async function expire(db: PGlite, id: string) {
  // Test-only elapsed-time simulation, matching the existing lifecycle suite.
  // Both institutional timestamps remain immutable to every runtime caller.
  await db.exec("reset role");
  await db.exec(
    "alter table public.assessment_attempts disable trigger guard_assessment_attempt_history",
  );
  try {
    await db.query(
      "update public.assessment_attempts set expires_at=started_at+interval '1 microsecond' where id=$1",
      [id],
    );
  } finally {
    await db.exec(
      "alter table public.assessment_attempts enable trigger guard_assessment_attempt_history",
    );
  }
}
async function closeAssessment(
  f: AssessmentPolicyFixture,
  id = f.assessmentIds.QUIZ_1,
) {
  await asPolicyUser(f.db, 2);
  await f.db.query(
    "select public.change_assessment_status($1,'CLOSED','Institutional closure fixture')",
    [id],
  );
}
async function question(
  f: AssessmentPolicyFixture,
  id = f.assessmentIds.QUIZ_1,
) {
  await f.db.exec("reset role");
  return value(
    f.db,
    "select id as v from public.assessment_questions where assessment_id=$1",
    [id],
  );
}
async function publish(f: AssessmentPolicyFixture) {
  await asPolicyUser(f.db, 2);
  return f.db.query(
    "select public.publish_commercial_v1_grading_policy($1,'Review publication fixture')",
    [f.activationId],
  );
}

describe("Assessment policy review: publication guards", () => {
  it.each(["ACTIVE", "SUBMITTED", "VOIDED"])(
    "rejects publication after %s attempt history without changing that history",
    async (state) => {
      const f = await fixture({ withLabs: false, publish: false });
      const id = await start(f);
      if (state === "SUBMITTED")
        await f.db.query("select public.submit_assessment_attempt($1)", [id]);
      if (state === "VOIDED") {
        await asPolicyUser(f.db, 2);
        await f.db.query(
          "select public.void_assessment_attempt($1,'Institutional void fixture')",
          [id],
        );
      }
      const before = await snapshot(f.db, id);
      await expect(publish(f)).rejects.toThrow(
        "ASSESSMENT_HISTORY_ALREADY_EXISTS",
      );
      expect(await snapshot(f.db, id)).toEqual(before);
      expect(
        await value<number>(
          f.db,
          "select count(*)::int as v from public.commercial_v1_grading_policies where activation_id=$1",
          [f.activationId],
        ),
      ).toBe(0);
    },
  );
  it.each([59, 60, 61])(
    "checks a %i-minute availability window against a 60-minute duration",
    async (minutes) => {
      const opensAt = new Date(Date.now() - 3600_000);
      const f = await fixture({
        withLabs: false,
        publish: false,
        windows: {
          QUIZ_1: {
            opensAt,
            closesAt: new Date(opensAt.getTime() + minutes * 60_000),
            durationMinutes: 60,
          },
        },
      });
      if (minutes < 60)
        await expect(publish(f)).rejects.toThrow("ASSESSMENT_WINDOW_TOO_SHORT");
      else await publish(f);
      await f.db.exec("reset role");
      expect(
        await value<number>(
          f.db,
          "select count(*)::int as v from public.commercial_v1_grading_policies",
        ),
      ).toBe(minutes < 60 ? 0 : 1);
    },
  );
  it("rejects an existing foreign activation assessment in the SAME database", async () => {
    const a = await fixture({ withLabs: false, publish: false });
    const b = await fixture({ withLabs: true, publish: false, db: a.db });
    expect(a.activationId).not.toBe(b.activationId);
    await a.db.exec("reset role");
    expect(
      await value<number>(
        a.db,
        "select count(*)::int as v from public.course_activations where id in ($1,$2)",
        [a.activationId, b.activationId],
      ),
    ).toBe(2);
    await asPolicyUser(a.db, 2);
    await expect(
      a.db.query(
        "select public.bind_commercial_v1_assessment_component($1,$2,$3,$4)",
        [
          a.activationId,
          "QUIZ_1",
          b.assessmentIds.QUIZ_1,
          "Foreign existing assessment",
        ],
      ),
    ).rejects.toThrow("NOT_FOUND_OR_FORBIDDEN");
  });
});

describe("Assessment policy review: scoped resume and finalization", () => {
  it.each([false, true])(
    "Commercial wrappers do not read or mutate an ungoverned attempt (expired=%s)",
    async (expired) => {
      const f = await fixture({ withLabs: false, publish: false });
      const id = await start(f);
      if (expired) await expire(f.db, id);
      const before = await snapshot(f.db, id);
      await asPolicyUser(f.db, 1);
      expect(
        await value(
          f.db,
          "select public.get_commercial_v1_active_attempt() as v",
        ),
      ).toBeNull();
      expect(await snapshot(f.db, id)).toEqual(before);
      await asPolicyUser(f.db, 1);
      await f.db.query(
        "select public.finalize_expired_commercial_v1_attempts()",
      );
      expect(await snapshot(f.db, id)).toEqual(before);
    },
  );
  it("returns the governed active attempt only to its owner", async () => {
    const f = await fixture();
    const id = await start(f);
    expect(
      await value(
        f.db,
        "select public.get_commercial_v1_active_attempt() as v",
      ),
    ).toMatchObject({ attemptId: id });
    await asPolicyUser(f.db, 3);
    expect(
      await value(
        f.db,
        "select public.get_commercial_v1_active_attempt() as v",
      ),
    ).toBeNull();
  });
});

describe("Assessment policy review: administrative closure", () => {
  it.each(["submit", "response", "finalizer"])(
    "%s truthfully terminalizes a closed governed assessment",
    async (path) => {
      const f = await fixture();
      const q = await question(f);
      const id = await start(f);
      await closeAssessment(f);
      await asPolicyUser(f.db, 1);
      if (path === "submit")
        await f.db.query("select public.submit_assessment_attempt($1)", [id]);
      if (path === "finalizer")
        await f.db.query(
          "select public.finalize_expired_commercial_v1_attempts()",
        );
      if (path === "response") {
        expect(
          await value(
            f.db,
            "select public.record_commercial_v1_assessment_response($1,$2,$3,$4) as v",
            [id, q, "Refused response", randomUUID()],
          ),
        ).toEqual({ ok: false, code: "RESPONSE_WINDOW_CLOSED" });
      }
      const terminal = await snapshot(f.db, id);
      expect(terminal).toMatchObject({
        state: "SUBMITTED",
        submission_provenance: "ADMIN_CLOSED",
      });
      expect(
        await value<number>(
          f.db,
          "select count(*)::int as v from public.assessment_responses where attempt_id=$1",
          [id],
        ),
      ).toBe(0);
      await asPolicyUser(f.db, 1);
      await f.db.query("select public.submit_assessment_attempt($1)", [id]);
      expect(await snapshot(f.db, id)).toEqual(terminal);
    },
  );
  it("legacy response writes refuse a closed assessment and submit records ADMIN_CLOSED", async () => {
    const f = await fixture({ withLabs: false, publish: false });
    const q = await question(f);
    const id = await start(f);
    await closeAssessment(f);
    await asPolicyUser(f.db, 1);
    await expect(
      f.db.query("select public.record_assessment_response($1,$2,$3,$4)", [
        id,
        q,
        "Refused response",
        randomUUID(),
      ]),
    ).rejects.toThrow("Assessment response window has closed");
    await f.db.query("select public.submit_assessment_attempt($1)", [id]);
    expect(await snapshot(f.db, id)).toMatchObject({
      state: "SUBMITTED",
      submission_provenance: "ADMIN_CLOSED",
    });
  });
  it("elapsed deadline remains AUTO_TIMEOUT when closure is also observed", async () => {
    const f = await fixture();
    const id = await start(f);
    await expire(f.db, id);
    await closeAssessment(f);
    await asPolicyUser(f.db, 1);
    await f.db.query("select public.submit_assessment_attempt($1)", [id]);
    const t = await snapshot(f.db, id);
    expect(t).toMatchObject({
      state: "SUBMITTED",
      submission_provenance: "AUTO_TIMEOUT",
    });
    expect(t.submitted_at).toBe(t.expires_at);
  });
});

describe("Real migration 028 to 029 upgrade with existing institutional history", () => {
  it("backfills only historical provenance, restores all guards, and governs new submissions", async () => {
    const window = {
      opensAt: new Date(Date.now() - 3600_000),
      closesAt: new Date(Date.now() + 6 * 3600_000),
      durationMinutes: 60,
    };
    const f = await fixture({
      withLabs: false,
      throughMigration: 28,
      publish: false,
      windows: Object.fromEntries(COMPONENTS.map((c) => [c, window])),
    });
    const db = f.db;
    expect(
      await value<number>(
        db,
        "select count(*)::int as v from information_schema.columns where table_name='assessment_attempts' and column_name='submission_provenance'",
      ),
    ).toBe(0);
    const submitted = await start(f);
    await db.query("select public.submit_assessment_attempt($1)", [submitted]);
    const closed = await start(f, f.assessmentIds.QUIZ_2);
    await closeAssessment(f, f.assessmentIds.QUIZ_2);
    // This successful migration-021 start durably runs its original generic
    // closed-attempt cleanup, rather than fabricating a submitted fixture row.
    const voided = await start(f, f.assessmentIds.MIDTERM);
    await asPolicyUser(db, 2);
    await db.query(
      "select public.void_assessment_attempt($1,'Historical void fixture')",
      [voided],
    );
    const active = await start(f, f.assessmentIds.QUIZ_3);
    const ids = [submitted, closed, voided, active];
    const before = await Promise.all(ids.map((id) => snapshot(db, id)));
    expect(before.map((t) => t.state)).toEqual([
      "SUBMITTED",
      "SUBMITTED",
      "VOIDED",
      "ACTIVE",
    ]);
    const triggers = (
      await db.query<{ tgname: string; tgenabled: string; definition: string }>(
        "select tgname,tgenabled,pg_get_triggerdef(oid) as definition from pg_trigger where tgrelid='public.assessment_attempts'::regclass and not tgisinternal order by tgname",
      )
    ).rows;
    expect(triggers.map((t) => t.tgname)).toEqual([
      "audit_change",
      "guard_assessment_attempt_history",
    ]);
    const guard = await value(
      db,
      "select pg_get_functiondef('public.guard_assessment_attempt_history()'::regprocedure) as v",
    );
    await db.exec(
      await readFile(
        "supabase/migrations/202609140029_commercial_v1_assessment_policy.sql",
        "utf8",
      ),
    );
    for (let i = 0; i < ids.length; i++) {
      const { submission_provenance, ...oldFields } = await snapshot(
        db,
        ids[i],
      );
      expect(oldFields).toEqual(before[i]); // every original identity/timing/state field, including null void fields
      expect(submission_provenance).toBe(i < 2 ? "LEGACY_UNCLASSIFIED" : null);
    }
    expect(
      (
        await db.query(
          "select tgname,tgenabled,pg_get_triggerdef(oid) as definition from pg_trigger where tgrelid='public.assessment_attempts'::regclass and not tgisinternal order by tgname",
        )
      ).rows,
    ).toEqual(triggers);
    expect(
      await value(
        db,
        "select pg_get_functiondef('public.guard_assessment_attempt_history()'::regprocedure) as v",
      ),
    ).toBe(guard);
    await expect(
      db.query(
        "update public.assessment_attempts set submission_provenance='STUDENT_SUBMIT' where id=$1",
        [submitted],
      ),
    ).rejects.toThrow("Closed assessment attempts are immutable");
    await expect(
      db.query("delete from public.assessment_attempts where id=$1", [
        submitted,
      ]),
    ).rejects.toThrow("immutable institutional history");
    await expect(
      db.query(
        "update public.assessment_attempts set expires_at=expires_at+interval '1 hour' where id=$1",
        [active],
      ),
    ).rejects.toThrow("identity and timing are immutable");
    // Constraint enforcement with otherwise valid ACTIVE -> terminal transitions.
    await expect(
      db.query(
        "update public.assessment_attempts set state='SUBMITTED',submitted_at=clock_timestamp() where id=$1",
        [active],
      ),
    ).rejects.toThrow("submission_provenance_truthful");
    await expect(
      db.query(
        "update public.assessment_attempts set state='SUBMITTED',submitted_at=clock_timestamp(),submission_provenance='FABRICATED' where id=$1",
        [active],
      ),
    ).rejects.toThrow("submission_provenance_values");
    await expect(
      db.query(
        "update public.assessment_attempts set state='VOIDED',voided_at=clock_timestamp(),voided_by=$2,void_reason='Invalid provenance fixture',submission_provenance='STUDENT_SUBMIT' where id=$1",
        [active, administrator],
      ),
    ).rejects.toThrow("submission_provenance_truthful");
    await asPolicyUser(db, 1);
    await db.query("select public.submit_assessment_attempt($1)", [active]);
    expect(await snapshot(db, active)).toMatchObject({
      state: "SUBMITTED",
      submission_provenance: "STUDENT_SUBMIT",
    });
    const timed = await start(f, f.assessmentIds.QUIZ_4);
    await expire(db, timed);
    await asPolicyUser(db, 1);
    await db.query("select public.submit_assessment_attempt($1)", [timed]);
    const timedRow = await snapshot(db, timed);
    expect(timedRow).toMatchObject({
      state: "SUBMITTED",
      submission_provenance: "AUTO_TIMEOUT",
    });
    expect(timedRow.submitted_at).toBe(timedRow.expires_at);
    const adminClosed = await start(f, f.assessmentIds.FINAL);
    await closeAssessment(f, f.assessmentIds.FINAL);
    await asPolicyUser(db, 1);
    await db.query("select public.submit_assessment_attempt($1)", [
      adminClosed,
    ]);
    expect(await snapshot(db, adminClosed)).toMatchObject({
      state: "SUBMITTED",
      submission_provenance: "ADMIN_CLOSED",
    });
  });
});

describe("Generic legacy cleanup remains separate from Commercial wrappers", () => {
  it.each(["CLOSED", "EXPIRED"])(
    "start preserves generic %s cleanup with truthful provenance",
    async (cause) => {
      const now = Date.now();
      const f = await fixture({
        withLabs: false,
        publish: false,
        windows: {
          QUIZ_2: {
            opensAt: new Date(now - 3600_000),
            closesAt: new Date(now + 3600_000),
            durationMinutes: 30,
          },
        },
      });
      const first = await start(f);
      if (cause === "CLOSED") await closeAssessment(f);
      else await expire(f.db, first);
      const second = await start(f, f.assessmentIds.QUIZ_2);
      expect(second).not.toBe(first);
      const old = await snapshot(f.db, first);
      expect(old).toMatchObject({
        state: "SUBMITTED",
        submission_provenance:
          cause === "CLOSED" ? "ADMIN_CLOSED" : "AUTO_TIMEOUT",
      });
      if (cause === "EXPIRED") expect(old.submitted_at).toBe(old.expires_at);
      expect(await snapshot(f.db, second)).toMatchObject({
        state: "ACTIVE",
        submission_provenance: null,
      });
    },
  );
  it("a published policy elsewhere does not make an unbound legacy attempt resumable or finalizable", async () => {
    const f = await fixture();
    const lesson = await value(
      f.db,
      "select lesson_id as v from public.course_assessment_bindings where assessment_id=$1",
      [f.assessmentIds.QUIZ_1],
    );
    await asPolicyUser(f.db, 2);
    const legacy = await value(
      f.db,
      "select public.create_assessment($1,$2,$3,'Legacy unbound quiz','Independent response',now()-interval '1 hour',now()+interval '2 hours',30,1,'Unbound legacy fixture') as v",
      [f.cohortId, lesson, administrator],
    );
    await f.db.query(
      "select public.add_assessment_question($1,1,'Legacy prompt',10,'Protected answer',null,'Legacy fixture question')",
      [legacy],
    );
    await f.db.query(
      "select public.change_assessment_status($1,'PUBLISHED','Legacy fixture publication')",
      [legacy],
    );
    const id = await start(f, legacy);
    expect(
      await value(
        f.db,
        "select public.get_commercial_v1_active_attempt() as v",
      ),
    ).toBeNull();
    await expire(f.db, id);
    const before = await snapshot(f.db, id);
    await asPolicyUser(f.db, 1);
    expect(
      await value(
        f.db,
        "select public.get_commercial_v1_active_attempt() as v",
      ),
    ).toBeNull();
    await f.db.query("select public.finalize_expired_commercial_v1_attempts()");
    expect(await snapshot(f.db, id)).toEqual(before);
  });
});

describe("One-sitting replay after the fresh-start deadline", () => {
  it("resumes the same unexpired governed attempt after latest_start_at without changing history", async () => {
    const now = Date.now();
    const f = await fixture({
      withLabs: false,
      windows: {
        QUIZ_1: {
          opensAt: new Date(now - 2 * 3600_000),
          closesAt: new Date(now + 30 * 60_000),
          durationMinutes: 60,
        },
      },
    });
    // Owner-only fixture insertion represents a legitimate earlier start:
    // latest start ~30m ago, actual start ~45m ago, full expiry ~15m ahead.
    // No production trigger is suspended and no institutional row is rewritten.
    const id = await value(
      f.db,
      `
      insert into public.assessment_attempts(
        assessment_id,enrolment_id,student_id,cohort_id,programme_version_id,
        attempt_number,state,started_at,expires_at
      )
      select a.id,e.id,e.student_id,a.cohort_id,a.programme_version_id,
        1,'ACTIVE',a.closes_at-make_interval(mins=>a.duration_minutes+15),
        a.closes_at-interval '15 minutes'
      from public.assessments a join public.enrolments e
        on e.cohort_id=a.cohort_id and e.programme_version_id=a.programme_version_id
      where a.id=$1 and e.id=$2 and e.status='ACTIVE'
      returning id as v`,
      [f.assessmentIds.QUIZ_1, f.learnerEnrolmentId],
    );
    expect(
      await value<boolean>(
        f.db,
        `
      select a.status='PUBLISHED' and gp.published_at is not null
        and clock_timestamp()>a.closes_at-make_interval(mins=>a.duration_minutes)
        and clock_timestamp()<a.closes_at
        and t.state='ACTIVE' and t.expires_at>clock_timestamp()
        and t.started_at>=a.opens_at
        and t.started_at<a.closes_at-make_interval(mins=>a.duration_minutes)
        and t.expires_at=t.started_at+make_interval(mins=>a.duration_minutes) as v
      from public.assessment_attempts t
      join public.assessments a on a.id=t.assessment_id
      join public.commercial_v1_component_bindings b on b.assessment_id=a.id
      join public.commercial_v1_grading_policies gp on gp.activation_id=b.activation_id
      where t.id=$1`,
        [id],
      ),
    ).toBe(true);
    const before = await snapshot(f.db, id);
    expect(before.attempt_number).toBe(1);
    expect(await start(f)).toBe(id);
    // Compare every persisted field, including started_at, expires_at and number.
    expect(await snapshot(f.db, id)).toEqual(before);
    expect(
      await value<number>(
        f.db,
        "select count(*)::int as v from public.assessment_attempts where assessment_id=$1 and enrolment_id=$2",
        [f.assessmentIds.QUIZ_1, f.learnerEnrolmentId],
      ),
    ).toBe(1);
  });
});
