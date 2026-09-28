import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Stripe from "stripe";
import { describe, it, expect, vi } from "vitest";
import {
  AUTHORIZE_FLAG,
  DRIVER_HEADER,
  FORWARDED_TO_STRIPE_APP,
  Q,
  ROUTE_PATH,
  SURFACES,
  TEST_PRICE,
  TRUTHFULNESS_STATEMENT,
  WEBHOOK_PATH,
  WITHHELD_FROM_STRIPE_APP,
  buildStripeChildEnv,
  checkoutSessionProblems,
  completionEventProblems,
  planStripeRun,
  promptOperator,
  runStripeAcceptance,
  safeErrorSummary,
  sandboxPaymentInstructions,
  scanBoundedList,
  signWebhookPayload,
  DEFAULT_LIST_PAGE_CAP,
  LIST_PAGE_SIZE,
} from "../scripts/acceptance/stripe.mjs";

// ============================================================================
// scripts/acceptance/stripe.mjs -- `npm run acceptance:stripe`.
//
// ZERO Stripe, Supabase, database or network traffic. Every run below
// injects a fake app process and an in-memory backend that mirrors the
// PRODUCTION semantics the driver must observe (database-owned order,
// order-derived Stripe idempotency, unpaid reconciliation grants nothing,
// signature-verified webhook -> idempotent fulfillment, reviewer access
// without an order). The fake webhook verifies signatures with stripe-node's
// own constructEvent (local computation only). Dishonest variants of that
// backend prove each surface fails closed instead of passing.
// ============================================================================

const TEST_KEY = "sk_test_" + "K".repeat(24);
const LIVE_KEY = "sk_live_" + "L".repeat(24);
const WEBHOOK_SECRET = "whsec_" + "w".repeat(32);
const CONTROLLER_KEY_HEX = "d".repeat(64);
const ENV_ID = "a0000000-0000-4000-8000-000000000001";
const BUYER = "20000000-0000-4000-8000-000000000001";
const COOKIE_VALUE = "cookie-session-sentinel";

const SECRET_SENTINELS = {
  ACCEPTANCE_DATABASE_URL: "postgres://user:db-sentinel@db.example.com/x",
  ACCEPTANCE_WRITE_ENABLED: "true",
  ACCEPTANCE_ENVIRONMENT_ID: ENV_ID,
  ACCEPTANCE_ADMIN_EMAIL: "admin@acceptance.test",
  ACCEPTANCE_ADMIN_PASSWORD: "admin-password-sentinel",
  ACCEPTANCE_LEARNER_EMAIL: "learner@acceptance.test",
  ACCEPTANCE_LEARNER_PASSWORD: "learner-password-sentinel",
  ACCEPTANCE_FOREIGN_LEARNER_EMAIL: "foreign@acceptance.test",
  ACCEPTANCE_FOREIGN_LEARNER_PASSWORD: "foreign-password-sentinel",
  ACCEPTANCE_UNRELATED_STAFF_PASSWORD: "staff-password-sentinel",
  ACADEMIC_EXECUTION_KEY_ID: "b0000000-0000-4000-8000-000000000002",
  ACADEMIC_EXECUTION_HMAC_KEY_HEX: "c".repeat(64),
  ACADEMIC_PROVIDER_API_KEY: "legacy-key-sentinel",
  OPENAI_API_KEY: "sk-openai-sentinel",
  ANTHROPIC_API_KEY: "sk-ant-sentinel",
  NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "publishable-sentinel",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-sentinel",
  GITHUB_TOKEN: "ghp_token-sentinel",
  GITHUB_PAT: "github_pat_sentinel",
  NODE_OPTIONS: "--import=file:///evil-preload.mjs",
  STRIPE_SECRET_KEY: TEST_KEY,
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  COMMERCE_CONTROLLER_KEY_ID: "b0000000-0000-4000-8000-000000000003",
  COMMERCE_CONTROLLER_HMAC_KEY_HEX: CONTROLLER_KEY_HEX,
};
// Values that are not secrets (flags/ids/public URL) are excluded from the
// leak scan.
const NOT_SECRET = new Set([
  "ACCEPTANCE_WRITE_ENABLED",
  "ACCEPTANCE_ENVIRONMENT_ID",
  "ACADEMIC_EXECUTION_KEY_ID",
  "COMMERCE_CONTROLLER_KEY_ID",
  "NEXT_PUBLIC_SUPABASE_URL",
  "ACCEPTANCE_ADMIN_EMAIL",
  "ACCEPTANCE_LEARNER_EMAIL",
  "ACCEPTANCE_FOREIGN_LEARNER_EMAIL",
]);

function authorizedEnv(extra: Record<string, string> = {}) {
  return {
    PATH: "/usr/bin",
    ...SECRET_SENTINELS,
    ACCEPTANCE_STRIPE_TEST_OPT_IN: "true",
    ...extra,
  };
}

function noSecretsIn(value: unknown) {
  const text = JSON.stringify(value);
  for (const [name, secret] of Object.entries(SECRET_SENTINELS))
    if (!NOT_SECRET.has(name)) expect(text).not.toContain(secret);
  expect(text).not.toContain(COOKIE_VALUE);
  expect(text).not.toMatch(/v1=[0-9a-f]{16}/);
}

type Result = {
  surface: string;
  status: string;
  reason: string;
  details?: string[];
};

// ---------------------------------------------------------------------------
// An in-memory backend with production semantics, plus dishonest variants.
// ---------------------------------------------------------------------------
type Course = {
  slug: string;
  offerId: string;
  activationId: string;
  cohortId: string;
  programmeVersionId: string;
  priceMinor: number;
  currency: string;
};
const PAID: Course = {
  slug: "acceptance-stripe-paid-1-abc",
  offerId: "30000000-0000-4000-8000-000000000001",
  activationId: "31000000-0000-4000-8000-000000000001",
  cohortId: "32000000-0000-4000-8000-000000000001",
  programmeVersionId: "33000000-0000-4000-8000-000000000001",
  priceMinor: TEST_PRICE.amountMinor,
  currency: TEST_PRICE.currency,
};
const REVIEWER: Course = {
  slug: "acceptance-stripe-reviewer-1-abc",
  offerId: "30000000-0000-4000-8000-000000000002",
  activationId: "31000000-0000-4000-8000-000000000002",
  cohortId: "32000000-0000-4000-8000-000000000002",
  programmeVersionId: "33000000-0000-4000-8000-000000000002",
  priceMinor: TEST_PRICE.amountMinor,
  currency: TEST_PRICE.currency,
};
const COURSES = [PAID, REVIEWER];

type Order = {
  id: string;
  learner_id: string;
  offer_id: string;
  activation_id: string;
  cohort_id: string;
  amount_minor: number;
  currency: string;
  provider: string;
  provider_session_id: string | null;
  state: string;
  fulfilled_at: Date | null;
  campaign_redemption_id: string | null;
};
type Entitlement = {
  id: string;
  learner_id: string;
  offer_id: string;
  activation_id: string;
  order_id: string | null;
  enrolment_id: string;
  source: string;
  campaign_redemption_id: string | null;
  state: string;
};
type Enrolment = {
  id: string;
  student_id: string;
  cohort_id: string;
  status: string;
  programme_version_id: string;
};
type Redemption = {
  id: string;
  campaign_id: string;
  learner_id: string;
  offer_id: string;
  entitlement_source: string;
  effective_price_amount_minor: number;
};
type PaymentEvent = {
  order_id: string;
  provider: string;
  provider_event_id: string;
  session_id: string;
  amount_minor: number;
  currency: string;
  status: string;
};
type Campaign = { id: string; offer_id: string; code: string; kind: string };
type Session = {
  object: string;
  id: string;
  livemode: boolean;
  mode: string;
  payment_status: string;
  status: string;
  amount_total: number;
  currency: string;
  metadata: { orderId: string };
  client_reference_id: string;
  payment_method_types: string[];
  url: string | null;
  created: number;
};
type StripeEvent = {
  object: string;
  id: string;
  type: string;
  livemode: boolean;
  created: number;
  data: { object: Session };
};

type Flags = {
  reconcileGrantsUnpaid?: boolean;
  webhookIgnoresSignature?: boolean;
  duplicateCreatesEvent?: boolean;
  reviewerCreatesOrder?: boolean;
  acceptZeroPrice?: boolean;
  retryCreatesSecondSession?: boolean;
  amountDrift?: boolean;
  liveSession?: boolean;
  liveAccount?: boolean;
  operatorConfirms?: boolean;
  neverPaid?: boolean;
  externalFulfilment?: boolean;
  keyAbsent?: boolean;
  keyMismatch?: boolean;
  // Stripe list pagination: objects per page (never more than the
  // driver's own limit), unrelated sessions created after each paid
  // checkout call, unrelated completion events after payment, a second
  // genuine completion event for the same session, and listings that
  // report has_more forever.
  pageSize?: number;
  noiseAfterEachCheckout?: number;
  noiseEvents?: number;
  duplicateCompletionEvent?: boolean;
  endlessSessions?: boolean;
  endlessEvents?: boolean;
};

