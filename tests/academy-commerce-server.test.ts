import { randomBytes, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { testDatabase } from "./db-helper";
import {
  approvedTestPackage,
  people,
  publishAcademyCourse,
  rpc,
  seedPeople,
  type Query,
} from "./academy-fixture";
import { FakeCommerceProviderAdapter } from "@/server/commercial-v1-commerce/test-fake-provider";

// End-to-end over the REAL server code: createAcademyCheckout, the existing
// processCommerceWebhook (Academy branch), reconcileAcademyOrder and the
// migration 061 authority on PGlite. Only Stripe (the code-owned fake
// adapter), identity and environment are substituted.
const keyId = randomUUID();
const key = randomBytes(32);
const m = vi.hoisted(() => ({
  auth: "" as string | null,
  provider: null as unknown,
  db: null as unknown,
}));
vi.mock("@/lib/env", () => ({
  config: () => ({ configured: true, appUrl: "https://ducelio.test" }),
  commerceConfig: () => ({
    configured: true,
    stripeConfigured: true,
    controllerConfigured: true,
    controllerKeyId: keyId,
    controllerKeyHex: key.toString("hex"),
    stripeSecretKey: "sk_test",
    stripeWebhookSecret: "whsec_test",
  }),
}));
vi.mock("@/server/identity", () => ({
  requireActor: async () => ({ id: people.learnerA.id, roles: ["STUDENT"] }),
}));
vi.mock("@/server/commercial-v1-commerce/provider", () => ({
  getCommerceProvider: async () => m.provider,
}));
// A PostgREST-like rpc over PGlite, as the signed-in learner (or anon for a
// webhook delivery), with named arguments cast to the function's types.
vi.mock("@/server/supabase", () => ({
  createSupabase: async () => ({
    async rpc(name: string, args: Record<string, unknown> = {}) {
      const db = m.db as PGlite;
      try {
        const sig = await db.query<{ names: string[]; types: string[] }>(
          `select p.proargnames names, array(select format_type(t,null) from unnest(p.proargtypes) t) types
           from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1`,
          [name],
        );
        const { names, types } = sig.rows[0];
        const used = names
          .map((n, i) => ({ n, t: types[i] }))
          .filter((p) => p.n in args);
        const values = used.map((p) =>
          p.t === "jsonb" && args[p.n] != null
            ? JSON.stringify(args[p.n])
            : args[p.n],
        );
        await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
          m.auth ?? "",
        ]);
        await db.exec(m.auth ? "set role authenticated" : "set role anon");
        try {
          const r = await db.query<{ v: unknown }>(
            `select public.${name}(${used.map((p, i) => `${p.n} => $${i + 1}::${p.t}`).join(",")}) v`,
            values,
          );
          return { data: r.rows[0].v, error: null };
        } finally {
          await db.exec("reset role");
        }
      } catch (e) {
        return { data: null, error: { message: (e as Error).message } };
      }
    },
  }),
}));

import {
  createAcademyCheckout,
  reconcileAcademyOrder,
} from "@/server/academy-commerce";
import { processCommerceWebhook } from "@/server/commercial-v1-commerce/webhooks";

let db: PGlite;
let q: Query;
const provider = new FakeCommerceProviderAdapter();
const slug = "academy-server-test";

beforeAll(async () => {
  db = await testDatabase();
  m.db = db;
  m.provider = provider;
  q = (sql, params) =>
    db.query(sql, params) as Promise<{ rows: Record<string, unknown>[] }>;
  await seedPeople(q);
  await q(
    "select commercial_v1_commerce_private.install_controller_key($1,$2::bytea)",
    [keyId, key],
  );
  const course = await publishAcademyCourse(
    q,
    slug,
    approvedTestPackage("academy-server-test"),
  );
  await rpc(q, people.admin, "enable_academy_public_sale", [
    course.offerId,
    true,
    "Owner approved test policy",
  ]);
}, 240000);
afterAll(async () => {
  await db?.close();
});

