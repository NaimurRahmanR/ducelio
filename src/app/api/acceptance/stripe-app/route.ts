import { NextResponse } from "next/server";
import { z } from "zod";
import { signInSchema } from "@/domain/auth";
import { offerSlugSchema } from "@/domain/commercial-v1-commerce";
import { campaignCodeSchema } from "@/domain/commercial-v1-launch";
import { AccessDenied, AuthenticationRequired } from "@/domain/policy";
import { createSupabase } from "@/server/supabase";
import { acceptanceEnvironmentMatches } from "@/server/acceptance-app-driver";
import { stripeAcceptanceRequestAllowed } from "@/server/stripe-acceptance-driver";
import {
  createCommercialV1Checkout,
  reconcileCommercialV1Order,
} from "@/server/commercial-v1-commerce";

// ============================================================================
// ACCEPTANCE-ONLY. Not a product API and never a commerce API. See
// src/server/stripe-acceptance-driver.ts for the fail-closed gate (404
// unless every acceptance condition holds) and scripts/acceptance/stripe.mjs
// for its only caller.
//
// Each operation is a thin HTTP hop into an EXISTING production entrypoint,
// executed inside a real Next.js request so identity resolves exactly as it
// does for the product (Supabase SSR session cookies ->
// getAuthenticatedActor()):
//
//   CREATE_CHECKOUT -> createCommercialV1Checkout (the learner "Buy" action)
//   RECONCILE_ORDER -> reconcileCommercialV1Order (the success page)
//
// This file never calls Stripe, never reads a Stripe key, webhook secret or
// commerce controller key, and never builds a fulfillment claim. Stripe
// webhook delivery is exercised against the UNCHANGED production route
// src/app/api/commerce/stripe-webhook/route.ts, never through here.
//
// Every schema is a strictObject: a caller-supplied amount, currency,
// learner/student/actor id, entitlement id, activation/cohort override,
// provider, Stripe key, webhook secret, HMAC, URL or function name is
// rejected with 400 before any server function runs. Responses carry only
// bounded statuses, codes and identifiers.
// ============================================================================

export const dynamic = "force-dynamic";

// Stripe TEST-mode Checkout Session ids only: this route can never be
// pointed at a live-mode session.
const testCheckoutSessionId = z.string().regex(/^cs_test_[0-9A-Za-z]{1,190}$/);

const requestSchema = z.discriminatedUnion("operation", [
  // Establishes a genuine Supabase Auth session through the normal SSR
  // cookie adapter (the same signInWithPassword + confirmed-email rule as
  // src/app/auth/actions.ts's login). Credentials are never echoed and no
  // session token is ever returned in the body.
  z.strictObject({
    operation: z.literal("SIGN_IN"),
    email: z.string().max(254),
    password: z.string().max(128),
  }),
  z.strictObject({
    operation: z.literal("CREATE_CHECKOUT"),
    offerSlug: offerSlugSchema,
    campaignCode: campaignCodeSchema.optional(),
  }),
  z.strictObject({
    operation: z.literal("RECONCILE_ORDER"),
    orderId: z.uuid(),
    sessionId: testCheckoutSessionId,
  }),
]);

const NO_STORE = { "Cache-Control": "private, no-store" };
function json(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}
function notFound() {
  return new NextResponse(null, { status: 404, headers: NO_STORE });
}

export async function POST(request: Request) {
  if (!stripeAcceptanceRequestAllowed(request)) return notFound();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "INVALID_REQUEST" });
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) return json(400, { error: "INVALID_REQUEST" });
  const command = parsed.data;

  const client = await createSupabase();
  if (command.operation === "SIGN_IN") {
    const credentials = signInSchema.safeParse({
      email: command.email,
      password: command.password,
    });
    if (!credentials.success) return json(400, { error: "INVALID_REQUEST" });
    const { data, error } = await client.auth.signInWithPassword(
      credentials.data,
    );
    if (error || !data.user?.email_confirmed_at) {
      await client.auth.signOut().catch(() => {});
      return json(401, { error: "AUTHENTICATION_FAILED" });
    }
    if (!(await acceptanceEnvironmentMatches(client))) {
      await client.auth.signOut().catch(() => {});
      return notFound();
    }
    return json(200, { ok: true });
  }

  // Every other operation runs as the caller's EXISTING real session, and
  // only once that session proves it belongs to the deliberately
  // provisioned acceptance environment.
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) return json(401, { error: "AUTHENTICATION_REQUIRED" });
  if (!(await acceptanceEnvironmentMatches(client))) return notFound();

  try {
    switch (command.operation) {
      case "CREATE_CHECKOUT": {
        const result = await createCommercialV1Checkout(
          command.offerSlug,
          command.campaignCode,
        );
        if (!result.ok)
          return json(200, {
            ok: true,
            result: { ok: false, code: result.code },
          });
        if (result.kind === "CHECKOUT")
          return json(200, {
            ok: true,
            result: {
              ok: true,
              kind: "CHECKOUT",
              orderId: result.orderId,
              url: result.url,
            },
          });
        return json(200, {
          ok: true,
          result: {
            ok: true,
            kind: "ACCESS_GRANTED",
            entitlementId: result.entitlementId,
            enrolmentId: result.enrolmentId,
            offerSlug: result.offerSlug,
          },
        });
      }
      case "RECONCILE_ORDER": {
        const result = await reconcileCommercialV1Order({
          orderId: command.orderId,
          sessionId: command.sessionId,
        });
        return json(200, {
          ok: true,
          result: {
            ok: result.ok,
            fulfilled: "fulfilled" in result ? result.fulfilled : null,
            replay: "replay" in result ? result.replay : null,
            code: "code" in result ? result.code : null,
            orderId: "orderId" in result ? result.orderId : null,
          },
        });
      }
    }
  } catch (error) {
    if (error instanceof AuthenticationRequired)
      return json(401, { error: "AUTHENTICATION_REQUIRED" });
    if (error instanceof AccessDenied) return json(403, { error: "FORBIDDEN" });
    return json(500, { error: "OPERATION_FAILED" });
  }
}
