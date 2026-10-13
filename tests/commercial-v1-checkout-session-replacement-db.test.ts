import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  asPolicyUser,
  buildCommerceFixture,
  foreignLearner,
  learner,
  type CommerceFixture,
} from "./commercial-v1-commerce-fixture";

// LR-03 (migration 058): an EXPIRED, unpaid Stripe checkout session bound to
// a PENDING order can be replaced -- only through the attested replacement
// RPC, only by the owning learner, recorded as append-only provenance --
// and fulfilment then accepts only the replacement. Full migration chain.

let f: CommerceFixture;
const keyId = randomUUID();
const key = randomBytes(32);
const PRICE = 19900;
const expiredSession = "cs_test_expired_original";
const replacementSession = "cs_test_replacement_one";
let orderId: string;

async function value<T = unknown>(sql: string, args: unknown[] = []) {
  return (await f.db.query<{ v: T }>(sql, args)).rows[0].v;
}
async function owner() {
  await f.db.exec("reset role");
}
async function asUser(n: number) {
  await asPolicyUser(f.db, n);
}
async function attempt<T>(run: () => Promise<T>) {
  await f.db.exec("savepoint attempt");
  try {
    const result = await run();
    await f.db.exec("release savepoint attempt");
    return { ok: true as const, result };
  } catch (error) {
    await f.db.exec("rollback to savepoint attempt");
    return {
      ok: false as const,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function signed(
  payload: Record<string, unknown>,
  options: { tag?: string; tamper?: boolean; issuedOffset?: number } = {},
) {
  const issued = Math.floor(Date.now() / 1000) + (options.issuedOffset ?? 0);
  const expires = issued + 60;
  const text = JSON.stringify(payload);
  const mac = createHmac("sha256", key)
    .update(
      [
        options.tag ?? "DUCELIO_COMMERCE_CHECKOUT_REBIND_HMAC_SHA256_V1",
        keyId,
        text,
        String(issued),
        String(expires),
      ].join("\n"),
    )
    .digest("hex");
  return [keyId, text, issued, expires, options.tamper ? "0".repeat(64) : mac];
}
function replace(
  payload: Record<string, unknown>,
  options?: Parameters<typeof signed>[1],
) {
  return value<Record<string, unknown>>(
    "select public.replace_expired_commercial_v1_checkout_session($1,$2,$3,$4,$5) as v",
    signed(payload, options),
  );
}
const payload = (overrides: Record<string, unknown> = {}) => ({
  learnerId: learner,
  orderId,
  expiredSessionId: expiredSession,
  replacementSessionId: replacementSession,
  ...overrides,
});
async function fulfil(sessionId: string) {
  const issued = Math.floor(Date.now() / 1000);
  const expires = issued + 60;
  const eventId = "evt_" + sessionId;
  const canonical = [
    "DUCELIO_COMMERCE_FULFILLMENT_HMAC_SHA256_V1",
    "COMMERCIAL_V1_COMMERCE_V1",
    keyId,
    "STRIPE",
    orderId,
    sessionId,
    eventId,
    String(PRICE),
    "GBP",
    "PAID",
    String(issued),
    String(expires),
  ].join("\n");
  return value<Record<string, unknown>>(
    "select public.fulfill_commercial_v1_order($1,$2,'STRIPE',$3,$4,$5,'GBP','PAID',$6,$7,$8) as v",
    [
      keyId,
      orderId,
      sessionId,
      eventId,
      PRICE,
      issued,
      expires,
      createHmac("sha256", key).update(canonical).digest("hex"),
    ],
  );
}
async function boundSession() {
  await owner();
  return value<string>(
    "select provider_session_id as v from public.commercial_v1_orders where id=$1",
    [orderId],
  );
}
async function count(sql: string, args: unknown[] = []) {
  await owner();
  return value<number>(`select count(*)::int as v from ${sql}`, args);
}

beforeAll(async () => {
  f = await buildCommerceFixture({ throughMigration: 9999 });
  await f.db.query(
    "select commercial_v1_commerce_private.install_controller_key($1,$2::bytea)",
    [keyId, key],
  );
}, 120000);
afterAll(async () => {
  await f?.db.close();
});
beforeEach(async () => {
  await owner();
  await f.db.exec("begin");
  await asUser(2);
  await value(
    "select public.publish_commercial_v1_offer($1,'replacement-course',$2,'GBP','Test course','STANDARD_6_WEEK','Replacement fixture') as v",
    [f.activationId, PRICE],
  );
  await asUser(1);
  orderId = (
    await value<{ orderId: string }>(
      "select public.create_commercial_v1_order('replacement-course') as v",
    )
  ).orderId;
  await value(
    "select public.attach_commercial_v1_checkout_session($1,$2) as v",
    [orderId, expiredSession],
  );
});
afterEach(async () => {
  await f.db.exec("rollback");
  await owner();
});

describe("bound session invariant without an attested replacement", () => {
  it("still refuses a learner rebinding through attach", async () => {
    await asUser(1);
    expect(
      await value(
        "select public.attach_commercial_v1_checkout_session($1,$2) as v",
        [orderId, replacementSession],
      ),
    ).toMatchObject({
      ok: false,
      code: "SESSION_ALREADY_BOUND",
      existingSessionId: expiredSession,
    });
  });

  it("still refuses a direct session change with no recorded provenance", async () => {
    await owner();
    const changed = await attempt(() =>
      f.db.query(
        "update public.commercial_v1_orders set provider_session_id=$2 where id=$1",
        [orderId, replacementSession],
      ),
    );
    expect(changed).toMatchObject({
      ok: false,
      message: "A bound Stripe checkout session cannot be replaced",
    });
  });
});

describe("attested replacement of an expired session", () => {
  it("rebinds the PENDING order and records provenance and audit", async () => {
    await asUser(1);
    expect(await replace(payload())).toEqual({ ok: true, code: "REPLACED" });
    expect(await boundSession()).toBe(replacementSession);
    await owner();
    const history = (
      await f.db.query<{
        order_id: string;
        superseded_session_id: string;
        replacement_session_id: string;
        replaced_by: string;
      }>(
        "select order_id,superseded_session_id,replacement_session_id,replaced_by from public.commercial_v1_checkout_session_replacements",
      )
    ).rows;
    expect(history).toEqual([
      {
        order_id: orderId,
        superseded_session_id: expiredSession,
        replacement_session_id: replacementSession,
        replaced_by: learner,
      },
    ]);
    expect(
      await count(
        "public.audit_events where action='COMMERCIAL_V1_CHECKOUT_SESSION_REPLACED' and target_id=$1 and actor_id=$2",
        [orderId, learner],
      ),
    ).toBe(1);
  });

  it("is idempotent for the same attested replacement", async () => {
    await asUser(1);
    await replace(payload());
    await asUser(1);
    expect(await replace(payload())).toEqual({
      ok: true,
      code: "ALREADY_REPLACED",
    });
    expect(
      await count("public.commercial_v1_checkout_session_replacements"),
    ).toBe(1);
  });

  it("refuses a second, different replacement of the same expired session", async () => {
    await asUser(1);
    await replace(payload());
    await asUser(1);
    expect(
      await replace(payload({ replacementSessionId: "cs_test_other" })),
    ).toEqual({ ok: false, code: "SESSION_CHANGED" });
    expect(await boundSession()).toBe(replacementSession);
  });

  it("refuses when the claimed expired session is not the bound one", async () => {
    await asUser(1);
    expect(
      await replace(payload({ expiredSessionId: "cs_test_not_bound" })),
    ).toEqual({ ok: false, code: "SESSION_CHANGED" });
    expect(await boundSession()).toBe(expiredSession);
  });

  it("then lets only the replacement session fulfil the order", async () => {
    await asUser(1);
    await replace(payload());
    await asUser(1);
    expect(await fulfil(expiredSession)).toMatchObject({
      ok: false,
      code: "MISMATCHED_SESSION",
    });
    await asUser(1);
    expect(await fulfil(replacementSession)).toMatchObject({
      ok: true,
      fulfilled: true,
    });
    expect(
      await count("public.commercial_v1_entitlements where order_id=$1", [
        orderId,
      ]),
    ).toBe(1);
  });

  it("refuses a fulfilled order", async () => {
    await asUser(1);
    await fulfil(expiredSession);
    await asUser(1);
    expect(await replace(payload())).toEqual({
      ok: false,
      code: "INVALID_STATE",
    });
  });
});

describe("owner-only checkout binding read", () => {
  const read = () =>
    value<Record<string, unknown>>(
      "select public.get_my_commercial_v1_checkout_binding($1) as v",
      [orderId],
    );
  it("returns the owner's order state and currently bound session", async () => {
    await asUser(1);
    expect(await read()).toEqual({
      ok: true,
      state: "PENDING",
      sessionId: expiredSession,
    });
    await replace(payload());
    await asUser(1);
    expect(await read()).toEqual({
      ok: true,
      state: "PENDING",
      sessionId: replacementSession,
    });
  });

  it("never reveals another learner's binding", async () => {
    await asUser(3);
    expect(await read()).toEqual({
      ok: false,
      code: "NOT_FOUND_OR_FORBIDDEN",
    });
  });

  it("is executable by authenticated only", async () => {
    await owner();
    const rows = (
      await f.db.query<{ role: string; exec: boolean }>(
        `select r as role, has_function_privilege(r, 'public.get_my_commercial_v1_checkout_binding(uuid)', 'execute') as exec
         from unnest(array['anon','authenticated','service_role']) r order by r`,
      )
    ).rows;
    expect(rows).toEqual([
      { role: "anon", exec: false },
      { role: "authenticated", exec: true },
      { role: "service_role", exec: false },
    ]);
  });
});

describe("attestation and ownership", () => {
  it.each([
    ["a tampered MAC", { tamper: true }],
    [
      "the operations tag",
      { tag: "DUCELIO_COMMERCE_OPERATIONS_HMAC_SHA256_V1" },
    ],
    ["a stale claim", { issuedOffset: -600 }],
  ])("rejects %s", async (_label, options) => {
    await asUser(1);
    const outcome = await attempt(() => replace(payload(), options));
    expect(outcome).toMatchObject({ ok: false, message: "UNTRUSTED_CLAIM" });
    expect(await boundSession()).toBe(expiredSession);
  });

  it("binds the attested learner to the caller", async () => {
    await asUser(3);
    const outcome = await attempt(() => replace(payload()));
    expect(outcome).toMatchObject({ ok: false, message: "ACTOR_MISMATCH" });
  });

  it("never lets another learner replace a session on someone else's order", async () => {
    await asUser(3);
    expect(await replace(payload({ learnerId: foreignLearner }))).toEqual({
      ok: false,
      code: "NOT_FOUND_OR_FORBIDDEN",
    });
    expect(await boundSession()).toBe(expiredSession);
  });

  it("rejects extra payload fields and malformed replacement ids", async () => {
    await asUser(1);
    expect(
      await attempt(() => replace(payload({ amountMinor: 1 }))),
    ).toMatchObject({ ok: false, message: "INVALID_INPUT" });
    await asUser(1);
    expect(
      await attempt(() =>
        replace(payload({ replacementSessionId: "pi_not_a_session" })),
      ),
    ).toMatchObject({ ok: false, message: "INVALID_INPUT" });
  });

  it("is not executable by anon and the history is closed to API roles", async () => {
    await owner();
    const rows = (
      await f.db.query<{ role: string; exec: boolean; read: boolean }>(
        `select r as role,
           has_function_privilege(r, 'public.replace_expired_commercial_v1_checkout_session(uuid,text,bigint,bigint,text)', 'execute') as exec,
           has_table_privilege(r, 'public.commercial_v1_checkout_session_replacements', 'select') as read
         from unnest(array['anon','authenticated','service_role']) r order by r`,
      )
    ).rows;
    expect(rows).toEqual([
      { role: "anon", exec: false, read: false },
      { role: "authenticated", exec: true, read: false },
      { role: "service_role", exec: false, read: false },
    ]);
  });

  it("keeps replacement history append-only", async () => {
    await asUser(1);
    await replace(payload());
    await owner();
    for (const sql of [
      "update public.commercial_v1_checkout_session_replacements set replacement_session_id='cs_test_x'",
      "delete from public.commercial_v1_checkout_session_replacements",
    ])
      expect(await attempt(() => f.db.query(sql))).toMatchObject({
        ok: false,
        message: "Checkout session replacement history is append-only",
      });
  });
});
