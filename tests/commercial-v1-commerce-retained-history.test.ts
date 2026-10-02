import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID, randomBytes, createHmac } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  expect,
  it,
  vi,
} from "vitest";
import {
  buildCommerceFixture,
  asPolicyUser,
  learner,
  administrator,
  type CommerceFixture,
} from "./commercial-v1-commerce-fixture";

const mocks = vi.hoisted(() => ({
  requireActor: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
}));
vi.mock("@/server/identity", () => ({
  requireActor: mocks.requireActor,
  requireAnyRole: vi.fn(),
  requireStudentPrincipal: vi.fn(),
}));
vi.mock("@/server/supabase", () => ({
  createSupabase: async () => ({ rpc: mocks.rpc, from: mocks.from }),
}));
import { getStudentLearningEvidence } from "@/server/learning-evidence";
import { getStudentObjectiveMastery } from "@/server/objective-mastery";
import { getStudentLessonProgress } from "@/server/lesson-progress";

let f: CommerceFixture;
let orderId: string, enrolmentId: string;
const keyId = randomUUID(),
  key = randomBytes(32),
  sessionId = "cs_history";
const foundations =
  process.env.COMMERCE_FOUNDATIONS_MIGRATION ??
  (existsSync(
    "supabase/migrations/202610010044_admin_control_plane_foundations.sql",
  )
    ? "supabase/migrations/202610010044_admin_control_plane_foundations.sql"
    : undefined);
async function value<T = string>(sql: string, args: unknown[] = []) {
  return (await f.db.query<{ v: T }>(sql, args)).rows[0].v;
}
beforeAll(async () => {
  f = await buildCommerceFixture({
    throughMigration: 43,
    withLessonSegment: true,
  });
  if (foundations) await f.db.exec(await readFile(foundations, "utf8"));
  await f.db.exec(
    await readFile(
      "supabase/migrations/202610010045_admin_commerce_operations.sql",
      "utf8",
    ),
  );
  await f.db.query(
    "select commercial_v1_commerce_private.install_controller_key($1,$2::bytea)",
    [keyId, key],
  );
}, 60000);
afterAll(async () => {
  await f?.db.close();
});
beforeEach(async () => {
  vi.resetAllMocks();
  mocks.requireActor.mockResolvedValue({ id: learner });
  mocks.from.mockImplementation(() => {
    throw new Error("Retained history must not request curriculum embeds");
  });
  mocks.rpc.mockImplementation(
    async (name: string, args: { p_kind: string }) => {
      expect(name).toBe("get_student_retained_learning_history");
      return {
        data: await value(
          "select public.get_student_retained_learning_history($1) as v",
          [args.p_kind],
        ),
        error: null,
      };
    },
  );
  await f.db.exec("reset role; begin");
  await asPolicyUser(f.db, 2);
  await value(
    "select public.publish_commercial_v1_offer($1,'history-course',19900,'GBP','Retained history','STANDARD_6_WEEK','History fixture') as v",
    [f.activationId],
  );
  await asPolicyUser(f.db, 1);
  orderId = (
    await value<{ orderId: string }>(
      "select public.create_commercial_v1_order('history-course') as v",
    )
  ).orderId;
  await value(
    "select public.attach_commercial_v1_checkout_session($1,$2) as v",
    [orderId, sessionId],
  );
  const issued = Math.floor(Date.now() / 1000),
    expires = issued + 60,
    event = "evt_history_" + orderId;
  const canonical = [
    "DUCELIO_COMMERCE_FULFILLMENT_HMAC_SHA256_V1",
    "COMMERCIAL_V1_COMMERCE_V1",
    keyId,
    "STRIPE",
    orderId,
    sessionId,
    event,
    "19900",
    "GBP",
    "PAID",
    String(issued),
    String(expires),
  ].join("\n");
  enrolmentId = (
    await value<{ enrolmentId: string }>(
      "select public.fulfill_commercial_v1_order($1,$2,'STRIPE',$3,$4,19900,'GBP','PAID',$5,$6,$7) as v",
      [
        keyId,
        orderId,
        sessionId,
        event,
        issued,
        expires,
        createHmac("sha256", key).update(canonical).digest("hex"),
      ],
    )
  ).enrolmentId;
  await asPolicyUser(f.db, 2);
  const objective = await value<{ id: string; lesson_id: string }>(
    "select jsonb_build_object('id',id,'lesson_id',lesson_id) as v from public.lesson_objectives where programme_version_id=$1 order by position limit 1",
    [f.programmeVersionId],
  );
  const segment = await value(
    "select id as v from public.lesson_segments where lesson_id=$1 order by position limit 1",
    [objective.lesson_id],
  );
  const classId = await value(
    "select public.create_class_session($1,$2,$3,now()-interval '2 hours',now()-interval '1 hour','Retained learning history fixture') as v",
    [f.cohortId, objective.lesson_id, administrator],
  );
  await value(
    "select public.record_learning_evidence($1,$2,$3,'CLASS_RESPONSE','CORRECT','Historical evidence reference','history-evidence-key','Retained evidence fixture') as v",
    [classId, enrolmentId, objective.id],
  );
  await value(
    "select public.record_lesson_progress($1,$2,$3,'COMPLETED','Retained progress fixture') as v",
    [classId, enrolmentId, segment],
  );
  await asPolicyUser(f.db, 1);
});
afterEach(async () => {
  await f.db.exec("rollback; reset role");
});

