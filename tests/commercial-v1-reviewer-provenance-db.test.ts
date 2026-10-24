// Historical reviewer-acquisition protocol. The 073 cutover and retained
// payment paths are exercised by unified-legacy-retirement-db.test.ts.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  buildCommerceFixture,
  learner,
  foreignLearner,
  asPolicyUser,
  type CommerceFixture,
} from "./commercial-v1-commerce-fixture";

// Migration 202610020046: reviewer-complimentary redemption records enrolment
// provenance with the same ownership rule as paid fulfilment, so revoking a
// reviewer grant whose redemption created the enrolment withdraws it through
// the unchanged migration 045 revoke_entitlement policy.
const databases: PGlite[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) await db.close();
});
async function value<T = unknown>(
  db: PGlite,
  sql: string,
  args: unknown[] = [],
) {
  return (await db.query<{ v: T }>(sql, args)).rows[0]?.v as T;
}
async function owner(db: PGlite) {
  await db.exec("reset role");
}
const SLUG = "reviewer-course";
const CODE = "REVIEW-046";

async function fixture(capacity?: number, throughMigration = 72) {
  const f = await buildCommerceFixture({ throughMigration });
  databases.push(f.db);
  await asPolicyUser(f.db, 2);
  if (capacity) {
    const c = (
      await f.db.query<{ title: string; starts_on: string }>(
        "select title,starts_on::text from public.cohorts where id=$1",
        [f.cohortId],
      )
    ).rows[0];
    await value(
      f.db,
      "select public.admin_update_cohort($1,$2,$3::date,null,$4,'Seat limit') as v",
      [f.cohortId, c.title, c.starts_on, capacity],
    );
  }
  await value(
    f.db,
    "select public.publish_commercial_v1_offer($1,$2,19900,'GBP','Reviewer offer','Publish reviewer offer') as v",
    [f.activationId, SLUG],
  );
  await value(
    f.db,
    "select public.create_commercial_v1_campaign($1,$2,'REVIEWER_COMPLIMENTARY',null,0,5,clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 day','Reviewer campaign') as v",
    [SLUG, CODE],
  );
  await owner(f.db);
  return f;
}
async function redeem(f: CommerceFixture, user = 1) {
  await asPolicyUser(f.db, user);
  const result = await value<Record<string, unknown>>(
    f.db,
    "select public.redeem_commercial_v1_campaign($1,$2) as v",
    [SLUG, CODE],
  );
  await owner(f.db);
  return result;
}
async function entitlement(f: CommerceFixture, id: unknown) {
  return (
    await f.db.query<{
      enrolment_origin: string;
      state: string;
      source: string;
      enrolment_id: string;
    }>(
      "select enrolment_origin,state,source,enrolment_id from public.commercial_v1_entitlements where id=$1",
      [id],
    )
  ).rows[0];
}
async function enrolmentStatus(f: CommerceFixture, id: unknown) {
  return value<string>(
    f.db,
    "select status as v from public.enrolments where id=$1",
    [id],
  );
}
async function revoke(f: CommerceFixture, id: unknown) {
  await asPolicyUser(f.db, 2);
  const result = await value<Record<string, unknown>>(
    f.db,
    "select public.admin_revoke_commercial_v1_entitlement($1,'Reviewer access withdrawn') as v",
    [id],
  );
  await owner(f.db);
  return result;
}

