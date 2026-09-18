import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  buildCommerceFixture,
  learner,
  foreignLearner,
  asPolicyUser,
  type CommerceFixture,
} from "./commercial-v1-commerce-fixture";

const CANONICAL_MAIN = "90699d88067b0790ce38d5b205a838c757407503";
const databases: PGlite[] = [];

afterEach(async () => {
  for (const db of databases.splice(0)) await db.close();
});

async function fixture() {
  const f = await buildCommerceFixture({ throughMigration: 38 });
  databases.push(f.db);
  return f;
}

async function value<T = string>(
  db: PGlite,
  sql: string,
  args: unknown[] = [],
) {
  return (await db.query<{ v: T }>(sql, args)).rows[0].v;
}

async function owner(db: PGlite) {
  await db.exec("reset role");
}

async function asAdmin(db: PGlite) {
  await asPolicyUser(db, 2);
}

async function asLearner(db: PGlite) {
  await asPolicyUser(db, 1);
}

async function publishOffer(f: CommerceFixture) {
  await asAdmin(f.db);
  return value<string>(
    f.db,
    "select public.publish_commercial_v1_offer($1,$2,$3,$4,$5,$6) as v",
    [
      f.activationId,
      "security-plus-sy0-701",
      2999,
      "GBP",
      "Founding Security+ course",
      "Publish founding Security+ offer",
    ],
  );
}

async function createReviewerCampaign(f: CommerceFixture) {
  await asAdmin(f.db);
  return value<string>(
    f.db,
    "select public.create_commercial_v1_campaign($1,$2,$3,$4,$5,$6,$7,$8,$9) as v",
    [
      "security-plus-sy0-701",
      "reviewer-50",
      "REVIEWER_COMPLIMENTARY",
      null,
      0,
      50,
      "2026-09-20T00:00:00Z",
      "2026-10-20T00:00:00Z",
      "Reviewer access campaign",
    ],
  );
}

describe("PR21 migration integrity", () => {
  it("leaves migrations 001-037 unchanged from canonical main", () => {
    const changed = execFileSync(
      "git",
      ["diff", "--name-only", CANONICAL_MAIN, "--", "supabase/migrations"],
      { encoding: "utf8" },
    )
      .split(/\r?\n/)
      .filter(Boolean);
    const historical = changed.filter((path) => {
      const name = path.split(/[\\/]/).at(-1) ?? "";
      return name.endsWith(".sql") && Number(name.slice(8, 12)) <= 37;
    });
    expect(historical).toEqual([]);
  });
});

