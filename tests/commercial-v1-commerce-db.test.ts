import { randomUUID, randomBytes, createHmac } from "node:crypto";
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

const CANONICAL_BASE = "bedfcf905cc9e424753a2bf6240997464eaac16c";

const databases: PGlite[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) await db.close();
});
async function fixture() {
  const f = await buildCommerceFixture();
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
async function row<T>(db: PGlite, sql: string, args: unknown[] = []) {
  return (await db.query<T>(sql, args)).rows[0];
}
async function owner(db: PGlite) {
  await db.exec("reset role");
}
async function asLearner(db: PGlite) {
  await asPolicyUser(db, 1);
}
async function asAdmin(db: PGlite) {
  await asPolicyUser(db, 2);
}
async function asForeign(db: PGlite) {
  await asPolicyUser(db, 3);
}
// A genuinely anonymous session: PGlite reuses ONE connection across role
// switches within a test, so a prior asAdmin()/asLearner() call's JWT
// claim otherwise leaks into a later "anon" role switch (a real Supabase/
// PostgREST anon request carries no such claim at all). Clearing it first
// is what makes anon-role assertions about current_app_user()/viewer state
// meaningful rather than accidentally still-authenticated.
async function asAnon(db: PGlite) {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub','',false)");
  await db.exec("set role anon");
}

async function installControllerKey(f: CommerceFixture) {
  const keyId = randomUUID();
  const key = randomBytes(32);
  await owner(f.db);
  await f.db.query(
    "select commercial_v1_commerce_private.install_controller_key($1,$2::bytea)",
    [keyId, key],
  );
  return { keyId, key };
}

function signClaim(
  key: Buffer,
  fields: {
    keyId: string;
    orderId: string;
    provider?: string;
    sessionId: string;
    eventId: string;
    amount: number;
    currency: string;
    status: string;
    issuedAt: number;
    expiresAt: number;
  },
) {
  const canonical = [
    "DUCELIO_COMMERCE_FULFILLMENT_HMAC_SHA256_V1",
    "COMMERCIAL_V1_COMMERCE_V1",
    fields.keyId.toLowerCase(),
    fields.provider ?? "STRIPE",
    fields.orderId.toLowerCase(),
    fields.sessionId,
    fields.eventId,
    String(fields.amount),
    fields.currency,
    fields.status,
    String(fields.issuedAt),
    String(fields.expiresAt),
  ].join("\n");
  return createHmac("sha256", key).update(canonical, "utf8").digest("hex");
}

function claimArgs(
  keyId: string,
  key: Buffer,
  overrides: Partial<{
    orderId: string;
    provider: string;
    sessionId: string;
    eventId: string;
    amount: number;
    currency: string;
    status: string;
    issuedAt: number;
    expiresAt: number;
    mac: string;
  }> = {},
) {
  const now = Math.floor(Date.now() / 1000);
  const fields = {
    keyId,
    orderId: overrides.orderId ?? randomUUID(),
    provider: overrides.provider ?? "STRIPE",
    sessionId: overrides.sessionId ?? "cs_test_" + randomUUID(),
    eventId: overrides.eventId ?? "evt_test_" + randomUUID(),
    amount: overrides.amount ?? 19900,
    currency: overrides.currency ?? "GBP",
    status: overrides.status ?? "PAID",
    issuedAt: overrides.issuedAt ?? now,
    expiresAt: overrides.expiresAt ?? now + 60,
  };
  const mac = overrides.mac ?? signClaim(key, fields);
  return [
    keyId,
    fields.orderId,
    fields.provider,
    fields.sessionId,
    fields.eventId,
    fields.amount,
    fields.currency,
    fields.status,
    fields.issuedAt,
    fields.expiresAt,
    mac,
  ];
}
async function fulfill(db: PGlite, args: unknown[]) {
  return value<Record<string, unknown>>(
    db,
    "select public.fulfill_commercial_v1_order($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) as v",
    args,
  );
}

async function publishOffer(
  f: CommerceFixture,
  overrides: Partial<{
    slug: string;
    priceAmountMinor: number;
    currency: string;
    summary: string | null;
    reason: string;
  }> = {},
) {
  await asAdmin(f.db);
  return value<string>(
    f.db,
    "select public.publish_commercial_v1_offer($1,$2,$3,$4,$5,$6) as v",
    [
      f.activationId,
      overrides.slug ?? "cybersecurity-foundations",
      overrides.priceAmountMinor ?? 19900,
      overrides.currency ?? "GBP",
      overrides.summary ?? "A hands-on introduction.",
      overrides.reason ?? "Publish the first cohort",
    ],
  );
}
async function createOrder(db: PGlite, slug = "cybersecurity-foundations") {
  return value<Record<string, unknown>>(
    db,
    "select public.create_commercial_v1_order($1) as v",
    [slug],
  );
}

// Owner-authority direct enrolment seeding for a given status -- mirrors
// the PR11/PR12-sanctioned direct-insert fixture pattern. Used to place a
// learner into ACTIVE/PAUSED/COMPLETED/WITHDRAWN academic standing
// WITHOUT going through commerce, exactly the "comped seat" / "pre-
// existing academic record" scenario Section 4 must independently guard
// against.
async function seedEnrolment(
  f: CommerceFixture,
  studentId: string,
  status: "ACTIVE" | "PAUSED" | "COMPLETED" | "WITHDRAWN",
) {
  await owner(f.db);
  const id = await value<string>(
    f.db,
    `insert into public.enrolments(student_id,cohort_id,programme_version_id,status)
     values($1,$2,$3,$4) returning id as v`,
    [studentId, f.cohortId, f.programmeVersionId, status],
  );
  return id;
}

describe("Migration integrity", () => {
  it("migrations 001-033 have zero diff against the canonical base SHA; only migration 034 may be added", () => {
    const changed = execFileSync(
      "git",
      ["diff", "--name-only", CANONICAL_BASE, "--", "supabase/migrations"],
      { encoding: "utf8" },
    )
      .split(/\r?\n/)
      .filter(Boolean);
    const historical = changed.filter((path) => {
      const name = path.split(/[\\/]/).at(-1) ?? "";
      return name.endsWith(".sql") && Number(name.slice(8, 12)) <= 33;
    });
    expect(historical).toEqual([]);
  });
});

describe("Public offer catalogue", () => {
  it("an anonymous caller sees only public-safe fields for a published offer", async () => {
    const f = await fixture();
    await publishOffer(f);
    await asAnon(f.db);
    const result = await value<Record<string, unknown>>(
      f.db,
      "select public.get_commercial_v1_offer($1) as v",
      ["cybersecurity-foundations"],
    );
    expect(result).toMatchObject({
      ok: true,
      slug: "cybersecurity-foundations",
      priceAmountMinor: 19900,
      currency: "GBP",
      viewerAuthenticated: false,
      viewerEntitled: false,
    });
    await f.db.exec("reset role");
  });

  it("an unpublished/unknown slug returns a bounded NOT_FOUND, never an error leaking existence", async () => {
    const f = await fixture();
    await asAnon(f.db);
    const result = await value<Record<string, unknown>>(
      f.db,
      "select public.get_commercial_v1_offer($1) as v",
      ["does-not-exist"],
    );
    expect(result).toEqual({ ok: false, code: "NOT_FOUND" });
    await f.db.exec("reset role");
  });

  it("an archived offer no longer appears in the catalogue and cannot be purchased", async () => {
    const f = await fixture();
    await publishOffer(f);
    await asAdmin(f.db);
    await f.db.query("select public.archive_commercial_v1_offer($1,$2)", [
      "cybersecurity-foundations",
      "Re-pricing for the next cohort",
    ]);
    await asAnon(f.db);
    const list = await value<unknown[]>(
      f.db,
      "select public.list_commercial_v1_offers() as v",
    );
    expect(list).toEqual([]);
    await f.db.exec("reset role");
    await asLearner(f.db);
    const order = await createOrder(f.db);
    expect(order).toEqual({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
  });

  it("no protected academic content (answer keys, marking guidance, provider output) ever crosses the public projection", async () => {
    const f = await fixture();
    await publishOffer(f);
    await asAnon(f.db);
    const result = await value<Record<string, unknown>>(
      f.db,
      "select public.get_commercial_v1_offer($1) as v",
      ["cybersecurity-foundations"],
    );
    const text = JSON.stringify(result);
    expect(text).not.toMatch(
      /expectedAnswer|markingGuidance|providerOutput|agentConfiguration|instructionalNotes/i,
    );
    await f.db.exec("reset role");
  });
});

describe("Offer publication authority", () => {
  it("an authorized admin can publish and archive", async () => {
    const f = await fixture();
    const offerId = await publishOffer(f);
    expect(offerId).toMatch(/^[0-9a-f-]{36}$/);
    await asAdmin(f.db);
    const archived = await value<string>(
      f.db,
      "select public.archive_commercial_v1_offer($1,$2) as v",
      ["cybersecurity-foundations", "Re-pricing"],
    );
    expect(archived).toBe(offerId);
  });

  it("a student cannot publish an offer", async () => {
    const f = await fixture();
    await asLearner(f.db);
    await expect(
      f.db.query(
        "select public.publish_commercial_v1_offer($1,$2,$3,$4,$5,$6)",
        [
          f.activationId,
          "cybersecurity-foundations",
          19900,
          "GBP",
          null,
          "Attempted student publish",
        ],
      ),
    ).rejects.toThrow();
  });

  it("anon cannot publish an offer", async () => {
    const f = await fixture();
    await asAnon(f.db);
    await expect(
      f.db.query(
        "select public.publish_commercial_v1_offer($1,$2,$3,$4,$5,$6)",
        [
          f.activationId,
          "cybersecurity-foundations",
          19900,
          "GBP",
          null,
          "Attempted anon publish",
        ],
      ),
    ).rejects.toThrow();
    await f.db.exec("reset role");
  });

  it("only one PUBLISHED offer may exist per activation at a time", async () => {
    const f = await fixture();
    await publishOffer(f);
    await asAdmin(f.db);
    await expect(
      f.db.query(
        "select public.publish_commercial_v1_offer($1,$2,$3,$4,$5,$6)",
        [
          f.activationId,
          "cybersecurity-foundations-2",
          29900,
          "GBP",
          null,
          "Attempted duplicate publish",
        ],
      ),
    ).rejects.toThrow("ALREADY_PUBLISHED");
  });

  it("V2 correction (item 10): the admin activation-listing read only works for an admin and reveals which activations already have a published offer", async () => {
    const f = await fixture();
    await publishOffer(f);
    await asAdmin(f.db);
    const list = await value<
      { activationId: string; publishedOfferSlug: string | null }[]
    >(f.db, "select public.list_commercial_v1_offer_activations() as v");
    const mine = list.find((a) => a.activationId === f.activationId);
    expect(mine?.publishedOfferSlug).toBe("cybersecurity-foundations");
    await asLearner(f.db);
    await expect(
      f.db.query("select public.list_commercial_v1_offer_activations()"),
    ).rejects.toThrow();
  });
});

describe("Offer/order immutability", () => {
  it("an offer's price/currency/activation cannot be changed after creation", async () => {
    const f = await fixture();
    const offerId = await publishOffer(f);
    await owner(f.db);
    await expect(
      f.db.query(
        "update public.commercial_v1_offers set price_amount_minor=1 where id=$1",
        [offerId],
      ),
    ).rejects.toThrow("immutable");
  });

  it("an archived offer can never be republished", async () => {
    const f = await fixture();
    const offerId = await publishOffer(f);
    await asAdmin(f.db);
    await f.db.query("select public.archive_commercial_v1_offer($1,$2)", [
      "cybersecurity-foundations",
      "Re-pricing",
    ]);
    await owner(f.db);
    await expect(
      f.db.query(
        "update public.commercial_v1_offers set state='PUBLISHED' where id=$1",
        [offerId],
      ),
    ).rejects.toThrow("archived");
  });

  it("V2 correction (item 1 defensive proof): an order's financial identity/session cannot be silently rewritten", async () => {
    const f = await fixture();
    await publishOffer(f);
    await asLearner(f.db);
    const order = (await createOrder(f.db)) as { orderId: string };
    await owner(f.db);
    await expect(
      f.db.query(
        "update public.commercial_v1_orders set amount_minor=1 where id=$1",
        [order.orderId],
      ),
    ).rejects.toThrow("immutable");
    await f.db.query(
      "update public.commercial_v1_orders set provider_session_id='cs_first' where id=$1",
      [order.orderId],
    );
    await expect(
      f.db.query(
        "update public.commercial_v1_orders set provider_session_id='cs_second' where id=$1",
        [order.orderId],
      ),
    ).rejects.toThrow("cannot be replaced");
  });

  it("payment_events and entitlements are append-only", async () => {
    const f = await fixture();
    await publishOffer(f);
    await asLearner(f.db);
    const order = (await createOrder(f.db)) as { orderId: string };
    const { keyId, key } = await installControllerKey(f);
    await owner(f.db);
    await asAnon(f.db);
    await fulfill(
      f.db,
      claimArgs(keyId, key, { orderId: order.orderId, status: "PAID" }),
    );
    await f.db.exec("reset role");
    const eventId = await value<string>(
      f.db,
      "select id as v from public.commercial_v1_payment_events limit 1",
    );
    await expect(
      f.db.query(
        "update public.commercial_v1_payment_events set status='UNPAID' where id=$1",
        [eventId],
      ),
    ).rejects.toThrow("append-only");
    const entitlementId = await value<string>(
      f.db,
      "select id as v from public.commercial_v1_entitlements limit 1",
    );
    await expect(
      f.db.query("delete from public.commercial_v1_entitlements where id=$1", [
        entitlementId,
      ]),
    ).rejects.toThrow("append-only");
  });
});

describe("Order creation authority (Section 9)", () => {
  it("anonymous cannot create an order", async () => {
    const f = await fixture();
    await publishOffer(f);
    await asAnon(f.db);
    await expect(
      f.db.query("select public.create_commercial_v1_order($1)", [
        "cybersecurity-foundations",
      ]),
    ).rejects.toThrow();
    await f.db.exec("reset role");
  });

  it("the RPC has no student/amount/currency/cohort parameter at all -- a browser cannot buy for another learner or choose different terms", async () => {
    const f = await fixture();
    await publishOffer(f);
    await asLearner(f.db);
    await expect(
      f.db.query("select public.create_commercial_v1_order($1,$2,$3,$4)", [
        "cybersecurity-foundations",
        foreignLearner,
        1,
        "USD",
      ]),
    ).rejects.toThrow();
  });

  it("amount/currency/activation are derived entirely from the DB-authoritative offer, never request input", async () => {
    const f = await fixture();
    await publishOffer(f, { priceAmountMinor: 24999, currency: "eur" });
    await asLearner(f.db);
    const order = (await createOrder(f.db)) as {
      amountMinor: number;
      currency: string;
      activationId: string;
    };
    expect(order.amountMinor).toBe(24999);
    expect(order.currency).toBe("EUR");
    expect(order.activationId).toBe(f.activationId);
  });

  it("the offer fixes the exact cohort/programme version -- the order snapshot matches the activation's own cohort", async () => {
    const f = await fixture();
    await publishOffer(f);
    await asLearner(f.db);
    const order = (await createOrder(f.db)) as { orderId: string };
    await owner(f.db);
    const persisted = await row<{
      cohort_id: string;
      programme_version_id: string;
    }>(
      f.db,
      "select cohort_id,programme_version_id from public.commercial_v1_orders where id=$1",
      [order.orderId],
    );
    expect(persisted.cohort_id).toBe(f.cohortId);
    expect(persisted.programme_version_id).toBe(f.programmeVersionId);
  });

  it("retrying checkout for the same offer reuses the same PENDING order (bounded idempotency)", async () => {
    const f = await fixture();
    await publishOffer(f);
    await asLearner(f.db);
    const first = (await createOrder(f.db)) as {
      orderId: string;
      reused: boolean;
    };
    const second = (await createOrder(f.db)) as {
      orderId: string;
      reused: boolean;
    };
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.orderId).toBe(first.orderId);
    await owner(f.db);
    const count = await value<string>(
      f.db,
      "select count(*)::text as v from public.commercial_v1_orders where learner_id=$1",
      [learner],
    );
    expect(count).toBe("1");
  });
});

describe("Existing enrolment/entitlement prevents purchase (V2 correction, item 4)", () => {
  it("already entitled cannot create a fresh checkout", async () => {
    const f = await fixture();
    await publishOffer(f);
    const { keyId, key } = await installControllerKey(f);
    await asLearner(f.db);
    const order = (await createOrder(f.db)) as { orderId: string };
    await asAnon(f.db);
    await fulfill(
      f.db,
      claimArgs(keyId, key, { orderId: order.orderId, status: "PAID" }),
    );
    await asLearner(f.db);
    const second = await createOrder(f.db);
    expect(second).toEqual({ ok: false, code: "ALREADY_ENTITLED" });
  });

  it("an already ACTIVE-enrolled learner (e.g. a comped seat, no entitlement row at all) cannot purchase again", async () => {
    const f = await fixture();
    await publishOffer(f);
    await seedEnrolment(f, learner, "ACTIVE");
    await asLearner(f.db);
    const order = await createOrder(f.db);
    expect(order).toEqual({ ok: false, code: "ALREADY_ENROLLED" });
  });

  it("an already PAUSED learner cannot purchase again", async () => {
    const f = await fixture();
    await publishOffer(f);
    await seedEnrolment(f, learner, "PAUSED");
    await asLearner(f.db);
    const order = await createOrder(f.db);
    expect(order).toEqual({ ok: false, code: "ALREADY_ENROLLED" });
  });

  it("an already COMPLETED learner cannot purchase again", async () => {
    const f = await fixture();
    await publishOffer(f);
    await seedEnrolment(f, learner, "COMPLETED");
    await asLearner(f.db);
    const order = await createOrder(f.db);
    expect(order).toEqual({ ok: false, code: "ALREADY_ENROLLED" });
  });

  it("a WITHDRAWN learner requires support and cannot purchase a fresh reactivation", async () => {
    const f = await fixture();
    await publishOffer(f);
    await seedEnrolment(f, learner, "WITHDRAWN");
    await asLearner(f.db);
    const order = await createOrder(f.db);
    expect(order).toEqual({ ok: false, code: "ENROLMENT_REQUIRES_SUPPORT" });
    await owner(f.db);
    const count = await value<string>(
      f.db,
      "select count(*)::text as v from public.commercial_v1_orders where learner_id=$1",
      [learner],
    );
    expect(count).toBe("0");
  });
});

describe("Controller/HMAC claim verification (Section 5/6)", () => {
  it("an invalid/forged signature is denied and mutates nothing", async () => {
    const f = await fixture();
    await publishOffer(f);
    const { keyId, key } = await installControllerKey(f);
    await asLearner(f.db);
    const order = (await createOrder(f.db)) as { orderId: string };
    await asAnon(f.db);
    const args = claimArgs(keyId, key, { orderId: order.orderId });
    args[10] = "0".repeat(64);
    const result = await fulfill(f.db, args);
    expect(result).toEqual({ ok: false, code: "UNTRUSTED_CLAIM" });
    await f.db.exec("reset role");
    const state = await value<string>(
      f.db,
      "select state as v from public.commercial_v1_orders where id=$1",
      [order.orderId],
    );
    expect(state).toBe("PENDING");
  });

  it("an expired claim (issued/expires outside the trusted window) is denied", async () => {
    const f = await fixture();
    await publishOffer(f);
    const { keyId, key } = await installControllerKey(f);
    await asLearner(f.db);
    const order = (await createOrder(f.db)) as { orderId: string };
    await asAnon(f.db);
    const longAgo = Math.floor(Date.now() / 1000) - 10_000;
    const result = await fulfill(
      f.db,
      claimArgs(keyId, key, {
        orderId: order.orderId,
        issuedAt: longAgo,
        expiresAt: longAgo + 60,
      }),
    );
    expect(result).toEqual({ ok: false, code: "UNTRUSTED_CLAIM" });
    await f.db.exec("reset role");
  });

  it("a revoked controller key is denied even with an otherwise valid signature", async () => {
    const f = await fixture();
    await publishOffer(f);
    const { keyId, key } = await installControllerKey(f);
    await asLearner(f.db);
    const order = (await createOrder(f.db)) as { orderId: string };
    await owner(f.db);
    await f.db.query(
      "update commercial_v1_commerce_private.controller_keys set revoked_at=clock_timestamp() where id=$1",
      [keyId],
    );
    await asAnon(f.db);
    const result = await fulfill(
      f.db,
      claimArgs(keyId, key, { orderId: order.orderId }),
    );
    expect(result).toEqual({ ok: false, code: "UNTRUSTED_CLAIM" });
    await f.db.exec("reset role");
  });

  it("direct browser RPC cannot mark an order PAID/FULFILLED -- neither anon nor authenticated can UPDATE the table directly", async () => {
    const f = await fixture();
    await publishOffer(f);
    await asLearner(f.db);
    const order = (await createOrder(f.db)) as { orderId: string };
    await asAnon(f.db);
    await expect(
      f.db.query(
        "update public.commercial_v1_orders set state='FULFILLED' where id=$1",
        [order.orderId],
      ),
    ).rejects.toThrow("permission denied");
    await f.db.exec("reset role");
    await asLearner(f.db);
    await expect(
      f.db.query(
        "update public.commercial_v1_orders set state='FULFILLED' where id=$1",
        [order.orderId],
      ),
    ).rejects.toThrow("permission denied");
  });
});

describe("Atomic fulfillment matching (Section 6)", () => {
  async function newOrder(f: CommerceFixture) {
    await publishOffer(f);
    await asLearner(f.db);
    return (await createOrder(f.db)) as {
      orderId: string;
      amountMinor: number;
      currency: string;
    };
  }

  it("a valid claim that exactly matches the order is accepted and atomically creates one entitlement and one enrolment", async () => {
    const f = await fixture();
    const order = await newOrder(f);
    const { keyId, key } = await installControllerKey(f);
    await asAnon(f.db);
    const result = await fulfill(
      f.db,
      claimArgs(keyId, key, {
        orderId: order.orderId,
        amount: order.amountMinor,
        currency: order.currency,
        status: "PAID",
      }),
    );
    expect(result).toMatchObject({ ok: true, fulfilled: true, replay: false });
    await f.db.exec("reset role");
    const enrolment = await row<{ status: string; student_id: string }>(
      f.db,
      "select status,student_id from public.enrolments where student_id=$1 and cohort_id=$2",
      [learner, f.cohortId],
    );
    expect(enrolment.status).toBe("ACTIVE");
    const entitlementCount = await value<string>(
      f.db,
      "select count(*)::text as v from public.commercial_v1_entitlements where learner_id=$1",
      [learner],
    );
    expect(entitlementCount).toBe("1");
  });

  it("mismatched session id is denied and mutates nothing", async () => {
    const f = await fixture();
    const order = await newOrder(f);
    const { keyId, key } = await installControllerKey(f);
    await asAnon(f.db);
    // Bind a session first.
    await fulfill(
      f.db,
      claimArgs(keyId, key, {
        orderId: order.orderId,
        sessionId: "cs_real_session",
        amount: order.amountMinor,
        currency: order.currency,
        status: "UNPAID",
      }),
    );
    const result = await fulfill(
      f.db,
      claimArgs(keyId, key, {
        orderId: order.orderId,
        sessionId: "cs_DIFFERENT_session",
        amount: order.amountMinor,
        currency: order.currency,
        status: "PAID",
      }),
    );
    expect(result).toEqual({ ok: false, code: "MISMATCHED_SESSION" });
    await f.db.exec("reset role");
    const entitlementCount = await value<string>(
      f.db,
      "select count(*)::text as v from public.commercial_v1_entitlements where learner_id=$1",
      [learner],
    );
    expect(entitlementCount).toBe("0");
  });

  it("mismatched amount is denied and creates no entitlement", async () => {
    const f = await fixture();
    const order = await newOrder(f);
    const { keyId, key } = await installControllerKey(f);
    await asAnon(f.db);
    const result = await fulfill(
      f.db,
      claimArgs(keyId, key, {
        orderId: order.orderId,
        amount: order.amountMinor + 1,
        currency: order.currency,
        status: "PAID",
      }),
    );
    expect(result).toEqual({ ok: false, code: "MISMATCHED_AMOUNT" });
  });

  it("mismatched currency is denied and creates no entitlement", async () => {
    const f = await fixture();
    const order = await newOrder(f);
    const { keyId, key } = await installControllerKey(f);
    await asAnon(f.db);
    const result = await fulfill(
      f.db,
      claimArgs(keyId, key, {
        orderId: order.orderId,
        amount: order.amountMinor,
        currency: "USD",
        status: "PAID",
      }),
    );
    expect(result).toEqual({ ok: false, code: "MISMATCHED_CURRENCY" });
  });

  it("UNPAID never creates an entitlement, but records bounded provenance and leaves the order PENDING", async () => {
    const f = await fixture();
    const order = await newOrder(f);
    const { keyId, key } = await installControllerKey(f);
    await asAnon(f.db);
    const result = await fulfill(
      f.db,
      claimArgs(keyId, key, {
        orderId: order.orderId,
        amount: order.amountMinor,
        currency: order.currency,
        status: "UNPAID",
      }),
    );
    expect(result).toEqual({
      ok: true,
      fulfilled: false,
      code: "NOT_PAID",
      orderId: order.orderId,
    });
    await f.db.exec("reset role");
    const state = await value<string>(
      f.db,
      "select state as v from public.commercial_v1_orders where id=$1",
      [order.orderId],
    );
    expect(state).toBe("PENDING");
    const entitlementCount = await value<string>(
      f.db,
      "select count(*)::text as v from public.commercial_v1_entitlements where learner_id=$1",
      [learner],
    );
    expect(entitlementCount).toBe("0");
    const eventCount = await value<string>(
      f.db,
      "select count(*)::text as v from public.commercial_v1_payment_events where order_id=$1",
      [order.orderId],
    );
    expect(eventCount).toBe("1");
  });

  it("a duplicate verified event id is idempotent -- no duplicate payment_events row, no duplicate entitlement", async () => {
    const f = await fixture();
    const order = await newOrder(f);
    const { keyId, key } = await installControllerKey(f);
    const sharedEventId = "evt_test_" + randomUUID();
    const sharedSessionId = "cs_test_" + randomUUID();
    await asAnon(f.db);
    const first = await fulfill(
      f.db,
      claimArgs(keyId, key, {
        orderId: order.orderId,
        sessionId: sharedSessionId,
        eventId: sharedEventId,
        amount: order.amountMinor,
        currency: order.currency,
        status: "PAID",
      }),
    );
    const second = await fulfill(
      f.db,
      claimArgs(keyId, key, {
        orderId: order.orderId,
        sessionId: sharedSessionId,
        eventId: sharedEventId,
        amount: order.amountMinor,
        currency: order.currency,
        status: "PAID",
      }),
    );
    expect(first).toMatchObject({ ok: true, fulfilled: true, replay: false });
    expect(second).toMatchObject({ ok: true, fulfilled: true, replay: true });
    expect(second).toMatchObject({
      entitlementId: (first as Record<string, unknown>).entitlementId,
      enrolmentId: (first as Record<string, unknown>).enrolmentId,
    });
    await f.db.exec("reset role");
    const eventCount = await value<string>(
      f.db,
      "select count(*)::text as v from public.commercial_v1_payment_events where order_id=$1",
      [order.orderId],
    );
    expect(eventCount).toBe("1");
    const entitlementCount = await value<string>(
      f.db,
      "select count(*)::text as v from public.commercial_v1_entitlements where learner_id=$1",
      [learner],
    );
    expect(entitlementCount).toBe("1");
  });

  it("webhook + success-page reconciliation converge idempotently: two DIFFERENT event ids for the SAME order/session never duplicate entitlement/enrolment", async () => {
    const f = await fixture();
    const order = await newOrder(f);
    const { keyId, key } = await installControllerKey(f);
    await asAnon(f.db);
    const webhookLike = await fulfill(
      f.db,
      claimArgs(keyId, key, {
        orderId: order.orderId,
        sessionId: "cs_shared_session",
        eventId: "evt_webhook_real",
        amount: order.amountMinor,
        currency: order.currency,
        status: "PAID",
      }),
    );
    const reconciliationLike = await fulfill(
      f.db,
      claimArgs(keyId, key, {
        orderId: order.orderId,
        sessionId: "cs_shared_session",
        eventId: "SESSION_VERIFY:cs_shared_session",
        amount: order.amountMinor,
        currency: order.currency,
        status: "PAID",
      }),
    );
    expect(webhookLike).toMatchObject({
      ok: true,
      fulfilled: true,
      replay: false,
    });
    expect(reconciliationLike).toMatchObject({
      ok: true,
      fulfilled: true,
      replay: true,
    });
    expect(reconciliationLike).toMatchObject({
      entitlementId: (webhookLike as Record<string, unknown>).entitlementId,
    });
    await f.db.exec("reset role");
    const entitlementCount = await value<string>(
      f.db,
      "select count(*)::text as v from public.commercial_v1_entitlements where learner_id=$1",
      [learner],
    );
    expect(entitlementCount).toBe("1");
    const enrolmentCount = await value<string>(
      f.db,
      "select count(*)::text as v from public.enrolments where student_id=$1 and cohort_id=$2",
      [learner, f.cohortId],
    );
    expect(enrolmentCount).toBe("1");
  });

  it("V2 correction (item 5): fulfillment does not reactivate a PAUSED enrolment discovered only at fulfillment time (race with a concurrent academic action)", async () => {
    const f = await fixture();
    const order = await newOrder(f);
    // Simulate a race: the learner's cohort enrolment is paused by an
    // admin AFTER order creation but BEFORE fulfillment.
    await seedEnrolment(f, learner, "PAUSED");
    const { keyId, key } = await installControllerKey(f);
    await asAnon(f.db);
    const result = await fulfill(
      f.db,
      claimArgs(keyId, key, {
        orderId: order.orderId,
        amount: order.amountMinor,
        currency: order.currency,
        status: "PAID",
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      code: "ENROLMENT_NOT_ACTIVATABLE",
    });
    await f.db.exec("reset role");
    const enrolment = await row<{ status: string }>(
      f.db,
      "select status from public.enrolments where student_id=$1 and cohort_id=$2",
      [learner, f.cohortId],
    );
    expect(enrolment.status).toBe("PAUSED");
    const entitlementCount = await value<string>(
      f.db,
      "select count(*)::text as v from public.commercial_v1_entitlements where learner_id=$1",
      [learner],
    );
    expect(entitlementCount).toBe("0");
  });

  it("V2 correction (item 5): fulfillment does not reactivate a WITHDRAWN enrolment discovered only at fulfillment time", async () => {
    const f = await fixture();
    const order = await newOrder(f);
    await seedEnrolment(f, learner, "WITHDRAWN");
    const { keyId, key } = await installControllerKey(f);
    await asAnon(f.db);
    const result = await fulfill(
      f.db,
      claimArgs(keyId, key, {
        orderId: order.orderId,
        amount: order.amountMinor,
        currency: order.currency,
        status: "PAID",
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      code: "ENROLMENT_NOT_ACTIVATABLE",
    });
  });

  it("V2 correction (item 11): a second successful payment for the SAME course reuses the existing entitlement, never fails Zod parsing with a null id, and a replay of that SECOND order still resolves the same entitlement", async () => {
    const f = await fixture();
    const order = await newOrder(f);
    const { keyId, key } = await installControllerKey(f);
    await asAnon(f.db);
    const firstResult = (await fulfill(
      f.db,
      claimArgs(keyId, key, {
        orderId: order.orderId,
        amount: order.amountMinor,
        currency: order.currency,
        status: "PAID",
      }),
    )) as Record<string, unknown>;

    // A second, INDEPENDENT order for the same offer/learner -- this
    // requires seeding a second order directly (create_commercial_v1_order
    // would itself now refuse, per item 4), simulating a genuine duplicate-
    // payment edge case rather than the normal path.
    await owner(f.db);
    const offerId = await value<string>(
      f.db,
      "select id as v from public.commercial_v1_offers where slug='cybersecurity-foundations'",
    );
    const secondOrderId = await value<string>(
      f.db,
      `insert into public.commercial_v1_orders(learner_id,offer_id,activation_id,cohort_id,programme_version_id,amount_minor,currency)
       values($1,$2,$3,$4,$5,$6,$7) returning id as v`,
      [
        learner,
        offerId,
        f.activationId,
        f.cohortId,
        f.programmeVersionId,
        order.amountMinor,
        order.currency,
      ],
    );
    await asAnon(f.db);
    const secondOrderSessionId = "cs_test_" + randomUUID();
    const secondResult = (await fulfill(
      f.db,
      claimArgs(keyId, key, {
        orderId: secondOrderId,
        sessionId: secondOrderSessionId,
        amount: order.amountMinor,
        currency: order.currency,
        status: "PAID",
      }),
    )) as Record<string, unknown>;
    expect(secondResult.ok).toBe(true);
    expect(secondResult.fulfilled).toBe(true);
    expect(secondResult.entitlementId).toBe(firstResult.entitlementId);
    expect(secondResult.enrolmentId).toBe(firstResult.enrolmentId);

    // Replaying the SECOND order must still resolve a real (non-null)
    // entitlement/enrolment -- the exact regression finding 11 describes.
    const replay = (await fulfill(
      f.db,
      claimArgs(keyId, key, {
        orderId: secondOrderId,
        sessionId: secondOrderSessionId,
        amount: order.amountMinor,
        currency: order.currency,
        status: "PAID",
      }),
    )) as Record<string, unknown>;
    expect(replay.entitlementId).toBe(firstResult.entitlementId);
    expect(replay.enrolmentId).toBe(firstResult.enrolmentId);
    expect(replay.entitlementId).not.toBeNull();
    expect(replay.enrolmentId).not.toBeNull();

    await f.db.exec("reset role");
    const entitlementCount = await value<string>(
      f.db,
      "select count(*)::text as v from public.commercial_v1_entitlements where learner_id=$1",
      [learner],
    );
    expect(entitlementCount).toBe("1");
  });
});

describe("Learner/foreign-learner scoping (Section 9)", () => {
  it("get_commercial_v1_order is self-or-admin scoped -- a foreign learner cannot read another learner's order", async () => {
    const f = await fixture();
    await publishOffer(f);
    await asLearner(f.db);
    const order = (await createOrder(f.db)) as { orderId: string };
    await asForeign(f.db);
    const result = await value<Record<string, unknown>>(
      f.db,
      "select public.get_commercial_v1_order($1) as v",
      [order.orderId],
    );
    expect(result).toEqual({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
  });

  it("a foreign learner cannot bind a checkout session onto another learner's order", async () => {
    const f = await fixture();
    await publishOffer(f);
    await asLearner(f.db);
    const order = (await createOrder(f.db)) as { orderId: string };
    await asForeign(f.db);
    const result = await value<Record<string, unknown>>(
      f.db,
      "select public.attach_commercial_v1_checkout_session($1,$2) as v",
      [order.orderId, "cs_forged"],
    );
    expect(result).toEqual({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
  });

  it("an admin CAN read any learner's order", async () => {
    const f = await fixture();
    await publishOffer(f);
    await asLearner(f.db);
    const order = (await createOrder(f.db)) as { orderId: string };
    await asAdmin(f.db);
    const result = await value<Record<string, unknown>>(
      f.db,
      "select public.get_commercial_v1_order($1) as v",
      [order.orderId],
    );
    expect(result).toMatchObject({ ok: true });
  });
});

describe("No direct broad table privileges", () => {
  it("neither anon, authenticated nor service_role can select/insert/update the commerce tables directly", async () => {
    const f = await fixture();
    await owner(f.db);
    const unsafe = await value<string>(
      f.db,
      `select coalesce(string_agg(t.relname||':'||r.rolname,','),'') as v
       from pg_class t join pg_namespace n on n.oid=t.relnamespace
       cross join (values ('anon'),('authenticated'),('service_role')) r(rolname)
       where n.nspname='public' and t.relname in (
         'commercial_v1_offers','commercial_v1_orders','commercial_v1_payment_events','commercial_v1_entitlements'
       )
       and (has_table_privilege(r.rolname,t.oid,'SELECT,INSERT,UPDATE,DELETE')
         or has_any_column_privilege(r.rolname,t.oid,'SELECT,INSERT,UPDATE'))`,
    );
    expect(unsafe).toBe("");
  });

  it("service_role cannot call the commerce controller key store directly", async () => {
    const f = await fixture();
    await f.db.exec("set role service_role");
    await expect(
      f.db.query(
        "select * from commercial_v1_commerce_private.controller_keys",
      ),
    ).rejects.toThrow("permission denied");
    await f.db.exec("reset role");
  });
});

describe("Existing-system regression", () => {
  it("create_enrolment remains admin-only and unweakened -- commerce fulfillment never calls it with borrowed authority", async () => {
    const f = await fixture();
    await asLearner(f.db);
    await expect(
      f.db.query("select public.create_enrolment($1,$2,$3)", [
        learner,
        f.cohortId,
        "Attempted self-enrolment",
      ]),
    ).rejects.toThrow();
  });

  it("MASTERY_V1 and leaderboard functions remain present and untouched (regression)", async () => {
    const f = await fixture();
    await owner(f.db);
    const fnCount = await value<string>(
      f.db,
      "select count(*)::text as v from pg_proc where proname in ('apply_objective_mastery_policy','publish_commercial_v1_leaderboard_snapshot')",
    );
    expect(fnCount).toBe("2");
  });
});
