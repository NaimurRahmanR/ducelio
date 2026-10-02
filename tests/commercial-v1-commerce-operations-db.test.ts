import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID, randomBytes, createHmac } from "node:crypto";
import {
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  buildCommerceFixture,
  asPolicyUser,
  administrator,
  learner,
  foreignLearner,
  type CommerceFixture,
} from "./commercial-v1-commerce-fixture";
import {
  commerceDiagnosisSchema,
  commerceListSchema,
} from "@/domain/commercial-v1-commerce-operations";

let f: CommerceFixture;
const localFoundationsMigration =
  "supabase/migrations/202610010044_admin_control_plane_foundations.sql";
const foundationsMigration =
  process.env.COMMERCE_FOUNDATIONS_MIGRATION ??
  (existsSync(localFoundationsMigration)
    ? localFoundationsMigration
    : undefined);
const keyId = randomUUID(),
  key = randomBytes(32);
let orderId: string, offerId: string;
const sessionId = "cs_operations_fixture";
async function value<T = string>(
  sql: string,
  args: unknown[] = [],
): Promise<T> {
  return (await f.db.query<{ v: T }>(sql, args)).rows[0].v;
}
async function owner() {
  await f.db.exec("reset role");
}
async function asUser(n: number) {
  await asPolicyUser(f.db, n);
}
async function claim(
  status = "PAID",
  admin = false,
  claimedSession = sessionId,
) {
  const issued = Math.floor(Date.now() / 1000),
    expires = issued + 60;
  const fields = [
    keyId,
    orderId,
    "STRIPE",
    claimedSession,
    "evt_fixture_" + orderId,
    19900,
    "GBP",
    status,
    issued,
    expires,
  ];
  const canonical = [
    "DUCELIO_COMMERCE_FULFILLMENT_HMAC_SHA256_V1",
    "COMMERCIAL_V1_COMMERCE_V1",
    keyId,
    "STRIPE",
    orderId,
    claimedSession,
    "evt_fixture_" + orderId,
    "19900",
    "GBP",
    status,
    String(issued),
    String(expires),
  ].join("\n");
  const args = [
    ...fields,
    createHmac("sha256", key).update(canonical).digest("hex"),
  ];
  if (admin) args.push("Operator recovery test");
  return value<Record<string, unknown>>(
    `select public.${admin ? "admin_reconcile_commercial_v1_order" : "fulfill_commercial_v1_order"}(${args.map((_, i) => "$" + (i + 1)).join(",")}) as v`,
    args,
  );
}
async function operation(payload: Record<string, unknown>, tamper = false) {
  const issued = Math.floor(Date.now() / 1000),
    expires = issued + 60,
    text = JSON.stringify(payload);
  const mac = createHmac("sha256", key)
    .update(
      [
        "DUCELIO_COMMERCE_OPERATIONS_HMAC_SHA256_V1",
        keyId,
        text,
        String(issued),
        String(expires),
      ].join("\n"),
    )
    .digest("hex");
  return value<Record<string, unknown>>(
    "select public.apply_commercial_v1_commerce_operation($1,$2,$3,$4,$5) as v",
    [keyId, text, issued, expires, tamper ? "0".repeat(64) : mac],
  );
}
async function diagnose() {
  return commerceDiagnosisSchema.parse(
    await value(
      "select public.admin_diagnose_commercial_v1_access(null,null,$1) as v",
      [orderId],
    ),
  );
}
async function refund() {
  return operation({
    kind: "REFUND",
    actorId: null,
    reason: "Verified full Stripe refund",
    orderId,
    sessionId,
    eventId: "evt_refund",
    chargeId: "ch_fixture",
    amountMinor: 19900,
    refundedMinor: 19900,
    currency: "GBP",
  });
}

beforeAll(async () => {
  f = await buildCommerceFixture({ throughMigration: 43 });
  // Optional local cross-worktree acceptance applies the real upstream migration,
  // never copies it into this branch or recreates its cohort guards.
  if (foundationsMigration)
    await f.db.exec(await readFile(foundationsMigration, "utf8"));
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
  await owner();
  await f.db.exec("begin");
  await asUser(2);
  offerId = await value(
    "select public.publish_commercial_v1_offer($1,'operations-course',19900,'GBP','Test course','STANDARD_6_WEEK','Operations fixture') as v",
    [f.activationId],
  );
  await asUser(1);
  const order = await value<{ orderId: string }>(
    "select public.create_commercial_v1_order('operations-course') as v",
  );
  orderId = order.orderId;
  await value(
    "select public.attach_commercial_v1_checkout_session($1,$2) as v",
    [orderId, sessionId],
  );
});
afterEach(async () => {
  await f.db.exec("rollback");
  await owner();
});