describe("Academy checkout through the existing Stripe integration", () => {
  let orderId = "";
  let sessionId = "";

  it("creates one bound, Academy-marked checkout session for the chosen format", async () => {
    m.auth = people.learnerA.auth;
    const first = await createAcademyCheckout(slug, "EXTENDED_8W");
    expect(first).toMatchObject({ ok: true });
    if (!first.ok) return;
    orderId = first.orderId;
    const again = await createAcademyCheckout(slug, "EXTENDED_8W");
    expect(again).toMatchObject({
      ok: true,
      orderId,
      url: first.ok ? first.url : "",
    });
    sessionId = (
      await q(
        "select provider_session_id s from public.academy_orders where id=$1",
        [orderId],
      )
    ).rows[0].s as string;
    const session = await provider.retrieveCheckoutSession(sessionId);
    expect(session).toMatchObject({
      metadataOrderId: orderId,
      metadataOrderKind: "ACADEMY",
    });
    expect(session.amountMinor).toBe(
      (
        await q(
          "select amount_minor a from public.academy_orders where id=$1",
          [orderId],
        )
      ).rows[0].a,
    );
  });

  it("refuses an unpaid redirect and grants access only after Stripe reports PAID", async () => {
    m.auth = people.learnerA.auth;
    expect(await reconcileAcademyOrder({ orderId, sessionId })).toMatchObject({
      ok: true,
      fulfilled: false,
      code: "NOT_PAID",
    });
    expect(
      (await q("select count(*)::int n from public.academy_entitlements"))
        .rows[0].n,
    ).toBe(0);
    provider.setSessionStatus(sessionId, "PAID");
    provider.closeSession(sessionId);
    m.auth = null; // a webhook delivery has no session
    const webhook = await processCommerceWebhook(
      provider.fakeWebhookEventFor(sessionId),
      provider as never,
    );
    expect(webhook).toEqual({ reconciled: true });
    m.auth = people.learnerA.auth;
    expect(await reconcileAcademyOrder({ orderId, sessionId })).toMatchObject({
      ok: true,
      fulfilled: true,
    });
    const ent = (
      await q(
        "select source, format_id, state from public.academy_entitlements where learner_id=$1",
        [people.learnerA.id],
      )
    ).rows;
    expect(ent).toEqual([
      { source: "PURCHASE", format_id: "EXTENDED_8W", state: "ACTIVE" },
    ]);
    const receipt = (
      await q(
        "select state, reason from public.commercial_v1_webhook_receipts order by received_at desc limit 1",
      )
    ).rows[0];
    expect(receipt).toEqual({ state: "RESOLVED", reason: "FULFILLED" });
    expect(await createAcademyCheckout(slug, "STANDARD_6W")).toMatchObject({
      ok: false,
      code: "ALREADY_ENTITLED",
    });
  });

  it("revokes access on a verified full refund webhook and refuses a partial one", async () => {
    m.auth = null;
    provider.setRefundedAmount(sessionId, 1);
    const partial = {
      ...provider.fakeWebhookEventFor(sessionId),
      eventType: "charge.refunded",
      paymentIntentId: sessionId,
      subjectId: "ch_fake_" + sessionId,
    };
    expect(await processCommerceWebhook(partial, provider as never)).toEqual({
      reconciled: false,
    });
    expect(
      (
        await q(
          "select state from public.academy_entitlements where learner_id=$1",
          [people.learnerA.id],
        )
      ).rows[0].state,
    ).toBe("ACTIVE");
    const amount = (
      await q("select amount_minor a from public.academy_orders where id=$1", [
        orderId,
      ])
    ).rows[0].a as number;
    provider.setRefundedAmount(sessionId, amount);
    const full = { ...partial, eventId: `evt_full_${randomUUID()}` };
    expect(await processCommerceWebhook(full, provider as never)).toEqual({
      reconciled: true,
    });
    expect(
      (
        await q(
          "select state from public.academy_entitlements where learner_id=$1",
          [people.learnerA.id],
        )
      ).rows[0].state,
    ).toBe("REVOKED");
    m.auth = people.learnerA.auth;
    expect(await reconcileAcademyOrder({ orderId, sessionId })).toMatchObject({
      ok: false,
      code: "ORDER_REFUNDED",
    });
  });

  it("never routes an Academy payment to the cohort authority or the reverse", async () => {
    // The cohort ledger is untouched by every Academy event above.
    expect(
      (await q("select count(*)::int n from public.commercial_v1_orders"))
        .rows[0].n,
    ).toBe(0);
    expect(
      (await q("select count(*)::int n from public.commercial_v1_entitlements"))
        .rows[0].n,
    ).toBe(0);
  });
});