describe("PR21 delivery-plan and campaign authority", () => {
  it("backfills existing publication behaviour to STANDARD_6_WEEK and makes plan immutable", async () => {
    const f = await fixture();
    const offerId = await publishOffer(f);

    await owner(f.db);
    expect(
      await value(
        f.db,
        "select delivery_plan as v from public.commercial_v1_offers where id=$1",
        [offerId],
      ),
    ).toBe("STANDARD_6_WEEK");

    await expect(
      f.db.query(
        "update public.commercial_v1_offers set delivery_plan='ACCELERATED_2_WEEK' where id=$1",
        [offerId],
      ),
    ).rejects.toThrow(/immutable/i);
  });

  it("admin can define a bounded reviewer campaign, with code normalised and zero effective price", async () => {
    const f = await fixture();
    await publishOffer(f);
    const campaignId = await createReviewerCampaign(f);

    await owner(f.db);
    const campaign = (
      await f.db.query<{
        code: string;
        kind: string;
        fixed_price_amount_minor: number;
        max_redemptions: number;
      }>(
        "select code,kind,fixed_price_amount_minor,max_redemptions from public.commercial_v1_campaigns where id=$1",
        [campaignId],
      )
    ).rows[0];

    expect(campaign).toEqual({
      code: "REVIEWER-50",
      kind: "REVIEWER_COMPLIMENTARY",
      fixed_price_amount_minor: 0,
      max_redemptions: 50,
    });

    expect(
      await value<number>(
        f.db,
        "select commercial_v1_commerce_private.calculate_campaign_price(2999,'REVIEWER_COMPLIMENTARY',null,0) as v",
      ),
    ).toBe(0);
  });

  it("rejects campaigns that would increase the list price", async () => {
    const f = await fixture();
    await publishOffer(f);
    await asAdmin(f.db);

    await expect(
      f.db.query(
        "select public.create_commercial_v1_campaign($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          "security-plus-sy0-701",
          "BAD-PRICE",
          "FIXED_PRICE",
          null,
          3000,
          10,
          "2026-09-20T00:00:00Z",
          "2026-10-20T00:00:00Z",
          "Reject price increase",
        ],
      ),
    ).rejects.toThrow(/INVALID_CAMPAIGN_PRICE/);
  });

  it("a learner cannot create campaigns or read protected campaign tables directly", async () => {
    const f = await fixture();
    await publishOffer(f);
    await asLearner(f.db);

    await expect(
      f.db.query(
        "select public.create_commercial_v1_campaign($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          "security-plus-sy0-701",
          "LEARNER-CODE",
          "PERCENT_OFF",
          10,
          null,
          1,
          "2026-09-20T00:00:00Z",
          "2026-10-20T00:00:00Z",
          "Learner must not create",
        ],
      ),
    ).rejects.toThrow();

    await expect(
      f.db.query("select * from public.commercial_v1_campaigns"),
    ).rejects.toThrow();
  });

  it("schema can represent a reviewer entitlement without fabricating a paid order, but only with redemption provenance", async () => {
    const f = await fixture();
    const offerId = await publishOffer(f);
    const campaignId = await createReviewerCampaign(f);

    await owner(f.db);
    const enrolmentId = await value<string>(
      f.db,
      `insert into public.enrolments(student_id,cohort_id,programme_version_id,status)
       values($1,$2,$3,'ACTIVE') returning id as v`,
      [learner, f.cohortId, f.programmeVersionId],
    );

    const redemptionId = await value<string>(
      f.db,
      `insert into public.commercial_v1_campaign_redemptions(
         campaign_id,offer_id,learner_id,entitlement_source,effective_price_amount_minor
       ) values($1,$2,$3,'REVIEWER',0) returning id as v`,
      [campaignId, offerId, learner],
    );

    const entitlementId = await value<string>(
      f.db,
      `insert into public.commercial_v1_entitlements(
         learner_id,offer_id,activation_id,order_id,enrolment_id,source,campaign_redemption_id
       ) values($1,$2,$3,null,$4,'REVIEWER',$5) returning id as v`,
      [learner, offerId, f.activationId, enrolmentId, redemptionId],
    );
    expect(entitlementId).toBeTruthy();

    await expect(
      f.db.query(
        `insert into public.commercial_v1_entitlements(
           learner_id,offer_id,activation_id,order_id,enrolment_id,source,campaign_redemption_id
         ) values($1,$2,$3,null,$4,'REVIEWER',null)`,
        [learner, offerId, f.activationId, enrolmentId],
      ),
    ).rejects.toThrow();
  });

  it("binds campaign provenance to the same learner, offer and entitlement source", async () => {
    const f = await fixture();
    const offerId = await publishOffer(f);
    const campaignId = await createReviewerCampaign(f);

    await owner(f.db);
    const foreignEnrolmentId = await value<string>(
      f.db,
      `insert into public.enrolments(student_id,cohort_id,programme_version_id,status)
       values($1,$2,$3,'ACTIVE') returning id as v`,
      [foreignLearner, f.cohortId, f.programmeVersionId],
    );
    const learnerRedemptionId = await value<string>(
      f.db,
      `insert into public.commercial_v1_campaign_redemptions(
         campaign_id,offer_id,learner_id,entitlement_source,effective_price_amount_minor
       ) values($1,$2,$3,'REVIEWER',0) returning id as v`,
      [campaignId, offerId, learner],
    );

    await expect(
      f.db.query(
        `insert into public.commercial_v1_entitlements(
           learner_id,offer_id,activation_id,order_id,enrolment_id,source,campaign_redemption_id
         ) values($1,$2,$3,null,$4,'REVIEWER',$5)`,
        [
          foreignLearner,
          offerId,
          f.activationId,
          foreignEnrolmentId,
          learnerRedemptionId,
        ],
      ),
    ).rejects.toThrow();

    const foreignRedemptionId = await value<string>(
      f.db,
      `insert into public.commercial_v1_campaign_redemptions(
         campaign_id,offer_id,learner_id,entitlement_source,effective_price_amount_minor
       ) values($1,$2,$3,'PROMOTIONAL',0) returning id as v`,
      [campaignId, offerId, foreignLearner],
    );
    await expect(
      f.db.query(
        `insert into public.commercial_v1_entitlements(
           learner_id,offer_id,activation_id,order_id,enrolment_id,source,campaign_redemption_id
         ) values($1,$2,$3,null,$4,'REVIEWER',$5)`,
        [
          foreignLearner,
          offerId,
          f.activationId,
          foreignEnrolmentId,
          foreignRedemptionId,
        ],
      ),
    ).rejects.toThrow();
  });

  it("campaign archival is one-way and preserves immutable pricing terms", async () => {
    const f = await fixture();
    await publishOffer(f);
    const campaignId = await createReviewerCampaign(f);

    await asAdmin(f.db);
    expect(
      await value(
        f.db,
        "select public.archive_commercial_v1_campaign($1,$2) as v",
        ["REVIEWER-50", "Reviewer campaign finished"],
      ),
    ).toBe(campaignId);

    await owner(f.db);
    await expect(
      f.db.query(
        "update public.commercial_v1_campaigns set state='ACTIVE',archived_at=null,archived_by=null where id=$1",
        [campaignId],
      ),
    ).rejects.toThrow(/cannot be reactivated/i);

    await expect(
      f.db.query(
        "update public.commercial_v1_campaigns set max_redemptions=99 where id=$1",
        [campaignId],
      ),
    ).rejects.toThrow(/immutable/i);
  });
});