describe("reviewer-complimentary redemption provenance (migration 046)", () => {
  it("a redemption that creates the enrolment records COMMERCE provenance, also in audit", async () => {
    const f = await fixture();
    const granted = await redeem(f);
    expect(granted).toMatchObject({
      ok: true,
      path: "ACCESS_GRANTED",
      reused: false,
    });
    expect(await entitlement(f, granted.entitlementId)).toMatchObject({
      enrolment_origin: "COMMERCE",
      state: "ACTIVE",
      source: "REVIEWER",
      enrolment_id: granted.enrolmentId,
    });
    expect(await enrolmentStatus(f, granted.enrolmentId)).toBe("ACTIVE");
    expect(
      await value(
        f.db,
        "select after_state->>'enrolment_origin' as v from public.audit_events where action='COMMERCIAL_V1_CAMPAIGN_ACCESS_GRANTED' and after_state->>'offer_id' is not null order by occurred_at desc limit 1",
      ),
    ).toBe("COMMERCE");
    // Idempotent replay returns the same durable grant without a second row.
    expect(await redeem(f)).toMatchObject({
      ok: true,
      reused: true,
      entitlementId: granted.entitlementId,
      enrolmentId: granted.enrolmentId,
    });
    expect(
      await value(
        f.db,
        "select count(*)::int as v from public.commercial_v1_entitlements where learner_id=$1",
        [learner],
      ),
    ).toBe(1);
  });

  it("revoking a COMMERCE reviewer grant withdraws its ACTIVE enrolment and blocks reactivation", async () => {
    const f = await fixture();
    const granted = await redeem(f);
    expect(await revoke(f, granted.entitlementId)).toMatchObject({
      ok: true,
      code: "ACCESS_REVOKED",
    });
    expect(await entitlement(f, granted.entitlementId)).toMatchObject({
      enrolment_origin: "COMMERCE",
      state: "REVOKED",
    });
    expect(await enrolmentStatus(f, granted.enrolmentId)).toBe("WITHDRAWN");
    expect(
      await value(
        f.db,
        "select after_state->>'previous_enrolment_status' as v from public.audit_events where action='COMMERCIAL_V1_ENTITLEMENT_REVOKED' and target_id=$1",
        [granted.entitlementId],
      ),
    ).toBe("ACTIVE");
    await expect(
      f.db.query("update public.enrolments set status='ACTIVE' where id=$1", [
        granted.enrolmentId,
      ]),
    ).rejects.toThrow("COMMERCIAL_ACCESS_REVOKED");
    // A revoked grant cannot be redeemed again.
    expect(await redeem(f)).toMatchObject({ ok: true, reused: true });
    expect(await entitlement(f, granted.entitlementId)).toMatchObject({
      state: "REVOKED",
    });
  });

  it("revoking a COMMERCE reviewer grant withdraws a PAUSED enrolment too", async () => {
    const f = await fixture();
    const granted = await redeem(f);
    await asPolicyUser(f.db, 2);
    await value(
      f.db,
      "select public.change_enrolment_status($1,'PAUSED','Learner requested a pause') as v",
      [granted.enrolmentId],
    );
    await owner(f.db);
    await revoke(f, granted.entitlementId);
    expect(await enrolmentStatus(f, granted.enrolmentId)).toBe("WITHDRAWN");
  });

  it("keeps the ALREADY_ENROLLED refusal: an academic enrolment is never taken over", async () => {
    const f = await fixture();
    await asPolicyUser(f.db, 2);
    const academic = await value(
      f.db,
      "select public.create_enrolment($1,$2,'Academic registration') as v",
      [learner, f.cohortId],
    );
    await owner(f.db);
    expect(await redeem(f)).toEqual({ ok: false, code: "ALREADY_ENROLLED" });
    expect(
      await value(
        f.db,
        "select count(*)::int as v from public.commercial_v1_entitlements where learner_id=$1",
        [learner],
      ),
    ).toBe(0);
    expect(await enrolmentStatus(f, academic)).toBe("ACTIVE");
  });

  it("still runs the migration 044 capacity guard on the reviewer enrolment", async () => {
    const f = await fixture(1);
    expect(await redeem(f, 3)).toMatchObject({
      ok: true,
      path: "ACCESS_GRANTED",
    });
    await expect(redeem(f, 1)).rejects.toThrow("COHORT_FULL");
    await owner(f.db);
    expect(
      await value(
        f.db,
        "select count(*)::int as v from public.commercial_v1_entitlements where learner_id=$1",
        [learner],
      ),
    ).toBe(0);
    expect(
      await value(
        f.db,
        "select enrolment_origin as v from public.commercial_v1_entitlements where learner_id=$1",
        [foreignLearner],
      ),
    ).toBe("COMMERCE");
  });

  it("staged upgrade: a pre-046 reviewer grant stays UNKNOWN; grants after 046 are COMMERCE", async () => {
    const f = await fixture(undefined, 45);
    const before = await redeem(f, 3);
    expect(await entitlement(f, before.entitlementId)).toMatchObject({
      enrolment_origin: "UNKNOWN",
    });
    await f.db.exec(
      await readFile(
        resolve(
          "supabase/migrations/202610020046_reviewer_redemption_enrolment_provenance.sql",
        ),
        "utf8",
      ),
    );
    // No historical ownership is guessed or rewritten.
    expect(await entitlement(f, before.entitlementId)).toMatchObject({
      enrolment_origin: "UNKNOWN",
      state: "ACTIVE",
    });
    const after = await redeem(f, 1);
    expect(await entitlement(f, after.entitlementId)).toMatchObject({
      enrolment_origin: "COMMERCE",
    });
  });

  it("keeps the function's grants", async () => {
    const f = await fixture();
    expect(
      await value(
        f.db,
        "select has_function_privilege('anon','public.redeem_commercial_v1_campaign(text,text)','execute') as v",
      ),
    ).toBe(false);
    expect(
      await value(
        f.db,
        "select has_function_privilege('authenticated','public.redeem_commercial_v1_campaign(text,text)','execute') as v",
      ),
    ).toBe(true);
  });
});