async function revoke() {
  // Governed cancellation and the signed refund path share the exact revocation
  // helper. Use actual signed full-refund observation for this regression.
  await asPolicyUser(f.db, 1);
  const payload = JSON.stringify({
    kind: "REFUND",
    actorId: null,
    reason: "Verified full Stripe refund",
    orderId,
    sessionId,
    eventId: "evt_history_refund",
    chargeId: "ch_history",
    amountMinor: 19900,
    refundedMinor: 19900,
    currency: "GBP",
  });
  const issued = Math.floor(Date.now() / 1000),
    expires = issued + 60;
  const mac = createHmac("sha256", key)
    .update(
      [
        "DUCELIO_COMMERCE_OPERATIONS_HMAC_SHA256_V1",
        keyId,
        payload,
        String(issued),
        String(expires),
      ].join("\n"),
    )
    .digest("hex");
  expect(
    await value(
      "select public.apply_commercial_v1_commerce_operation($1,$2,$3,$4,$5) as v",
      [keyId, payload, issued, expires, mac],
    ),
  ).toMatchObject({ code: "ACCESS_REVOKED" });
}

it("refunded learner retains renderable evidence, mastery and progress without reopening substantive curriculum", async () => {
  const before = await Promise.all([
    getStudentLearningEvidence(),
    getStudentObjectiveMastery(),
    getStudentLessonProgress(),
  ]);
  expect(before.map((rows) => rows.length)).toEqual([1, 1, 1]);
  await revoke();
  const after = await Promise.all([
    getStudentLearningEvidence(),
    getStudentObjectiveMastery(),
    getStudentLessonProgress(),
  ]);
  expect(after).toEqual(before);
  const labels = after.flatMap((rows) => rows.map((row) => row.lessons.title));
  const html = renderToStaticMarkup(
    createElement(
      "ul",
      null,
      labels.map((label, i) => createElement("li", { key: i }, label)),
    ),
  );
  expect(html).toContain(before[0][0].lessons.title);
  expect(mocks.from).not.toHaveBeenCalled();
  for (const table of [
    "lessons",
    "lesson_objectives",
    "lesson_segments",
    "learning_resources",
    "assignments",
    "assessments",
  ])
    expect(
      (
        await f.db.query(
          `select id from public.${table} where programme_version_id=$1`,
          [f.programmeVersionId],
        )
      ).rows,
    ).toHaveLength(0);
  const projection = JSON.stringify(after);
  for (const field of [
    "body",
    "url",
    "prompt",
    "answer_key",
    "idempotency_key",
    "recorded_by",
  ])
    expect(projection).not.toContain('"' + field + '":');
});
it("foreign learner cannot recover another learner's historical rows or labels", async () => {
  await revoke();
  await asPolicyUser(f.db, 3);
  expect(
    await Promise.all([
      getStudentLearningEvidence(),
      getStudentObjectiveMastery(),
      getStudentLessonProgress(),
    ]),
  ).toEqual([[], [], []]);
});
it("history projection denies a caller without student authority", async () => {
  await asPolicyUser(f.db, 2);
  await expect(
    value(
      "select public.get_student_retained_learning_history('evidence') as v",
    ),
  ).rejects.toThrow("FORBIDDEN");
});
it("history projection rejects arbitrary kinds", async () => {
  await expect(
    value(
      "select public.get_student_retained_learning_history('lesson_body') as v",
    ),
  ).rejects.toThrow("INVALID_HISTORY_KIND");
});
it("server rejects a malformed missing-label projection", async () => {
  const good = await getStudentLearningEvidence();
  mocks.rpc.mockResolvedValue({
    data: [{ ...good[0], lessons: null }],
    error: null,
  });
  await expect(getStudentLearningEvidence()).rejects.toThrow();
});