function createWorld(flags: Flags = {}) {
  let seq = 0;
  const id = () => `40000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
  const orders: Order[] = [];
  const entitlements: Entitlement[] = [];
  const enrolments: Enrolment[] = [];
  const redemptions: Redemption[] = [];
  const events: PaymentEvent[] = [];
  const campaigns: Campaign[] = [];
  const sessions = new Map<string, Session>();
  const stripeEvents: StripeEvent[] = [];
  let clock = 1_800_000_000;
  const clone = <T>(v: T): T => structuredClone(v);
  const courseBy = (pred: (c: Course) => boolean) => COURSES.find(pred)!;

  function enrol(course: Course) {
    const enrolment: Enrolment = {
      id: id(),
      student_id: BUYER,
      cohort_id: course.cohortId,
      status: "ACTIVE",
      programme_version_id: course.programmeVersionId,
    };
    enrolments.push(enrolment);
    return enrolment;
  }

  function newSession(order: Order) {
    const sid = `cs_test_a${++seq}b2C3d4`;
    const session: Session = {
      object: "checkout.session",
      id: sid,
      livemode: Boolean(flags.liveSession),
      mode: "payment",
      payment_status: "unpaid",
      status: "open",
      amount_total: order.amount_minor + (flags.amountDrift ? 1 : 0),
      currency: order.currency.toLowerCase(),
      metadata: { orderId: order.id },
      client_reference_id: order.id,
      payment_method_types: ["card"],
      url: `https://checkout.stripe.com/c/pay/${sid}#fidSentinel`,
      created: clock++,
    };
    sessions.set(sid, session);
    return session;
  }

  // Another merchant flow's session in the same sandbox window.
  function noiseSession() {
    const sid = `cs_test_n${++seq}oise`;
    sessions.set(sid, {
      object: "checkout.session",
      id: sid,
      livemode: false,
      mode: "payment",
      payment_status: "unpaid",
      status: "open",
      amount_total: 999,
      currency: "gbp",
      metadata: { orderId: "unrelated-order" },
      client_reference_id: "unrelated-order",
      payment_method_types: ["card"],
      url: `https://checkout.stripe.com/c/pay/${sid}`,
      created: clock++,
    });
  }

  // Stripe list semantics: newest first, starting_after cursor, has_more.
  function paginate<T extends { id: string }>(
    newestFirst: T[],
    params: { limit?: number; starting_after?: string },
  ) {
    const size = Math.min(params.limit ?? 10, flags.pageSize ?? 100);
    const start = params.starting_after
      ? newestFirst.findIndex((x) => x.id === params.starting_after) + 1
      : 0;
    return {
      object: "list",
      has_more: start + size < newestFirst.length,
      data: newestFirst.slice(start, start + size).map(clone),
    };
  }

  function grantPaid(order: Order) {
    const course = courseBy((c) => c.activationId === order.activation_id);
    const enrolment = enrol(course);
    entitlements.push({
      id: id(),
      learner_id: order.learner_id,
      offer_id: order.offer_id,
      activation_id: order.activation_id,
      order_id: order.id,
      enrolment_id: enrolment.id,
      source: "PAID_ORDER",
      campaign_redemption_id: null,
      state: "ACTIVE",
    });
    order.state = "FULFILLED";
    order.fulfilled_at = new Date(1_800_000_000_000 + seq);
  }

  // fulfill_commercial_v1_order's semantics.
  function fulfill(
    orderId: string,
    eventId: string,
    sessionId: string,
    amount: number,
    currency: string,
    status: string,
  ) {
    const order = orders.find((o) => o.id === orderId);
    if (!order || order.provider_session_id !== sessionId) return;
    if (order.amount_minor !== amount || order.currency !== currency) return;
    if (
      flags.duplicateCreatesEvent ||
      !events.some((e) => e.provider_event_id === eventId)
    )
      events.push({
        order_id: orderId,
        provider: "STRIPE",
        provider_event_id: eventId,
        session_id: sessionId,
        amount_minor: amount,
        currency,
        status,
      });
    if (order.state === "FULFILLED" || status !== "PAID") return;
    grantPaid(order);
  }

  // createCommercialV1Checkout's semantics.
  function createCheckout(course: Course, code?: string) {
    if (code) {
      const campaign = campaigns.find(
        (c) => c.code === code && c.offer_id === course.offerId,
      );
      if (!campaign) return { ok: false, code: "CODE_UNAVAILABLE" };
      const prior = redemptions.find(
        (r) => r.learner_id === BUYER && r.offer_id === course.offerId,
      );
      if (prior) {
        const e = entitlements.find(
          (x) => x.campaign_redemption_id === prior.id,
        )!;
        return {
          ok: true,
          kind: "ACCESS_GRANTED",
          entitlementId: e.id,
          enrolmentId: e.enrolment_id,
          offerSlug: course.slug,
        };
      }
      const reviewer = campaign.kind === "REVIEWER_COMPLIMENTARY";
      const redemption: Redemption = {
        id: id(),
        campaign_id: campaign.id,
        learner_id: BUYER,
        offer_id: course.offerId,
        entitlement_source: reviewer ? "REVIEWER" : "PROMOTIONAL",
        effective_price_amount_minor: 0,
      };
      redemptions.push(redemption);
      const enrolment = enrol(course);
      const entitlement: Entitlement = {
        id: id(),
        learner_id: BUYER,
        offer_id: course.offerId,
        activation_id: course.activationId,
        order_id: null,
        enrolment_id: enrolment.id,
        source: redemption.entitlement_source,
        campaign_redemption_id: redemption.id,
        state: "ACTIVE",
      };
      entitlements.push(entitlement);
      if (flags.reviewerCreatesOrder)
        orders.push({
          id: id(),
          learner_id: BUYER,
          offer_id: course.offerId,
          activation_id: course.activationId,
          cohort_id: course.cohortId,
          amount_minor: 1,
          currency: "GBP",
          provider: "STRIPE",
          provider_session_id: null,
          state: "PENDING",
          fulfilled_at: null,
          campaign_redemption_id: redemption.id,
        });
      return {
        ok: true,
        kind: "ACCESS_GRANTED",
        entitlementId: entitlement.id,
        enrolmentId: enrolment.id,
        offerSlug: course.slug,
      };
    }
    let order = orders.find(
      (o) =>
        o.learner_id === BUYER &&
        o.activation_id === course.activationId &&
        o.state === "PENDING",
    );
    if (!order) {
      order = {
        id: id(),
        learner_id: BUYER,
        offer_id: course.offerId,
        activation_id: course.activationId,
        cohort_id: course.cohortId,
        amount_minor: course.priceMinor,
        currency: course.currency,
        provider: "STRIPE",
        provider_session_id: null,
        state: "PENDING",
        fulfilled_at: null,
        campaign_redemption_id: null,
      };
      orders.push(order);
    }
    const current = order;
    // Stripe idempotency: DUCELIO_COMMERCIAL_V1_ORDER:<orderId>.
    const existing = [...sessions.values()].find(
      (s) => s.client_reference_id === current.id,
    );
    const session =
      existing && !flags.retryCreatesSecondSession
        ? existing
        : newSession(current);
    if (!current.provider_session_id) current.provider_session_id = session.id;
    const bound = sessions.get(current.provider_session_id)!;
    for (let i = 0; i < (flags.noiseAfterEachCheckout ?? 0); i += 1)
      noiseSession();
    return { ok: true, kind: "CHECKOUT", url: bound.url, orderId: current.id };
  }

  // reconcileCommercialV1Order's semantics.
  function reconcile(orderId: string, sessionId: string) {
    const order = orders.find((o) => o.id === orderId)!;
    if (order.state === "FULFILLED")
      return { ok: true, fulfilled: true, replay: true, code: null, orderId };
    const s = sessions.get(sessionId)!;
    if (s.metadata.orderId !== orderId)
      return {
        ok: false,
        fulfilled: null,
        replay: null,
        code: "MISMATCHED_SESSION",
        orderId: null,
      };
    if (s.payment_status !== "paid") {
      if (flags.reconcileGrantsUnpaid) grantPaid(order);
      return {
        ok: true,
        fulfilled: false,
        replay: null,
        code: "NOT_PAID",
        orderId,
      };
    }
    fulfill(
      orderId,
      `SESSION_VERIFY:${sessionId}`,
      sessionId,
      s.amount_total,
      s.currency.toUpperCase(),
      "PAID",
    );
    return { ok: true, fulfilled: true, replay: false, code: null, orderId };
  }

  // The operator's one manual sandbox payment on Stripe's hosted page.
  function pay() {
    if (flags.neverPaid) return;
    const order = orders.find((o) => o.activation_id === PAID.activationId)!;
    const s = sessions.get(order.provider_session_id!)!;
    s.payment_status = "paid";
    s.status = "complete";
    s.url = null;
    const event: StripeEvent = {
      object: "event",
      id: `evt_${++seq}Sandbox`,
      type: "checkout.session.completed",
      livemode: false,
      created: clock++,
      data: { object: clone(s) },
    };
    stripeEvents.push(event);
    if (flags.duplicateCompletionEvent)
      stripeEvents.push({ ...clone(event), id: `evt_${++seq}Duplicate` });
    for (let i = 0; i < (flags.noiseEvents ?? 0); i += 1)
      stripeEvents.push({
        object: "event",
        id: `evt_${++seq}Noise`,
        type: "checkout.session.completed",
        livemode: false,
        created: clock++,
        data: {
          object: { ...clone(s), id: `cs_test_n${seq}other` },
        },
      });
    if (flags.externalFulfilment)
      fulfill(order.id, event.id, s.id, s.amount_total, "GBP", "PAID");
  }

  const childEnvs: Record<string, string>[] = [];
  const webhookPosts: { status: number }[] = [];
  const printed: string[] = [];
  const stripeKeys: string[] = [];

  async function fetchImpl(url: string, init: RequestInit) {
    const path = new URL(url).pathname;
    const headers = init.headers as Record<string, string>;
    const reply = (status: number, body: unknown, extra = {}) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...extra },
      });
    if (path === ROUTE_PATH) {
      const token = childEnvs[0]?.ACCEPTANCE_STRIPE_DRIVER_TOKEN;
      if (!token || headers[DRIVER_HEADER] !== token)
        return new Response(null, { status: 404 });
      const body = JSON.parse(String(init.body));
      if (!body.operation) return reply(400, { error: "INVALID_REQUEST" });
      if (body.operation === "SIGN_IN")
        return reply(
          200,
          { ok: true },
          { "set-cookie": `sb-session=${COOKIE_VALUE}; Path=/; HttpOnly` },
        );
      if (!String(headers.cookie ?? "").includes(COOKIE_VALUE))
        return reply(401, { error: "AUTHENTICATION_REQUIRED" });
      if (body.operation === "CREATE_CHECKOUT") {
        const course = courseBy((c) => c.slug === body.offerSlug);
        const result = createCheckout(course, body.campaignCode);
        return reply(200, {
          ok: true,
          result:
            result.ok === false ? { ok: false, code: result.code } : result,
        });
      }
      if (body.operation === "RECONCILE_ORDER")
        return reply(200, {
          ok: true,
          result: reconcile(body.orderId, body.sessionId),
        });
      return reply(400, { error: "INVALID_REQUEST" });
    }
    if (path === WEBHOOK_PATH) {
      if (headers[DRIVER_HEADER] || headers.cookie)
        throw new Error("The production webhook must be called like Stripe.");
      const raw = String(init.body);
      let event: StripeEvent;
      try {
        event = (
          flags.webhookIgnoresSignature
            ? JSON.parse(raw)
            : Stripe.webhooks.constructEvent(
                raw,
                headers["stripe-signature"] ?? "",
                WEBHOOK_SECRET,
              )
        ) as StripeEvent;
      } catch {
        webhookPosts.push({ status: 400 });
        return reply(400, { error: "Invalid signature" });
      }
      const s = event.data.object;
      fulfill(
        s.metadata.orderId,
        event.id,
        s.id,
        s.amount_total,
        s.currency.toUpperCase(),
        s.payment_status === "paid" ? "PAID" : "UNPAID",
      );
      webhookPosts.push({ status: 200 });
      return reply(200, { received: true });
    }
    throw new Error(`Unexpected network request to ${path}.`);
  }

  async function query(sql: string, params: unknown[]) {
    const [a, b] = params as string[];
    switch (sql) {
      case Q.orders:
        return orders
          .filter((o) => o.learner_id === a && o.activation_id === b)
          .map(clone);
      case Q.paymentEventsForOrder:
        return events.filter((e) => e.order_id === a).map(clone);
      case Q.paymentEventsForEvent:
        return events.filter((e) => e.provider_event_id === a).map(clone);
      case Q.paymentEventCount: {
        const ids = new Set(
          orders
            .filter((o) => o.learner_id === a && o.activation_id === b)
            .map((o) => o.id),
        );
        return [{ n: events.filter((e) => ids.has(e.order_id)).length }];
      }
      case Q.entitlements:
        return entitlements
          .filter((e) => e.learner_id === a && e.activation_id === b)
          .map(clone);
      case Q.enrolments:
        return enrolments
          .filter((e) => e.student_id === a && e.cohort_id === b)
          .map(clone);
      case Q.redemptions:
        return redemptions
          .filter((r) => r.learner_id === a && r.offer_id === b)
          .map(clone);
      case Q.campaignByCode:
        return campaigns.filter((c) => c.code === a).map((c) => ({ id: c.id }));
      case Q.controllerKeyProbe: {
        if (flags.keyAbsent) return [];
        const key = flags.keyMismatch ? "e".repeat(64) : CONTROLLER_KEY_HEX;
        return [
          {
            probe_mac: createHmac("sha256", Buffer.from(key, "hex"))
              .update(b, "utf8")
              .digest("hex"),
          },
        ];
      }
    }
    throw new Error("Unexpected query in the fake database.");
  }

  // The governed create_commercial_v1_campaign's launch policy.
  const admin = {
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name !== "create_commercial_v1_campaign")
        return { data: null, error: { message: "unexpected rpc" } };
      const course = courseBy((c) => c.slug === args.p_offer_slug);
      const kind = String(args.p_kind);
      const effective =
        kind === "REVIEWER_COMPLIMENTARY"
          ? 0
          : kind === "FIXED_PRICE"
            ? Number(args.p_fixed_price_amount_minor)
            : course.priceMinor -
              Math.floor(
                (course.priceMinor * Number(args.p_percent_off)) / 100,
              );
      if (
        kind !== "REVIEWER_COMPLIMENTARY" &&
        effective === 0 &&
        !flags.acceptZeroPrice
      )
        return {
          data: null,
          error: { message: "ZERO_PRICE_RESERVED_FOR_REVIEWERS" },
        };
      const campaign = {
        id: id(),
        offer_id: course.offerId,
        code: String(args.p_code),
        kind,
      };
      campaigns.push(campaign);
      return { data: campaign.id, error: null };
    }),
  };

  const stripe = {
    balance: {
      retrieve: vi.fn(async () => ({
        object: "balance",
        livemode: Boolean(flags.liveAccount),
      })),
    },
    checkout: {
      sessions: {
        retrieve: vi.fn(async (sid: string) => clone(sessions.get(sid))),
        list: vi.fn(
          async (params: {
            created: { gte: number };
            limit?: number;
            starting_after?: string;
          }) => {
            if (flags.endlessSessions) {
              noiseSession();
              return {
                object: "list",
                has_more: true,
                data: [clone([...sessions.values()].at(-1)!)],
              };
            }
            return paginate(
              [...sessions.values()]
                .filter((s) => s.created >= params.created.gte)
                .reverse(),
              params,
            );
          },
        ),
      },
    },
    events: {
      list: vi.fn(
        async (params: {
          type: string;
          created: { gte: number };
          limit?: number;
          starting_after?: string;
        }) => {
          if (flags.endlessEvents)
            return {
              object: "list",
              has_more: true,
              data: [{ id: `evt_${++seq}Endless`, data: { object: {} } }],
            };
          return paginate(
            stripeEvents
              .filter(
                (e) =>
                  e.type === params.type && e.created >= params.created.gte,
              )
              .reverse(),
            params,
          );
        },
      ),
      retrieve: vi.fn(async (eid: string) =>
        clone(stripeEvents.find((e) => e.id === eid)),
      ),
    },
  };

  const startApp = vi.fn((env: Record<string, string>) => {
    childEnvs.push(env);
    return { exitCode: null, pid: 0 };
  });
  const prepareFixtures = vi.fn(async () => ({
    adminClient: admin,
    buyerId: BUYER,
    paid: PAID,
    reviewer: REVIEWER,
  }));
  const waitForOperator = vi.fn(async () => {
    if (flags.operatorConfirms === false) return false;
    pay();
    return true;
  });
  const createStripeClient = vi.fn((key: string) => {
    stripeKeys.push(key);
    return stripe;
  });
  const queryFn = vi.fn(query);
  return {
    orders,
    entitlements,
    enrolments,
    redemptions,
    events,
    campaigns,
    sessions,
    childEnvs,
    webhookPosts,
    printed,
    stripeKeys,
    stripe,
    admin,
    startApp,
    prepareFixtures,
    waitForOperator,
    createStripeClient,
    query: queryFn,
    fetchImpl: vi.fn(fetchImpl),
  };
}