describe("commerce operations database authority", () => {
  it("admin inspects bounded orders and diagnosis", async () => {
    await asUser(2);
    const list = commerceListSchema.parse(
      await value(
        "select public.admin_list_commercial_v1_operations('orders') as v",
      ),
    );
    expect(list.rows[0].orderId).toBe(orderId);
    expect((await diagnose()).accessReason).toBe("PAYMENT_NOT_CONFIRMED");
  });
  it("commerce audit excludes unrelated Commercial V1 academic execution records", async () => {
    await owner();
    await f.db.query(
      "insert into public.audit_events(actor_id,action,target_type,target_id,source,reason) values($1,'COMMERCIAL_V1_EXAMINER_EXECUTION_FAILED','commercial_v1_examiner_executions',$2,'ACADEMIC_TEST','Unrelated academic execution reason')",
      [administrator, randomUUID()],
    );
    await asUser(2);
    const audit = commerceListSchema.parse(
      await value(
        "select public.admin_list_commercial_v1_operations('audit') as v",
      ),
    );
    expect(
      audit.rows.some((r) => r.state === "COMMERCIAL_V1_OFFER_PUBLISHED"),
    ).toBe(true);
    expect(audit.rows.some((r) => r.state.includes("EXAMINER"))).toBe(false);
    expect(JSON.stringify(audit)).not.toContain(
      "Unrelated academic execution reason",
    );
  });
  it.each([1, 3])(
    "learner %i cannot inspect any operational projection",
    async (n) => {
      await asUser(n);
      await expect(diagnose()).rejects.toThrow(/denied|FORBIDDEN/i);
    },
  );
  it("foreign learner cannot read another learner's legacy order", async () => {
    await asUser(3);
    expect(
      await value("select public.get_commercial_v1_order($1) as v", [orderId]),
    ).toMatchObject({ ok: false });
  });
  it("paid stranded order recovers, audits and repeated recovery does not duplicate access", async () => {
    await asUser(2);
    expect(await claim("PAID", true)).toMatchObject({
      ok: true,
      fulfilled: true,
      replay: false,
    });
    expect(await claim("PAID", true)).toMatchObject({ replay: true });
    const d = await diagnose();
    expect(d.hasAccess).toBe(true);
    expect(
      d.audit.filter(
        (a) => a.action === "COMMERCIAL_V1_OPERATOR_RECONCILIATION",
      ),
    ).toHaveLength(2);
    await owner();
    expect(
      await value<number>(
        "select count(*)::int as v from public.commercial_v1_entitlements where order_id=$1",
        [orderId],
      ),
    ).toBe(1);
  });
  it("unpaid evidence cannot grant access through an admin", async () => {
    await asUser(2);
    expect(await claim("UNPAID", true)).toMatchObject({
      fulfilled: false,
      code: "NOT_PAID",
    });
    const d = await diagnose();
    expect(d.entitlementId).toBeNull();
    expect(d.fulfilmentAttempted).toBe(true);
  });
  it("paid order with paused enrolment is inconsistent and never automatically reactivated", async () => {
    await asUser(2);
    const enrolment = await value(
      "select public.create_enrolment($1,$2,'Governed enrolment') as v",
      [learner, f.cohortId],
    );
    await value(
      "select public.change_enrolment_status($1,'PAUSED','Academic pause') as v",
      [enrolment],
    );
    expect(await claim("PAID", true)).toMatchObject({
      ok: false,
      code: "ENROLMENT_NOT_ACTIVATABLE",
    });
    const d = await diagnose();
    expect(d.paymentConfirmed).toBe(true);
    expect(d.accessReason).toBe("ENROLMENT_PAUSED");
    expect(d.hasAccess).toBe(false);
  });
  it("untrusted observation is rejected before any journal write", async () => {
    await expect(
      operation(
        {
          kind: "WEBHOOK_RECEIVED",
          eventId: "evt_bad",
          eventType: "checkout.session.completed",
        },
        true,
      ),
    ).rejects.toThrow("UNTRUSTED_CLAIM");
  });
  it("valid unresolved receipt is durable and duplicate receipt is idempotent", async () => {
    const receipt = {
      kind: "WEBHOOK_RECEIVED",
      eventId: "evt_unresolved",
      eventType: "checkout.session.completed",
      subjectId: "cs_unknown",
      orderId: null,
    };
    await operation(receipt);
    await operation(receipt);
    await operation({
      kind: "WEBHOOK_RESULT",
      eventId: "evt_unresolved",
      state: "UNRESOLVED",
      reason: "ORDER_NOT_FOUND",
      orderId: null,
    });
    await asUser(2);
    const list = commerceListSchema.parse(
      await value(
        "select public.admin_list_commercial_v1_operations('issues') as v",
      ),
    );
    expect(list.rows).toHaveLength(1);
    expect(list.rows[0].reason).toBe("ORDER_NOT_FOUND");
  });
  it("full refund revokes entitlement, withdraws active enrolment, preserves history and blocks late payment", async () => {
    await claim();
    await refund();
    expect(await refund()).toMatchObject({ code: "ALREADY_REVOKED" });
    await asUser(2);
    const d = await diagnose();
    expect(d.entitlementState).toBe("REVOKED");
    expect(d.enrolmentStatus).toBe("WITHDRAWN");
    expect(d.orderState).toBe("FULFILLED");
    expect(d.payments).toHaveLength(1);
    expect(d.hasAccess).toBe(false);
    expect(
      d.audit.some((a) => a.action === "COMMERCIAL_V1_ENTITLEMENT_REVOKED"),
    ).toBe(true);
    expect(await claim("PAID", true)).toMatchObject({ code: "ACCESS_REVOKED" });
    await asUser(1);
    expect(
      (
        await f.db.query(
          "select id from public.lessons where programme_version_id=$1",
          [f.programmeVersionId],
        )
      ).rows,
    ).toHaveLength(0);
  });
  it("refund before fulfilment creates a durable barrier to late checkout delivery", async () => {
    await refund();
    expect(await claim()).toMatchObject({ code: "ORDER_REFUNDED" });
    await asUser(2);
    expect((await diagnose()).entitlementId).toBeNull();
  });
  it("partial refunds cannot automatically revoke access", async () => {
    await claim();
    expect(
      await operation({
        kind: "REFUND",
        actorId: null,
        reason: "Partial refund",
        orderId,
        sessionId,
        eventId: "evt_partial",
        chargeId: "ch_fixture",
        amountMinor: 19900,
        refundedMinor: 100,
        currency: "GBP",
      }),
    ).toMatchObject({ code: "PARTIAL_REFUND_REVIEW" });
    await asUser(2);
    expect((await diagnose()).hasAccess).toBe(true);
  });
  it("completed enrolment history survives refund", async () => {
    await claim();
    await owner();
    await f.db.query(
      "update public.enrolments set status='COMPLETED' where student_id=$1 and cohort_id=$2",
      [learner, f.cohortId],
    );
    await refund();
    await asUser(2);
    expect((await diagnose()).enrolmentStatus).toBe("COMPLETED");
    expect((await diagnose()).hasAccess).toBe(false);
  });
  it("governed manual access cancellation supports idempotency and audits actor", async () => {
    await claim();
    await asUser(2);
    const d = await diagnose();
    expect(
      await value(
        "select public.admin_revoke_commercial_v1_entitlement($1,'Operator access cancellation') as v",
        [d.entitlementId],
      ),
    ).toMatchObject({ code: "ACCESS_REVOKED" });
    expect(
      await value(
        "select public.admin_revoke_commercial_v1_entitlement($1,'Operator access cancellation') as v",
        [d.entitlementId],
      ),
    ).toMatchObject({ code: "ALREADY_REVOKED" });
    expect(
      (await diagnose()).audit.some(
        (a) => a.action === "COMMERCIAL_V1_ACCESS_CANCELLATION",
      ),
    ).toBe(true);
  });
  it("learner cannot invoke the operator mutation wrapper", async () => {
    await expect(claim("PAID", true)).rejects.toThrow(/denied|FORBIDDEN/i);
  });
  it("diagnosis supports a learner with no order", async () => {
    await asUser(2);
    const d = commerceDiagnosisSchema.parse(
      await value(
        "select public.admin_diagnose_commercial_v1_access($1,$2) as v",
        [foreignLearner, offerId],
      ),
    );
    expect(d.accessReason).toBe("NO_ORDER_OR_ENROLMENT");
    expect(d.orderId).toBeNull();
  });

  it("campaign redemption details show learner, offer and resulting access under admin authority", async () => {
    await asUser(2);
    await value(
      "select public.create_commercial_v1_campaign('operations-course','REVIEWOPS','REVIEWER_COMPLIMENTARY',null,0,10,clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 day','Reviewer campaign') as v",
    );
    await asUser(3);
    await value(
      "select public.redeem_commercial_v1_campaign('operations-course','REVIEWOPS') as v",
    );
    await asUser(2);
    const list = commerceListSchema.parse(
      await value(
        "select public.admin_list_commercial_v1_operations('redemptions') as v",
      ),
    );
    expect(list.rows).toHaveLength(1);
    expect(list.rows[0]).toMatchObject({
      learnerId: foreignLearner,
      state: "ACTIVE / ACTIVE",
    });
    expect(list.rows[0].subtitle).toContain("REVIEWOPS");
  });
  it("learners cannot inspect redemption details", async () => {
    await expect(
      value(
        "select public.admin_list_commercial_v1_operations('redemptions') as v",
      ),
    ).rejects.toThrow(/denied|FORBIDDEN/i);
  });
  it("anonymous direct table access is denied", async () => {
    await owner();
    await f.db.query("select set_config('request.jwt.claim.sub','',false)");
    await f.db.exec("set role anon");
    await expect(
      f.db.query("select * from public.commercial_v1_webhook_receipts"),
    ).rejects.toThrow(/permission denied/i);
  });
  it("revoked entitlement cannot be reactivated or have its immutable provenance changed", async () => {
    await claim();
    await refund();
    await owner();
    await expect(
      f.db.query(
        "update public.commercial_v1_entitlements set state='ACTIVE',revoked_at=null,revocation_reason=null where order_id=$1",
        [orderId],
      ),
    ).rejects.toThrow(/Only ACTIVE to REVOKED/);
  });
  it("revocation provenance requires a non-null bounded reason even for database-owner writes", async () => {
    await claim();
    await owner();
    await expect(
      f.db.query(
        "update public.commercial_v1_entitlements set state='REVOKED',revoked_at=now(),revocation_reason=null where order_id=$1",
        [orderId],
      ),
    ).rejects.toThrow(/entitlement_revocation_provenance/);
  });
  it.each(["OPERATOR_FAILURE", "REFUND"])(
    "signed %s operator audit cannot omit its reason",
    async (kind) => {
      await asUser(2);
      await expect(
        operation({ kind, actorId: administrator, orderId, code: "NOT_PAID" }),
      ).rejects.toThrow("BOUNDED_REASON_REQUIRED");
    },
  );
  it("an unresolved fulfilment failure is visible even without a payment row", async () => {
    await operation({
      kind: "WEBHOOK_RECEIVED",
      eventId: "evt_attempt",
      eventType: "checkout.session.completed",
      subjectId: sessionId,
      orderId,
    });
    await operation({
      kind: "WEBHOOK_RESULT",
      eventId: "evt_attempt",
      state: "UNRESOLVED",
      reason: "FULFILMENT_UNAVAILABLE",
      orderId,
    });
    await asUser(2);
    const d = await diagnose();
    expect(d.paymentConfirmed).toBe(false);
    expect(d.fulfilmentAttempted).toBe(true);
  });
  it.each(["questions", "legacy response", "governed response", "submission"])(
    "refund closes an already-open assessment's %s path while preserving academic history",
    async (path) => {
      await claim();
      await owner();
      const assessmentId = await value(
        "select id as v from public.assessments where cohort_id=$1 limit 1",
        [f.cohortId],
      );
      await asUser(1);
      const attemptId = await value(
        "select public.start_assessment_attempt($1) as v",
        [assessmentId],
      );
      const questions = await f.db.query<{ id: string }>(
        "select id from public.get_active_assessment_questions($1)",
        [assessmentId],
      );
      const questionId = questions.rows[0].id;
      await value(
        "select public.record_assessment_response($1,$2,'Historical answer','before-refund-response') as v",
        [attemptId, questionId],
      );
      await refund();
      await f.db.exec("savepoint revoked_probe");
      const probe =
        path === "questions"
          ? f.db.query(
              "select * from public.get_active_assessment_questions($1)",
              [assessmentId],
            )
          : path === "submission"
            ? f.db.query("select public.submit_assessment_attempt($1)", [
                attemptId,
              ])
            : f.db.query(
                `select public.${path === "legacy response" ? "record_assessment_response" : "record_commercial_v1_assessment_response"}($1,$2,'Post-refund answer','after-refund-response')`,
                [attemptId, questionId],
              );
      await expect(probe).rejects.toThrow("COMMERCIAL_ACCESS_REVOKED");
      await f.db.exec("rollback to savepoint revoked_probe");
      await owner();
      expect(
        await value(
          "select state as v from public.assessment_attempts where id=$1",
          [attemptId],
        ),
      ).toBe("ACTIVE");
      expect(
        (
          await f.db.query(
            "select body from public.assessment_responses where attempt_id=$1",
            [attemptId],
          )
        ).rows,
      ).toEqual([{ body: "Historical answer" }]);
    },
  );
  it("a revoked completed learner loses course content while academic record remains", async () => {
    await claim();
    await owner();
    await f.db.query(
      "update public.enrolments set status='COMPLETED' where student_id=$1 and cohort_id=$2",
      [learner, f.cohortId],
    );
    await refund();
    await asUser(1);
    expect(
      (
        await f.db.query(
          "select id from public.learning_resources where programme_version_id=$1",
          [f.programmeVersionId],
        )
      ).rows,
    ).toHaveLength(0);
    expect(
      (
        await f.db.query(
          "select status from public.enrolments where student_id=$1 and cohort_id=$2",
          [learner, f.cohortId],
        )
      ).rows,
    ).toEqual([{ status: "COMPLETED" }]);
    expect(
      await value("select public.get_commercial_v1_order($1) as v", [orderId]),
    ).toMatchObject({
      ok: true,
      order: { orderRefunded: true, accessRevoked: true },
    });
    expect(
      await value(
        "select public.get_commercial_v1_offer('operations-course') as v",
      ),
    ).toMatchObject({ viewerEntitled: false });
  });
  it("signed envelope is bound to the authenticated operator identity", async () => {
    await asUser(2);
    await expect(
      operation({
        kind: "OPERATOR_FAILURE",
        actorId: foreignLearner,
        orderId,
        reason: "Forged actor review",
        code: "NOT_PAID",
      }),
    ).rejects.toThrow(/denied|ACTOR_MISMATCH/i);
  });

  it("refunding a redundant order preserves access funded by the original order", async () => {
    const firstOrder = orderId;
    await asUser(2);
    await value(
      "select public.archive_commercial_v1_offer('operations-course','Replace offer price') as v",
    );
    await value(
      "select public.publish_commercial_v1_offer($1,'second-offer',19900,'GBP','Test course','STANDARD_6_WEEK','Replacement offer') as v",
      [f.activationId],
    );
    await asUser(1);
    const second = await value<{ orderId: string }>(
      "select public.create_commercial_v1_order('second-offer') as v",
    );
    await value(
      "select public.attach_commercial_v1_checkout_session($1,'cs_second') as v",
      [second.orderId],
    );
    await claim();
    orderId = second.orderId;
    await claim("PAID", false, "cs_second");
    expect(
      await operation({
        kind: "REFUND",
        actorId: null,
        reason: "Duplicate payment refund",
        orderId,
        sessionId: "cs_second",
        eventId: "evt_second_refund",
        chargeId: "ch_second",
        amountMinor: 19900,
        refundedMinor: 19900,
        currency: "GBP",
      }),
    ).toMatchObject({ code: "REFUNDED_NO_LINKED_ENTITLEMENT" });
    await asUser(2);
    const d = await diagnose();
    expect(d.entitlementOrderId).toBe(firstOrder);
    expect(d.entitlementState).toBe("ACTIVE");
    expect(d.hasAccess).toBe(true);
    await asUser(1);
    expect(
      await value("select public.get_commercial_v1_order($1) as v", [orderId]),
    ).toMatchObject({
      ok: true,
      order: { orderRefunded: true, accessRevoked: false },
    });
    expect(await claim("PAID", false, "cs_second")).toMatchObject({
      ok: false,
      code: "ORDER_REFUNDED",
    });
  });
  it("academic enrolment created between order and fulfilment is never adopted or withdrawn by commerce", async () => {
    await asUser(2);
    const enrolmentId = await value(
      "select public.create_enrolment($1,$2,'Independent academic admission') as v",
      [learner, f.cohortId],
    );
    await asUser(1);
    expect(await claim()).toMatchObject({ fulfilled: true, enrolmentId });
    expect(await refund()).toMatchObject({ code: "ENTITLEMENT_REVOKED" });
    await asUser(2);
    const d = await diagnose();
    expect(d).toMatchObject({
      enrolmentId,
      enrolmentStatus: "ACTIVE",
      enrolmentOrigin: "ACADEMIC",
      entitlementState: "REVOKED",
      refunded: true,
      hasAccess: true,
    });
    await asUser(1);
    expect(
      (
        await f.db.query(
          "select id from public.lessons where programme_version_id=$1",
          [f.programmeVersionId],
        )
      ).rows.length,
    ).toBeGreaterThan(0);
    expect(
      await value("select public.get_commercial_v1_order($1) as v", [orderId]),
    ).toMatchObject({ order: { orderRefunded: true, accessRevoked: false } });
    expect(await claim()).toMatchObject({ code: "ORDER_REFUNDED" });
  });
  it("idempotent academic admission after commerce fulfilment does not change commerce ownership", async () => {
    const result = await claim();
    await asUser(2);
    expect(
      await value(
        "select public.create_enrolment($1,$2,'Admission replay after commerce') as v",
        [learner, f.cohortId],
      ),
    ).toBe(result.enrolmentId);
    expect((await diagnose()).enrolmentOrigin).toBe("COMMERCE");
    await refund();
    expect((await diagnose()).enrolmentStatus).toBe("WITHDRAWN");
  });
  it("unknown historical enrolment ownership retains status but never preserves refunded commercial access", async () => {
    await asUser(2);
    const enrolmentId = await value(
      "select public.create_enrolment($1,$2,'Historical academic record') as v",
      [learner, f.cohortId],
    );
    await owner();
    // Simulate an existing entitlement whose migration-default ownership is
    // UNKNOWN. Never manufacture a claim that its original enrolment INSERT was
    // commerce-owned. The same default applies to all pre-045 rows.
    await f.db.query(
      "insert into public.commercial_v1_entitlements(learner_id,offer_id,activation_id,order_id,enrolment_id) values($1,$2,$3,$4,$5)",
      [learner, offerId, f.activationId, orderId, enrolmentId],
    );
    await refund();
    await asUser(2);
    expect(await diagnose()).toMatchObject({
      enrolmentOrigin: "UNKNOWN",
      enrolmentStatus: "ACTIVE",
      entitlementState: "REVOKED",
      hasAccess: false,
    });
    await asUser(1);
    expect(
      (
        await f.db.query(
          "select id from public.lessons where programme_version_id=$1",
          [f.programmeVersionId],
        )
      ).rows,
    ).toHaveLength(0);
    expect(
      await value("select public.get_commercial_v1_order($1) as v", [orderId]),
    ).toMatchObject({ order: { orderRefunded: true, accessRevoked: true } });
  });
  it("commerce enrolment provenance cannot be changed after the entitlement is inserted", async () => {
    await claim();
    await owner();
    await expect(
      f.db.query(
        "update public.commercial_v1_entitlements set enrolment_origin='ACADEMIC' where order_id=$1",
        [orderId],
      ),
    ).rejects.toThrow("Only ACTIVE to REVOKED");
  });
  it("enrolment provenance cannot be rewritten to avoid a refund withdrawal", async () => {
    await claim();
    await owner();
    await expect(
      f.db.query(
        "update public.commercial_v1_entitlements set enrolment_origin='ACADEMIC' where order_id=$1",
        [orderId],
      ),
    ).rejects.toThrow("Only ACTIVE to REVOKED is permitted");
  });
  it.runIf(Boolean(foundationsMigration))(
    "final 044 closed-cohort guard still denies academic admission but permits verified paid fulfilment",
    async () => {
      await asUser(2);
      await value(
        "select public.admin_change_cohort_status($1,'CLOSED','Close after checkout began') as v",
        [f.cohortId],
      );
      await f.db.exec("savepoint denied_admission");
      await expect(
        value(
          "select public.create_enrolment($1,$2,'Unpaid academic admission') as v",
          [learner, f.cohortId],
        ),
      ).rejects.toThrow("COHORT_NOT_OPEN");
      await f.db.exec("rollback to savepoint denied_admission");
      await asUser(1);
      expect(await claim()).toMatchObject({ fulfilled: true });
      await asUser(2);
      expect(await diagnose()).toMatchObject({
        enrolmentOrigin: "COMMERCE",
        hasAccess: true,
      });
      await refund();
      expect(await diagnose()).toMatchObject({
        enrolmentStatus: "WITHDRAWN",
        hasAccess: false,
      });
    },
  );
  it.runIf(Boolean(foundationsMigration))(
    "final 044 full-cohort paid exception remains intact without treating academic seats as commerce-owned",
    async () => {
      await asUser(2);
      await value(
        "select public.admin_update_cohort($1,'Capacity fixture',current_date+14,null,1,'Set one seat after checkout') as v",
        [f.cohortId],
      );
      const independent = await value(
        "select public.create_enrolment($1,$2,'Independent learner occupies capacity') as v",
        [foreignLearner, f.cohortId],
      );
      await asUser(1);
      expect(await claim()).toMatchObject({ fulfilled: true });
      await refund();
      await owner();
      expect(
        await value("select status as v from public.enrolments where id=$1", [
          independent,
        ]),
      ).toBe("ACTIVE");
    },
  );
  it.each(["RESOLVED", "IGNORED"])(
    "database refuses retry of terminal %s webhook receipts",
    async (state) => {
      await operation({
        kind: "WEBHOOK_RECEIVED",
        eventId: "evt_terminal",
        eventType: "checkout.session.completed",
        subjectId: sessionId,
        orderId,
      });
      await operation({
        kind: "WEBHOOK_RESULT",
        eventId: "evt_terminal",
        orderId,
        state,
        reason: state === "RESOLVED" ? "FULFILLED" : "UNSUPPORTED_EVENT",
      });
      await asUser(2);
      const receipt = commerceListSchema.parse(
        await value(
          "select public.admin_list_commercial_v1_operations('issues') as v",
        ),
      ).rows[0].id;
      await expect(
        value(
          "select public.admin_prepare_commercial_v1_webhook_retry($1,'Explicit recovery request') as v",
          [receipt],
        ),
      ).rejects.toThrow("RECEIPT_TERMINAL");
    },
  );
  it("refund aborts in-flight generic read releases and denies practical content", async () => {
    await claim();
    const release = await value<{ release_id: string }>(
      "select public.begin_academic_content_release($1,'get_lesson_context','PROFESSOR_READ_V2') as v",
      [randomUUID()],
    );
    await refund();
    expect(
      await value(
        "select public.close_academic_content_release($1,true) as v",
        [release.release_id],
      ),
    ).toMatchObject({ state: "ABORTED" });
    await asUser(2);
    const d = await diagnose();
    await asUser(1);
    await expect(
      value("select public.list_my_practicals($1) as v", [d.enrolmentId]),
    ).rejects.toThrow("COMMERCIAL_ACCESS_REVOKED");
  });
  it("pagination never exposes more than 25 records or secrets", async () => {
    for (let i = 0; i < 26; i++)
      await operation({
        kind: "WEBHOOK_RECEIVED",
        eventId: `evt_page_${i}`,
        eventType: "checkout.session.completed",
        subjectId: sessionId,
        orderId,
      });
    await asUser(2);
    const first = commerceListSchema.parse(
      await value(
        "select public.admin_list_commercial_v1_operations('issues','',0) as v",
      ),
    );
    const second = commerceListSchema.parse(
      await value(
        "select public.admin_list_commercial_v1_operations('issues','',25) as v",
      ),
    );
    expect(first.rows).toHaveLength(25);
    expect(first.hasMore).toBe(true);
    expect(second.rows).toHaveLength(1);
    expect(second.hasMore).toBe(false);
    expect(JSON.stringify(first)).not.toContain(key.toString("hex"));
  });
  it.runIf(Boolean(foundationsMigration))(
    "upstream account deactivation is diagnosed when migration 044 is present",
    async () => {
      await claim();
      await owner();
      await f.db.query(
        "update public.app_users set account_status='DEACTIVATED' where id=$1",
        [learner],
      );
      await asUser(2);
      expect((await diagnose()).accessReason).toBe("ACCOUNT_UNAVAILABLE");
      expect((await diagnose()).hasAccess).toBe(false);
    },
  );
});