async function run(
  flags: Flags = {},
  {
    env = authorizedEnv(),
    argv = [AUTHORIZE_FLAG],
    inspectEnvFilesIn,
    listPageCap,
  }: {
    env?: Record<string, string>;
    argv?: string[];
    // When set, the driver really inspects that directory's .env* files.
    inspectEnvFilesIn?: string;
    listPageCap?: number;
  } = {},
) {
  const world = createWorld(flags);
  const outcome = await runStripeAcceptance({
    env,
    argv,
    startApp: world.startApp,
    stopApp: async () => {},
    fetchImpl: world.fetchImpl,
    envFileNames: inspectEnvFilesIn === undefined ? [] : undefined,
    envFileDir: inspectEnvFilesIn,
    createStripeClient: world.createStripeClient,
    query: world.query,
    prepareFixtures: world.prepareFixtures,
    writeGates: async () => {},
    waitForOperator: world.waitForOperator,
    print: (line: string) => world.printed.push(line),
    sleep: async () => {},
    readinessPollMs: 1,
    readinessTimeoutMs: 1000,
    ...(listPageCap === undefined ? {} : { listPageCap }),
  });
  const results = outcome.results as Result[];
  const by = Object.fromEntries(results.map((r) => [r.surface, r]));
  return { results, by, world };
}

function nothingHappened(world: ReturnType<typeof createWorld>) {
  expect(world.startApp).not.toHaveBeenCalled();
  expect(world.createStripeClient).not.toHaveBeenCalled();
  expect(world.query).not.toHaveBeenCalled();
  expect(world.fetchImpl).not.toHaveBeenCalled();
  expect(world.prepareFixtures).not.toHaveBeenCalled();
}

const ALL = Object.values(SURFACES) as string[];

// ---------------------------------------------------------------------------
describe("Stripe acceptance driver: explicit double authorization (A, B, D)", () => {
  it("with neither the opt-in nor the flag: every surface BLOCKED and nothing starts", async () => {
    const { results, world } = await run(
      {},
      { env: authorizedEnv({ ACCEPTANCE_STRIPE_TEST_OPT_IN: "" }), argv: [] },
    );
    expect(results.map((r) => r.surface).sort()).toEqual([...ALL].sort());
    expect(
      results.every((r) => r.reason === "EXPLICIT_AUTHORIZATION_REQUIRED"),
    ).toBe(true);
    nothingHappened(world);
    noSecretsIn(results);
  });

  it("the flag alone is insufficient", async () => {
    const { results, world } = await run(
      {},
      { env: authorizedEnv({ ACCEPTANCE_STRIPE_TEST_OPT_IN: "" }) },
    );
    expect(results[0].reason).toBe("EXPLICIT_AUTHORIZATION_REQUIRED");
    expect(results[0].details?.join(" ")).toContain(
      "ACCEPTANCE_STRIPE_TEST_OPT_IN is not exactly 'true'.",
    );
    nothingHappened(world);
  });

  it("the opt-in alone is insufficient", async () => {
    const { results, world } = await run({}, { argv: [] });
    expect(results[0].reason).toBe("EXPLICIT_AUTHORIZATION_REQUIRED");
    expect(results[0].details?.join(" ")).toContain(
      "--authorize-stripe-test command-line flag was not given",
    );
    nothingHappened(world);
  });

  for (const value of ["TRUE", "yes", "1", " true", "true "]) {
    it(`an opt-in of '${value}' is not exactly 'true'`, async () => {
      const { results, world } = await run(
        {},
        { env: authorizedEnv({ ACCEPTANCE_STRIPE_TEST_OPT_IN: value }) },
      );
      expect(results[0].reason).toBe("EXPLICIT_AUTHORIZATION_REQUIRED");
      nothingHappened(world);
    });
  }

  it("a configured test key, webhook secret and controller key are never themselves authorization (B)", async () => {
    const env = authorizedEnv({ ACCEPTANCE_STRIPE_TEST_OPT_IN: "" });
    const plan = planStripeRun(env, []);
    expect(plan.runnable).toBe(false);
    expect(JSON.stringify(plan)).not.toContain(TEST_KEY);
    const { world } = await run({}, { env, argv: [] });
    nothingHappened(world);
  });

  it("ACCEPTANCE_STRIPE_LIVE_OPT_IN can never authorize this command (D)", async () => {
    const env = authorizedEnv({
      ACCEPTANCE_STRIPE_TEST_OPT_IN: "",
      ACCEPTANCE_STRIPE_LIVE_OPT_IN: "true",
    });
    const { results, world } = await run({}, { env });
    expect(results[0].reason).toBe("EXPLICIT_AUTHORIZATION_REQUIRED");
    expect(results[0].details?.join(" ")).toContain(
      "ACCEPTANCE_STRIPE_LIVE_OPT_IN is reserved for a separate future live-money phase and never authorizes this command.",
    );
    nothingHappened(world);
  });

  it("missing prerequisites BLOCK by name only, before anything starts", async () => {
    const { results, world } = await run(
      {},
      {
        env: authorizedEnv({
          ACCEPTANCE_FOREIGN_LEARNER_PASSWORD: "",
          ACCEPTANCE_WRITE_ENABLED: "false",
          STRIPE_WEBHOOK_SECRET: "not-a-webhook-secret",
          COMMERCE_CONTROLLER_HMAC_KEY_HEX: "xyz",
        }),
      },
    );
    expect(results[0].reason).toBe("PREREQUISITES_MISSING");
    const details = results[0].details?.join(" ") ?? "";
    for (const name of [
      "ACCEPTANCE_FOREIGN_LEARNER_PASSWORD",
      "ACCEPTANCE_WRITE_ENABLED",
      "STRIPE_WEBHOOK_SECRET",
      "COMMERCE_CONTROLLER_HMAC_KEY_HEX",
    ])
      expect(details).toContain(name);
    expect(details).not.toContain("not-a-webhook-secret");
    nothingHappened(world);
  });
});

describe("Stripe acceptance driver: TEST mode only (C)", () => {
  for (const key of [LIVE_KEY, "rk_live_" + "R".repeat(24), "pk_live_x"]) {
    it(`a live-mode-shaped key (${key.slice(0, 8)}...) is refused before anything starts, even fully authorized`, async () => {
      const { results, world } = await run(
        {},
        { env: authorizedEnv({ STRIPE_SECRET_KEY: key }) },
      );
      expect(results.every((r) => r.reason === "LIVE_MODE_KEY_REFUSED")).toBe(
        true,
      );
      nothingHappened(world);
      expect(JSON.stringify(results)).not.toContain(key);
    });
  }

  it("a live key is refused regardless of arguments or opt-ins", () => {
    for (const argv of [[], ["--unknown"], [AUTHORIZE_FLAG, AUTHORIZE_FLAG]])
      for (const optIn of ["", "true"]) {
        const plan = planStripeRun(
          authorizedEnv({
            STRIPE_SECRET_KEY: LIVE_KEY,
            ACCEPTANCE_STRIPE_TEST_OPT_IN: optIn,
            ACCEPTANCE_STRIPE_LIVE_OPT_IN: "true",
          }),
          argv,
        );
        expect(plan.runnable).toBe(false);
        expect(plan.results[0].reason).toBe("LIVE_MODE_KEY_REFUSED");
      }
  });

  it("a key without the sk_test_ shape BLOCKS as a missing prerequisite", async () => {
    const { results, world } = await run(
      {},
      { env: authorizedEnv({ STRIPE_SECRET_KEY: "sk_something_else" }) },
    );
    expect(results[0].reason).toBe("PREREQUISITES_MISSING");
    expect(results[0].details?.join(" ")).toContain("sk_test_");
    nothingHappened(world);
  });

  it("an account Stripe reports as livemode=true BLOCKS before the app starts or anything is written", async () => {
    const { results, world } = await run({ liveAccount: true });
    expect(
      results.every((r) => r.reason === "STRIPE_ACCOUNT_NOT_TEST_MODE"),
    ).toBe(true);
    expect(world.stripe.balance.retrieve).toHaveBeenCalledTimes(1);
    expect(world.startApp).not.toHaveBeenCalled();
    expect(world.prepareFixtures).not.toHaveBeenCalled();
  });

  it("a Stripe error summary never quotes the key", () => {
    const error = Object.assign(
      new Error(`Invalid API Key provided: ${TEST_KEY}`),
      { type: "StripeAuthenticationError", code: "api_key_invalid" },
    );
    const summary = safeErrorSummary(error);
    expect(summary).toContain("StripeAuthenticationError");
    expect(summary).not.toContain(TEST_KEY);
    expect(
      safeErrorSummary(new Error(`boom ${LIVE_KEY} ${WEBHOOK_SECRET}`)),
    ).not.toMatch(/sk_live_L|whsec_w/);
  });
});

describe("Stripe acceptance driver: arguments fail closed without echo (E)", () => {
  const cases: [string, string[], string][] = [
    ["a pasted key", [AUTHORIZE_FLAG, TEST_KEY], "UNRECOGNIZED_ARGUMENT"],
    ["a run-all flag", [AUTHORIZE_FLAG, "--run-all"], "UNRECOGNIZED_ARGUMENT"],
    [
      "an arbitrary price",
      [AUTHORIZE_FLAG, "--price=0"],
      "UNRECOGNIZED_ARGUMENT",
    ],
    [
      "an arbitrary endpoint",
      [AUTHORIZE_FLAG, "--endpoint=https://evil.example.com"],
      "UNRECOGNIZED_ARGUMENT",
    ],
    [
      "a Stripe object selector",
      [AUTHORIZE_FLAG, "--session=cs_test_abc"],
      "UNRECOGNIZED_ARGUMENT",
    ],
    [
      "a flag with a value",
      ["--authorize-stripe-test=true"],
      "UNRECOGNIZED_ARGUMENT",
    ],
    ["the flag twice", [AUTHORIZE_FLAG, AUTHORIZE_FLAG], "REPEATED_ARGUMENT"],
  ];
  for (const [label, argv, reason] of cases) {
    it(`${label} BLOCKS every surface without echoing the argument`, async () => {
      const { results, world } = await run({}, { argv });
      expect(results.every((r) => r.reason === reason)).toBe(true);
      const text = JSON.stringify(results);
      for (const arg of argv)
        if (arg !== AUTHORIZE_FLAG) expect(text).not.toContain(arg);
      nothingHappened(world);
    });
  }
});

describe("Stripe acceptance driver: the child app receives only what its production path needs (I)", () => {
  const build = (
    extra: Record<string, string> = {},
    envFileNames: string[] = [],
  ) =>
    buildStripeChildEnv(
      authorizedEnv({
        ...extra,
        UNRELATED_FILE_SECRET: "file-secret-sentinel",
        NODE_ENV: "production",
      }),
      { port: 4321, token: "f".repeat(64), authorized: true, envFileNames },
    ) as Record<string, string>;

  it("forwards exactly the commerce/Supabase/environment values and the per-run gate", () => {
    const env = build({}, ["UNRELATED_FILE_SECRET"]);
    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe(
      SECRET_SENTINELS.NEXT_PUBLIC_SUPABASE_URL,
    );
    expect(env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY).toBe(
      SECRET_SENTINELS.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    );
    expect(env.STRIPE_SECRET_KEY).toBe(TEST_KEY);
    expect(env.STRIPE_WEBHOOK_SECRET).toBe(WEBHOOK_SECRET);
    expect(env.COMMERCE_CONTROLLER_KEY_ID).toBe(
      SECRET_SENTINELS.COMMERCE_CONTROLLER_KEY_ID,
    );
    expect(env.COMMERCE_CONTROLLER_HMAC_KEY_HEX).toBe(CONTROLLER_KEY_HEX);
    expect(env.ACCEPTANCE_ENVIRONMENT_ID).toBe(ENV_ID);
    expect(env.ACCEPTANCE_STRIPE_DRIVER_ENABLED).toBe("true");
    expect(env.ACCEPTANCE_STRIPE_DRIVER_TOKEN).toBe("f".repeat(64));
    expect(env.ACCEPTANCE_STRIPE_TEST_OPT_IN).toBe("true");
    expect(env.ACCEPTANCE_STRIPE_AUTHORIZED).toBe("true");
    expect(env.APP_URL).toBe("http://127.0.0.1:4321");
    expect(env.NODE_ENV).toBeUndefined();
    expect([...FORWARDED_TO_STRIPE_APP].sort()).toEqual(
      [
        "ACCEPTANCE_ENVIRONMENT_ID",
        "COMMERCE_CONTROLLER_HMAC_KEY_HEX",
        "COMMERCE_CONTROLLER_KEY_ID",
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
        "NEXT_PUBLIC_SUPABASE_URL",
        "STRIPE_SECRET_KEY",
        "STRIPE_WEBHOOK_SECRET",
      ].sort(),
    );
  });

  it("blanks the acceptance DB credential, identities, AI keys, academic HMAC, service-role-like and .env-loaded names", () => {
    const env = build({ ACCEPTANCE_STRIPE_LIVE_OPT_IN: "true" }, [
      "UNRELATED_FILE_SECRET",
    ]);
    for (const name of [
      "ACCEPTANCE_DATABASE_URL",
      "ACCEPTANCE_WRITE_ENABLED",
      "ACCEPTANCE_ADMIN_EMAIL",
      "ACCEPTANCE_ADMIN_PASSWORD",
      "ACCEPTANCE_LEARNER_EMAIL",
      "ACCEPTANCE_LEARNER_PASSWORD",
      "ACCEPTANCE_FOREIGN_LEARNER_PASSWORD",
      "ACCEPTANCE_UNRELATED_STAFF_PASSWORD",
      "ACCEPTANCE_STRIPE_LIVE_OPT_IN",
      "ACADEMIC_EXECUTION_KEY_ID",
      "ACADEMIC_EXECUTION_HMAC_KEY_HEX",
      "ACADEMIC_PROVIDER_API_KEY",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
      "GITHUB_TOKEN",
      "GITHUB_PAT",
      "NODE_OPTIONS",
      "UNRELATED_FILE_SECRET",
    ])
      expect(env[name], name).toBe("");
    expect(env.PATH).toBe("/usr/bin");
    for (const name of WITHHELD_FROM_STRIPE_APP)
      expect(FORWARDED_TO_STRIPE_APP).not.toContain(name);
  });

  it("refuses to build without double authorization, a test key or a well-formed token", () => {
    const base = authorizedEnv();
    const opts = { port: 4321, token: "f".repeat(64), authorized: true };
    expect(() =>
      buildStripeChildEnv(base, { ...opts, authorized: false }),
    ).toThrow("double authorization");
    expect(() =>
      buildStripeChildEnv({ ...base, ACCEPTANCE_STRIPE_TEST_OPT_IN: "" }, opts),
    ).toThrow("double authorization");
    expect(() =>
      buildStripeChildEnv({ ...base, STRIPE_SECRET_KEY: LIVE_KEY }, opts),
    ).toThrow("TEST-mode");
    expect(() =>
      buildStripeChildEnv(base, { ...opts, token: "F".repeat(64) }),
    ).toThrow("64 lowercase hex");
  });

  it("a full run starts the app exactly once with that minimised environment", async () => {
    const { world } = await run();
    expect(world.startApp).toHaveBeenCalledTimes(1);
    const child = world.childEnvs[0];
    expect(child.ACCEPTANCE_DATABASE_URL).toBe("");
    expect(child.ACCEPTANCE_LEARNER_PASSWORD).toBe("");
    expect(child.OPENAI_API_KEY).toBe("");
    expect(child.STRIPE_SECRET_KEY).toBe(TEST_KEY);
    expect(child.ACCEPTANCE_STRIPE_DRIVER_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    expect(child.APP_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});

describe("Stripe acceptance driver: env-file inspection fails closed (J)", () => {
  const tempDir = () => mkdtempSync(join(tmpdir(), "ducelio-stripe-env-"));

  it("readable env-file names are blanked in the child", async () => {
    const dir = tempDir();
    try {
      writeFileSync(
        join(dir, ".env.local"),
        "UNRELATED_FILE_SECRET=file-value-sentinel\nexport EXPORTED_NAME=x\n",
      );
      const { world, results } = await run({}, { inspectEnvFilesIn: dir });
      expect(world.childEnvs[0].UNRELATED_FILE_SECRET).toBe("");
      expect(world.childEnvs[0].EXPORTED_NAME).toBe("");
      expect(JSON.stringify(results)).not.toContain("file-value-sentinel");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an uninspectable env file BLOCKS before any database, Stripe or app work", async () => {
    const dir = tempDir();
    try {
      mkdirSync(join(dir, ".env.local"));
      const { results, world } = await run({}, { inspectEnvFilesIn: dir });
      expect(
        results.every((r) => r.reason === "ENV_FILE_NOT_INSPECTABLE"),
      ).toBe(true);
      expect(results[0].details?.join(" ")).toContain(
        ".env.local exists but its variable names could not be inspected.",
      );
      expect(JSON.stringify(results)).not.toContain(dir);
      nothingHappened(world);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Stripe acceptance driver: commerce controller key is an operator prerequisite (read-only)", () => {
  it("an absent hosted key BLOCKS before Stripe, the app or any write", async () => {
    const { results, world } = await run({ keyAbsent: true });
    expect(
      results.every((r) => r.reason === "COMMERCE_CONTROLLER_KEY_ABSENT"),
    ).toBe(true);
    expect(results[0].details?.join(" ")).toContain("never provisions keys");
    expect(world.createStripeClient).not.toHaveBeenCalled();
    expect(world.startApp).not.toHaveBeenCalled();
    expect(world.query).toHaveBeenCalledTimes(1);
    expect(world.query.mock.calls[0][0]).toBe(Q.controllerKeyProbe);
    // Only the key id and a probe string reach the database -- never the key.
    expect(JSON.stringify(world.query.mock.calls[0][1])).not.toContain(
      CONTROLLER_KEY_HEX,
    );
  });

  it("a mismatched hosted key BLOCKS", async () => {
    const { results, world } = await run({ keyMismatch: true });
    expect(
      results.every((r) => r.reason === "COMMERCE_CONTROLLER_KEY_MISMATCH"),
    ).toBe(true);
    expect(world.startApp).not.toHaveBeenCalled();
  });

  it("the probe query is a read-only SELECT on the controller key table", () => {
    expect(Q.controllerKeyProbe.trim()).toMatch(/^select /);
    expect(Q.controllerKeyProbe).toContain(
      "commercial_v1_commerce_private.controller_keys",
    );
    for (const sql of Object.values(Q) as string[])
      expect(sql).not.toMatch(
        /\b(insert|update|delete|truncate|drop|install_controller_key)\b/i,
      );
  });
});

describe("Stripe acceptance driver: a complete honest run", () => {
  it("every surface PASSes against production semantics, with one operator prompt and no secret in any output", async () => {
    const { results, by, world } = await run();
    expect(results.map((r) => [r.surface, r.status])).toEqual(
      [
        SURFACES.CHECKOUT_BINDING,
        SURFACES.REDIRECT_NOT_PAYMENT_PROOF,
        SURFACES.SIGNED_WEBHOOK_FULFILLMENT,
        SURFACES.DUPLICATE_WEBHOOK_IDEMPOTENCY,
        SURFACES.RECONCILIATION_REPLAY,
        SURFACES.REVIEWER_COMPLIMENTARY,
        SURFACES.ZERO_PRICE_PROMO_GUARD,
      ].map((s) => [s, "PASS"]),
    );
    expect(world.waitForOperator).toHaveBeenCalledTimes(1);
    const prompt = world.printed.join("\n");
    expect(prompt).toContain("STRIPE TEST MODE");
    expect(prompt).toContain("NEVER enter a real card");
    expect(prompt).toContain(
      "Complete the sandbox Checkout, then press Enter to continue.",
    );
    expect(prompt).toMatch(/https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_/);
    // Exactly one paid order, one payment event, one entitlement/enrolment
    // for the paid course; the reviewer course has no order at all.
    expect(
      world.orders.filter((o) => o.activation_id === PAID.activationId),
    ).toHaveLength(1);
    expect(world.events).toHaveLength(1);
    expect(
      world.entitlements.filter((e) => e.activation_id === PAID.activationId),
    ).toHaveLength(1);
    expect(
      world.orders.filter((o) => o.activation_id === REVIEWER.activationId),
    ).toHaveLength(0);
    // Unsigned, forged, valid and duplicate deliveries.
    expect(world.webhookPosts.map((p) => p.status)).toEqual([
      400, 400, 200, 200,
    ]);
    // The key reached only the test-mode client factory.
    expect(world.stripeKeys).toEqual([TEST_KEY]);
    expect(by[SURFACES.CHECKOUT_BINDING].details?.join(" ")).toContain(
      "100 GBP (database-owned)",
    );
    noSecretsIn(results);
    noSecretsIn(world.printed);
    // No raw Stripe object or event body is ever part of the evidence.
    const evidence = JSON.stringify(results);
    for (const raw of [
      "client_reference_id",
      'payment_method_types":',
      '"data":{',
      "fidSentinel",
      "checkout.stripe.com",
    ])
      expect(evidence).not.toContain(raw);
  });

  it("without operator confirmation, no payment is assumed and no webhook is delivered", async () => {
    const { by, world } = await run({ operatorConfirms: false });
    expect(by[SURFACES.SIGNED_WEBHOOK_FULFILLMENT].status).toBe("BLOCKED");
    expect(by[SURFACES.SIGNED_WEBHOOK_FULFILLMENT].reason).toBe(
      "SANDBOX_PAYMENT_NOT_CONFIRMED",
    );
    expect(by[SURFACES.DUPLICATE_WEBHOOK_IDEMPOTENCY].status).toBe("BLOCKED");
    expect(by[SURFACES.RECONCILIATION_REPLAY].status).toBe("BLOCKED");
    expect(by[SURFACES.CHECKOUT_BINDING].status).toBe("PASS");
    expect(by[SURFACES.REVIEWER_COMPLIMENTARY].status).toBe("PASS");
    expect(world.webhookPosts).toHaveLength(0);
    expect(
      world.entitlements.filter((e) => e.activation_id === PAID.activationId),
    ).toHaveLength(0);
  });

  it("a payment Stripe never reports as paid is BLOCKED after a bounded number of retrievals", async () => {
    const { by, world } = await run({ neverPaid: true });
    expect(by[SURFACES.SIGNED_WEBHOOK_FULFILLMENT].reason).toBe(
      "SANDBOX_PAYMENT_NOT_OBSERVED",
    );
    // 1 binding + 1 open check + 5 bounded paid polls.
    expect(world.stripe.checkout.sessions.retrieve).toHaveBeenCalledTimes(7);
    expect(world.webhookPosts).toHaveLength(0);
  });

  it("an order fulfilled outside this run (e.g. an external webhook endpoint) is BLOCKED, never claimed", async () => {
    const { by, world } = await run({ externalFulfilment: true });
    expect(by[SURFACES.SIGNED_WEBHOOK_FULFILLMENT].status).toBe("BLOCKED");
    expect(by[SURFACES.SIGNED_WEBHOOK_FULFILLMENT].reason).toBe(
      "ORDER_FULFILLED_OUTSIDE_THIS_RUN",
    );
    expect(by[SURFACES.DUPLICATE_WEBHOOK_IDEMPOTENCY].status).toBe("BLOCKED");
    expect(world.webhookPosts).toHaveLength(0);
  });
});

describe("Stripe acceptance driver: each surface fails closed against a dishonest backend", () => {
  it("L: a second payable session on retry FAILs CHECKOUT_BINDING and nothing downstream runs", async () => {
    const { by, world } = await run({ retryCreatesSecondSession: true });
    expect(by[SURFACES.CHECKOUT_BINDING].status).toBe("FAIL");
    expect(by[SURFACES.CHECKOUT_BINDING].details?.join(" ")).toContain(
      "Stripe holds 2 Checkout Sessions for this order",
    );
    for (const s of [
      SURFACES.REDIRECT_NOT_PAYMENT_PROOF,
      SURFACES.SIGNED_WEBHOOK_FULFILLMENT,
      SURFACES.DUPLICATE_WEBHOOK_IDEMPOTENCY,
      SURFACES.RECONCILIATION_REPLAY,
    ])
      expect(by[s].reason).toBe("REQUIRES_CHECKOUT_BINDING");
    expect(world.waitForOperator).not.toHaveBeenCalled();
  });

  it("L: a Stripe amount that drifts from the database order FAILs CHECKOUT_BINDING", async () => {
    const { by } = await run({ amountDrift: true });
    expect(by[SURFACES.CHECKOUT_BINDING].status).toBe("FAIL");
    expect(by[SURFACES.CHECKOUT_BINDING].details?.join(" ")).toContain(
      "amount_total differs from the database order amount.",
    );
  });

  it("L: a livemode session FAILs CHECKOUT_BINDING", async () => {
    const { by } = await run({ liveSession: true });
    expect(by[SURFACES.CHECKOUT_BINDING].status).toBe("FAIL");
    expect(by[SURFACES.CHECKOUT_BINDING].details?.join(" ")).toContain(
      "livemode is not false.",
    );
  });

  it("M: unpaid reconciliation that grants access FAILs, and the operator is never asked to pay", async () => {
    const { by, world } = await run({ reconcileGrantsUnpaid: true });
    expect(by[SURFACES.REDIRECT_NOT_PAYMENT_PROOF].status).toBe("FAIL");
    expect(by[SURFACES.SIGNED_WEBHOOK_FULFILLMENT].reason).toBe(
      "REQUIRES_REDIRECT_NOT_PAYMENT_PROOF",
    );
    expect(world.waitForOperator).not.toHaveBeenCalled();
    expect(world.printed.join("\n")).not.toContain("checkout.stripe.com");
  });

  it("N: a webhook route that accepts an invalid signature FAILs and never becomes fulfillment evidence", async () => {
    const { by } = await run({ webhookIgnoresSignature: true });
    expect(by[SURFACES.SIGNED_WEBHOOK_FULFILLMENT].status).toBe("FAIL");
    expect(by[SURFACES.SIGNED_WEBHOOK_FULFILLMENT].reason).toBe(
      "Invalid webhook signatures were not refused cleanly.",
    );
    expect(by[SURFACES.DUPLICATE_WEBHOOK_IDEMPOTENCY].reason).toBe(
      "REQUIRES_SIGNED_WEBHOOK_FULFILLMENT",
    );
    expect(by[SURFACES.RECONCILIATION_REPLAY].reason).toBe(
      "REQUIRES_SIGNED_WEBHOOK_FULFILLMENT",
    );
  });

  it("P: a duplicate delivery that records a second payment event FAILs idempotency", async () => {
    const { by } = await run({ duplicateCreatesEvent: true });
    expect(by[SURFACES.SIGNED_WEBHOOK_FULFILLMENT].status).toBe("PASS");
    expect(by[SURFACES.DUPLICATE_WEBHOOK_IDEMPOTENCY].status).toBe("FAIL");
    expect(
      by[SURFACES.DUPLICATE_WEBHOOK_IDEMPOTENCY].details?.join(" "),
    ).toContain("paymentEvents(event)=2");
  });

  it("Q: reviewer access that also creates an order FAILs", async () => {
    const { by } = await run({ reviewerCreatesOrder: true });
    expect(by[SURFACES.REVIEWER_COMPLIMENTARY].status).toBe("FAIL");
    expect(by[SURFACES.REVIEWER_COMPLIMENTARY].details?.join(" ")).toContain(
      "a commercial order (1)",
    );
  });

  it("R: a non-reviewer zero-price campaign that is accepted (and grants access) FAILs", async () => {
    const { by } = await run({ acceptZeroPrice: true });
    const guard = by[SURFACES.ZERO_PRICE_PROMO_GUARD];
    expect(guard.status).toBe("FAIL");
    const details = guard.details?.join(" ") ?? "";
    expect(details).toContain(
      "the governed campaign authority ACCEPTED a non-reviewer zero-price campaign",
    );
    expect(details).toContain("The buyer holds an order, entitlement");
  });
});

describe("Stripe acceptance driver: fail-closed Stripe object validation (L)", () => {
  const ORDER = "40000000-0000-4000-8000-000000000001";
  const SID = "cs_test_a1b2C3d4";
  const expected = {
    sessionId: SID,
    orderId: ORDER,
    amountMinor: 100,
    currency: "GBP",
    paymentStatus: "unpaid",
    state: "open",
  };
  const good = () => ({
    object: "checkout.session",
    id: SID,
    livemode: false,
    mode: "payment",
    payment_status: "unpaid",
    status: "open",
    amount_total: 100,
    currency: "gbp",
    metadata: { orderId: ORDER },
    client_reference_id: ORDER,
    payment_method_types: ["card"],
    url: `https://checkout.stripe.com/c/pay/${SID}#x`,
    created: 1,
  });

  it("accepts an exactly matching open test-mode session", () => {
    expect(checkoutSessionProblems(good(), expected)).toEqual([]);
  });

  const drifts: [string, Record<string, unknown>, string][] = [
    ["livemode=true", { livemode: true }, "livemode is not false."],
    ["wrong session", { id: "cs_test_other" }, "session id differs"],
    ["wrong amount", { amount_total: 99 }, "amount_total differs"],
    ["wrong currency", { currency: "usd" }, "currency differs"],
    [
      "wrong order metadata",
      { metadata: { orderId: "x" } },
      "metadata.orderId",
    ],
    [
      "wrong client reference",
      { client_reference_id: "x" },
      "client_reference_id",
    ],
    [
      "non-card methods",
      { payment_method_types: ["card", "klarna"] },
      "payment_method_types",
    ],
    ["subscription mode", { mode: "subscription" }, "mode is not 'payment'."],
    [
      "already paid",
      { payment_status: "paid" },
      "payment_status is not 'unpaid'.",
    ],
    ["no URL", { url: null }, "No open Checkout URL"],
    [
      "URL for another session",
      { url: "https://checkout.stripe.com/c/pay/cs_test_zzz" },
      "No open Checkout URL",
    ],
    [
      "plain http URL",
      { url: `http://checkout.stripe.com/c/pay/${SID}` },
      "No open Checkout URL",
    ],
  ];
  for (const [label, override, problem] of drifts) {
    it(`rejects ${label}`, () => {
      const problems = checkoutSessionProblems(
        { ...good(), ...override },
        expected,
      );
      expect(problems.join(" ")).toContain(problem);
    });
  }

  it("never quotes a drifted value", () => {
    const problems = checkoutSessionProblems(
      { ...good(), amount_total: 987654, currency: "zzz" },
      expected,
    );
    expect(problems.join(" ")).not.toMatch(/987654|zzz/i);
  });

  const paidEvent = () => ({
    object: "event",
    id: "evt_1Abc",
    type: "checkout.session.completed",
    livemode: false,
    created: 5,
    data: {
      object: {
        ...good(),
        payment_status: "paid",
        status: "complete",
        url: null,
      },
    },
  });
  const orderFacts = {
    sessionId: SID,
    orderId: ORDER,
    amountMinor: 100,
    currency: "GBP",
    sessionCreated: 1,
  };
  it("accepts a genuine completion event for exactly this session", () => {
    expect(completionEventProblems(paidEvent(), orderFacts)).toEqual([]);
  });
  const eventDrifts: [
    string,
    (e: ReturnType<typeof paidEvent>) => void,
    string,
  ][] = [
    [
      "a livemode event",
      (e) => (e.livemode = true),
      "event livemode is not false",
    ],
    [
      "another event type",
      (e) => (e.type = "checkout.session.expired"),
      "not checkout.session.completed",
    ],
    [
      "another session",
      (e) => (e.data.object.id = "cs_test_other"),
      "session id differs",
    ],
    [
      "an unpaid session",
      (e) => (e.data.object.payment_status = "unpaid"),
      "payment_status is not 'paid'",
    ],
    [
      "a livemode session",
      (e) => (e.data.object.livemode = true),
      "livemode is not false",
    ],
    [
      "another amount",
      (e) => (e.data.object.amount_total = 1),
      "amount_total differs",
    ],
    [
      "an event predating the session",
      (e) => (e.created = 0),
      "predates the session",
    ],
  ];
  for (const [label, mutate, problem] of eventDrifts) {
    it(`rejects ${label}`, () => {
      const event = paidEvent();
      mutate(event);
      expect(completionEventProblems(event, orderFacts).join(" ")).toContain(
        problem,
      );
    });
  }
});

describe("Stripe acceptance driver: webhook signing uses stripe-node's official test helper", () => {
  it("produces a header the production verifier (constructEvent) accepts only with the same secret -- locally", () => {
    const raw = JSON.stringify({
      id: "evt_1",
      object: "event",
      type: "checkout.session.completed",
      data: { object: { id: "cs_test_x" } },
    });
    const header = signWebhookPayload(raw, WEBHOOK_SECRET);
    expect(Stripe.webhooks.constructEvent(raw, header, WEBHOOK_SECRET).id).toBe(
      "evt_1",
    );
    expect(() =>
      Stripe.webhooks.constructEvent(raw, header, "whsec_" + "x".repeat(32)),
    ).toThrow();
    const source = readFileSync("scripts/acceptance/stripe.mjs", "utf8");
    expect(source).toContain("Stripe.webhooks.generateTestHeaderString");
    // The Stripe signature scheme is never hand-rolled.
    expect(source).not.toMatch(/createHmac\([^)]*\)[\s\S]{0,80}\bt=/);
  });
});

describe("Stripe acceptance driver: operator prompt", () => {
  it("never assumes a payment without an interactive terminal", async () => {
    const input = Object.assign(new PassThrough(), { isTTY: false });
    await expect(
      promptOperator({ input, output: new PassThrough() }),
    ).resolves.toBe(false);
  });

  it("resolves true on Enter and false on end of input or timeout", async () => {
    const enter = Object.assign(new PassThrough(), { isTTY: true });
    const pending = promptOperator({ input: enter, output: new PassThrough() });
    enter.write("\n");
    await expect(pending).resolves.toBe(true);
    const ended = Object.assign(new PassThrough(), { isTTY: true });
    const closed = promptOperator({ input: ended, output: new PassThrough() });
    ended.end();
    await expect(closed).resolves.toBe(false);
    const idle = Object.assign(new PassThrough(), { isTTY: true });
    await expect(
      promptOperator({ input: idle, output: new PassThrough(), timeoutMs: 5 }),
    ).resolves.toBe(false);
  });
});

describe("Stripe acceptance driver: the real CLI never runs unauthorized", () => {
  const baseEnv = {
    PATH: process.env.PATH ?? "",
    SystemRoot: process.env.SystemRoot ?? "",
    STRIPE_SECRET_KEY: TEST_KEY,
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  };
  it("`node scripts/acceptance/stripe.mjs` with keys but no authorization reports BLOCKED and starts nothing", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/acceptance/stripe.mjs"],
      {
        env: baseEnv as unknown as NodeJS.ProcessEnv,
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    expect(result.status).toBe(0);
    for (const surface of ALL)
      expect(result.stdout).toContain(
        `[BLOCKED] ${surface} -- EXPLICIT_AUTHORIZATION_REQUIRED`,
      );
    expect(result.stdout).toContain(TRUTHFULNESS_STATEMENT);
    for (const secret of [TEST_KEY, WEBHOOK_SECRET]) {
      expect(result.stdout).not.toContain(secret);
      expect(result.stderr).not.toContain(secret);
    }
  });

  it("a live key is refused even with the opt-in, the live opt-in and the flag", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/acceptance/stripe.mjs", AUTHORIZE_FLAG],
      {
        env: {
          ...baseEnv,
          STRIPE_SECRET_KEY: LIVE_KEY,
          ACCEPTANCE_STRIPE_TEST_OPT_IN: "true",
          ACCEPTANCE_STRIPE_LIVE_OPT_IN: "true",
        } as unknown as NodeJS.ProcessEnv,
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `[BLOCKED] ${SURFACES.CHECKOUT_BINDING} -- LIVE_MODE_KEY_REFUSED`,
    );
    expect(result.stdout).not.toContain(LIVE_KEY);
  });

  it("the truthfulness statement disclaims live money, network delivery and production readiness", () => {
    for (const phrase of [
      "STRIPE TEST MODE",
      "not Stripe's network delivery to a deployed public endpoint",
      "No real money or real card is involved.",
      "not live-money payment acceptance",
      "refund/dispute or subscription evidence",
      "not production-readiness proof",
    ])
      expect(TRUTHFULNESS_STATEMENT).toContain(phrase);
  });

  it("npm exposes the dedicated command", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.scripts["acceptance:stripe"]).toBe(
      "node --env-file-if-exists=.env.local scripts/acceptance/stripe.mjs",
    );
  });
});

describe("Stripe acceptance: production commerce code carries no acceptance hooks (S)", () => {
  it("the production checkout/reconcile/provider/authority/webhook/env sources never reference acceptance", () => {
    for (const file of [
      "src/server/commercial-v1-commerce/index.ts",
      "src/server/commercial-v1-commerce/provider.ts",
      "src/server/commercial-v1-commerce/stripe-provider.ts",
      "src/server/commercial-v1-commerce/authority.ts",
      "src/app/api/commerce/stripe-webhook/route.ts",
      "src/app/checkout/success/page.tsx",
      "src/lib/env.ts",
    ])
      expect(readFileSync(file, "utf8"), file).not.toMatch(/acceptance/i);
  });

  it("the production idempotency key, card-only scope and webhook verifier the driver relies on are unchanged", () => {
    const index = readFileSync(
      "src/server/commercial-v1-commerce/index.ts",
      "utf8",
    );
    expect(index).toContain(
      'idempotencyKey: "DUCELIO_COMMERCIAL_V1_ORDER:" + order.orderId',
    );
    const provider = readFileSync(
      "src/server/commercial-v1-commerce/stripe-provider.ts",
      "utf8",
    );
    expect(provider).toContain('payment_method_types: ["card"]');
    expect(provider).toContain("stripe.webhooks.constructEvent(");
    const webhook = readFileSync(
      "src/app/api/commerce/stripe-webhook/route.ts",
      "utf8",
    );
    expect(webhook).toContain(
      "provider.verifyWebhookEvent(rawBody, signature)",
    );
    expect(webhook).toContain("attestCommerceFulfillment({");
  });
});

// ---------------------------------------------------------------------------
// Independent-review correction V2.
// ---------------------------------------------------------------------------
type ListParams = {
  created?: { gte: number };
  type?: string;
  limit?: number;
  starting_after?: string;
};
function listCalls(fn: { mock: { calls: unknown[][] } }) {
  return fn.mock.calls.map((c) => c[0] as ListParams);
}
function newestFirstSessionIds(world: ReturnType<typeof createWorld>) {
  return [...world.sessions.values()].reverse().map((s) => s.id);
}

describe("Stripe acceptance driver: Checkout Session listing is exhaustive or fails closed (V2 finding 1)", () => {
  it("a duplicate session for the order on page 2 FAILs", async () => {
    const { by, world } = await run({
      retryCreatesSecondSession: true,
      noiseAfterEachCheckout: 2,
      pageSize: 2,
    });
    const order = world.orders.find(
      (o) => o.activation_id === PAID.activationId,
    )!;
    // Newest first: page 1 holds only unrelated sessions; page 2 opens with
    // the order's second (duplicate) session.
    const ids = newestFirstSessionIds(world);
    expect(ids.slice(0, 2).every((sid) => sid.includes("oise"))).toBe(true);
    expect(world.sessions.get(ids[2])!.client_reference_id).toBe(order.id);
    expect(ids[2]).not.toBe(order.provider_session_id);
    const binding = by[SURFACES.CHECKOUT_BINDING];
    expect(binding.status).toBe("FAIL");
    expect(binding.details?.join(" ")).toContain(
      "Stripe holds 2 Checkout Sessions for this order;",
    );
    const calls = listCalls(world.stripe.checkout.sessions.list);
    expect(calls).toHaveLength(3);
    expect(calls[0].starting_after).toBeUndefined();
    expect(calls[1].starting_after).toBe(ids[1]);
    expect(calls.every((c) => c.limit === LIST_PAGE_SIZE)).toBe(true);
    expect(world.waitForOperator).not.toHaveBeenCalled();
  });

  it("page 1 has_more=true and page 2 exhausts with only the bound session: PASS", async () => {
    const { by, results, world } = await run({
      noiseAfterEachCheckout: 2,
      pageSize: 3,
    });
    const binding = by[SURFACES.CHECKOUT_BINDING];
    expect(binding.status).toBe("PASS");
    expect(binding.reason).toContain("an exhausted bounded listing");
    expect(binding.details?.join(" ")).toContain(
      "stripe sessions referencing this order=1 (bounded listing exhausted after 2 page(s), cap 10)",
    );
    const calls = listCalls(world.stripe.checkout.sessions.list);
    expect(calls).toHaveLength(2);
    expect(calls[1].starting_after).toBe(newestFirstSessionIds(world)[2]);
    // The later bound-session created filter is identical on every page.
    expect(calls[0].created).toEqual(calls[1].created);
    expect(results.every((r) => r.status === "PASS")).toBe(true);
  });

  it("the page cap reached while has_more=true BLOCKS, never PASSes, and nothing downstream runs", async () => {
    const { by, world } = await run(
      { noiseAfterEachCheckout: 2, pageSize: 1 },
      { listPageCap: 3 },
    );
    const binding = by[SURFACES.CHECKOUT_BINDING];
    expect(binding.status).toBe("BLOCKED");
    expect(binding.reason).toBe("CHECKOUT_SESSION_SCAN_NOT_EXHAUSTED");
    expect(binding.details?.join(" ")).toContain(
      "bounded listing NOT exhausted after 3 page(s), cap 3",
    );
    expect(world.stripe.checkout.sessions.list).toHaveBeenCalledTimes(3);
    for (const s of [
      SURFACES.REDIRECT_NOT_PAYMENT_PROOF,
      SURFACES.SIGNED_WEBHOOK_FULFILLMENT,
      SURFACES.DUPLICATE_WEBHOOK_IDEMPOTENCY,
      SURFACES.RECONCILIATION_REPLAY,
    ])
      expect(by[s].reason).toBe("REQUIRES_CHECKOUT_BINDING");
    expect(world.waitForOperator).not.toHaveBeenCalled();
  });

  it("a listing that reports has_more forever stops at the default cap (never unbounded)", async () => {
    const { by, world } = await run({ endlessSessions: true });
    expect(by[SURFACES.CHECKOUT_BINDING].status).toBe("BLOCKED");
    expect(world.stripe.checkout.sessions.list).toHaveBeenCalledTimes(
      DEFAULT_LIST_PAGE_CAP,
    );
  });
});

describe("Stripe acceptance driver: completion-event lookup is exhaustive or fails closed (V2 finding 2)", () => {
  it("a second genuine completion event for the session on page 2 FAILs and nothing is delivered", async () => {
    const { by, world } = await run({
      duplicateCompletionEvent: true,
      noiseEvents: 2,
      pageSize: 2,
    });
    const webhook = by[SURFACES.SIGNED_WEBHOOK_FULFILLMENT];
    expect(webhook.status).toBe("FAIL");
    expect(webhook.reason).toBe(
      "Stripe reports more than one completion event for the session.",
    );
    const calls = listCalls(world.stripe.events.list);
    expect(calls).toHaveLength(2);
    expect(calls[1].starting_after).toBeDefined();
    expect(world.webhookPosts).toHaveLength(0);
    expect(world.stripe.events.retrieve).not.toHaveBeenCalled();
    expect(by[SURFACES.DUPLICATE_WEBHOOK_IDEMPOTENCY].reason).toBe(
      "REQUIRES_SIGNED_WEBHOOK_FULFILLMENT",
    );
  });

  it("events spread over two pages, exhausted, establish exactly one event: PASS", async () => {
    const { by, results, world } = await run({ noiseEvents: 3, pageSize: 2 });
    expect(results.every((r) => r.status === "PASS")).toBe(true);
    const calls = listCalls(world.stripe.events.list);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.type === "checkout.session.completed")).toBe(
      true,
    );
    expect(calls[1].starting_after).toBeDefined();
    expect(
      by[SURFACES.SIGNED_WEBHOOK_FULFILLMENT].details?.join(" "),
    ).toContain(
      "completion events for this session=1 (bounded listing exhausted after 2 page(s))",
    );
  });

  it("the page cap reached while has_more=true BLOCKS instead of inferring uniqueness", async () => {
    const { by, world } = await run(
      { noiseEvents: 5, pageSize: 1 },
      { listPageCap: 3 },
    );
    const webhook = by[SURFACES.SIGNED_WEBHOOK_FULFILLMENT];
    expect(webhook.status).toBe("BLOCKED");
    expect(webhook.reason).toBe("COMPLETION_EVENT_SCAN_NOT_EXHAUSTED");
    expect(world.stripe.events.list).toHaveBeenCalledTimes(3);
    expect(world.stripe.events.retrieve).not.toHaveBeenCalled();
    expect(world.webhookPosts).toHaveLength(0);
  });

  it("an event listing that reports has_more forever stops at the cap and is not re-polled", async () => {
    const { by, world } = await run({ endlessEvents: true });
    expect(by[SURFACES.SIGNED_WEBHOOK_FULFILLMENT].reason).toBe(
      "COMPLETION_EVENT_SCAN_NOT_EXHAUSTED",
    );
    expect(world.stripe.events.list).toHaveBeenCalledTimes(
      DEFAULT_LIST_PAGE_CAP,
    );
  });
});

describe("Stripe acceptance driver: scanBoundedList (V2 findings 1-2)", () => {
  const endless = () => {
    let n = 0;
    return vi.fn(async () => ({
      has_more: true,
      data: [{ id: `obj_${++n}` }],
    }));
  };

  for (const cap of [1, 2, 5]) {
    it(`never requests more than its cap of ${cap} page(s)`, async () => {
      const list = endless();
      const scan = await scanBoundedList(list, {}, () => true, cap);
      expect(list).toHaveBeenCalledTimes(cap);
      expect(scan).toMatchObject({ pages: cap, exhausted: false });
    });
  }

  it("stops, unexhausted, when the cursor cannot advance or a has_more page is empty", async () => {
    const stuck = vi.fn(async () => ({
      has_more: true,
      data: [{ id: "same" }],
    }));
    expect(await scanBoundedList(stuck, {}, () => false, 10)).toMatchObject({
      pages: 2,
      exhausted: false,
    });
    const empty = vi.fn(async () => ({ has_more: true, data: [] }));
    expect(await scanBoundedList(empty, {}, () => false, 10)).toMatchObject({
      pages: 1,
      exhausted: false,
    });
  });

  it("is exhausted only on has_more=false, collecting matches from every page", async () => {
    const pages = [
      {
        has_more: true,
        data: [
          { id: "a", hit: false },
          { id: "b", hit: true },
        ],
      },
      { has_more: false, data: [{ id: "c", hit: true }] },
    ];
    const list = vi.fn(async () => pages.shift()!);
    const scan = await scanBoundedList(
      list,
      { created: { gte: 7 } },
      (x: { hit: boolean }) => x.hit,
      10,
    );
    expect(scan.exhausted).toBe(true);
    expect(scan.matches.map((m: { id: string }) => m.id)).toEqual(["b", "c"]);
    expect(list.mock.calls[1]).toEqual([
      { created: { gte: 7 }, limit: LIST_PAGE_SIZE, starting_after: "b" },
    ]);
  });

  it("refuses a missing, zero or large page cap", async () => {
    for (const cap of [undefined, 0, 51, 2.5])
      await expect(
        scanBoundedList(endless(), {}, () => true, cap as number),
      ).rejects.toThrow("page cap");
  });
});

describe("Stripe acceptance driver: V2 child-env, instructions and wording corrections (findings 5-7)", () => {
  it("a parent GITHUB_PAT never reaches the child, without a broad /PAT/ rule blanking ordinary names", () => {
    const env = buildStripeChildEnv(
      authorizedEnv({
        GITHUB_PAT: "github_pat_child_sentinel",
        COMPAT_MODE: "1",
      }),
      { port: 4321, token: "f".repeat(64), authorized: true },
    ) as Record<string, string>;
    expect(env.GITHUB_PAT).toBe("");
    expect(JSON.stringify(env)).not.toContain("github_pat_child_sentinel");
    expect(WITHHELD_FROM_STRIPE_APP).toContain("GITHUB_PAT");
    expect(env.COMPAT_MODE).toBe("1");
    expect(env.PATH).toBe("/usr/bin");
  });

  it("a full run's child never receives GITHUB_PAT", async () => {
    const { world } = await run();
    expect(world.childEnvs[0].GITHUB_PAT).toBe("");
  });

  it("sandbox instructions demand the test card, synthetic customer data and a private window", () => {
    const text = sandboxPaymentInstructions(
      "https://checkout.stripe.com/c/pay/cs_test_x",
    ).join("\n");
    for (const phrase of [
      "STRIPE TEST MODE",
      "private browser window",
      "sandbox test card",
      "NEVER enter a real card.",
      "If Checkout asks for a name, email, address or postcode, enter synthetic,",
      "non-personal test values only",
      "NEVER enter real card or personal customer details for this acceptance run.",
      "https://checkout.stripe.com/c/pay/cs_test_x",
      "Complete the sandbox Checkout, then press Enter to continue.",
    ])
      expect(text).toContain(phrase);
  });

  it("the reviewer PASS claims only what the database observed, not an absent Stripe session", async () => {
    const { by } = await run();
    const reviewer = by[SURFACES.REVIEWER_COMPLIMENTARY];
    expect(reviewer.status).toBe("PASS");
    expect(reviewer.reason).not.toMatch(/Stripe session/i);
    expect(reviewer.reason).toContain(
      "no commercial order or payment event for the course (the production ACCESS_GRANTED path does not enter paid checkout)",
    );
  });
});
