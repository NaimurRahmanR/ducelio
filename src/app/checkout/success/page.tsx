import Link from "next/link";
import { Brand, Card, ButtonLink } from "@/components/ui";
import { requireActor } from "@/server/identity";
import { reconcileCommercialV1Order } from "@/server/commercial-v1-commerce";

export const dynamic = "force-dynamic";

// PR13 section 13: a success REDIRECT is never treated as payment proof.
// This page always performs SERVER-side reconciliation
// (reconcileCommercialV1Order) before ever saying a word about payment --
// it converges on the exact same trusted fulfillment authority the Stripe
// webhook uses, so whichever arrived first, the outcome shown here is
// database-authoritative.
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ order?: string; session_id?: string }>;
}) {
  await requireActor("student");
  const params = await searchParams;

  let state:
    | { kind: "missing" }
    | { kind: "fulfilled"; replay: boolean }
    | { kind: "not-paid" }
    | { kind: "requires-support" }
    | { kind: "revoked" }
    | { kind: "refunded" }
    | { kind: "denied" }
    | { kind: "unavailable" };

  if (!params.order || !params.session_id) {
    state = { kind: "missing" };
  } else {
    try {
      const result = await reconcileCommercialV1Order({
        orderId: params.order,
        sessionId: params.session_id,
      });
      if (result.ok && result.fulfilled) {
        state = { kind: "fulfilled", replay: result.replay };
      } else if (result.ok && !result.fulfilled) {
        state = { kind: "not-paid" };
      } else if (!result.ok && result.code === "CONFIGURATION_UNAVAILABLE") {
        state = { kind: "unavailable" };
      } else if (!result.ok && result.code === "ACCESS_REVOKED") {
        state = { kind: "revoked" };
      } else if (!result.ok && result.code === "ORDER_REFUNDED") {
        state = { kind: "refunded" };
      } else if (!result.ok && result.code === "ENROLMENT_NOT_ACTIVATABLE") {
        // Payment WAS verified but could not be applied automatically --
        // truthfully distinct from "we could not verify this payment".
        state = { kind: "requires-support" };
      } else {
        state = { kind: "denied" };
      }
    } catch {
      state = { kind: "unavailable" };
    }
  }

  return (
    <div className="foundation">
      <header className="courses-header">
        <Brand />
      </header>
      <div className="checkout-result">
        <Card>
          {state.kind === "fulfilled" ? (
            <>
              <h1>
                {state.replay ? "Already confirmed" : "Payment confirmed"}
              </h1>
              <p role="status">
                Your payment is verified and your course access has been set up.
                {state.replay ? " This confirmation was already recorded." : ""}
              </p>
              <ButtonLink href="/student/study-plan">
                Go to your study plan <span aria-hidden="true">→</span>
              </ButtonLink>
            </>
          ) : state.kind === "refunded" ? (
            <>
              <h1>Payment refunded</h1>
              <p role="status">
                This payment has been refunded and this order grants no course
                access. Any access granted by another purchase or an independent
                academic enrolment is unchanged.
              </p>
              <ButtonLink href="/student/study-plan">
                View your study plan
              </ButtonLink>
            </>
          ) : state.kind === "revoked" ? (
            <>
              <h1>Course access revoked</h1>
              <p role="alert">
                This order or entitlement has been refunded or cancelled.
                Historical records are retained. Contact support if you need
                help.
              </p>
            </>
          ) : state.kind === "not-paid" ? (
            <>
              <h1>Payment not confirmed</h1>
              <p role="alert">
                Stripe has not yet confirmed this payment. If you completed
                checkout, this usually resolves within a few minutes -- reload
                this page, or check your email for a receipt.
              </p>
            </>
          ) : state.kind === "requires-support" ? (
            <>
              <h1>Payment confirmed -- finishing setup</h1>
              <p role="alert">
                Your payment is verified, but we could not automatically set up
                your course access. Contact support with your order reference
                and we will complete this for you -- you will not be charged
                again.
              </p>
            </>
          ) : state.kind === "unavailable" ? (
            <>
              <h1>We could not verify this payment yet</h1>
              <p role="alert">
                Something prevented us from confirming your payment
                automatically. If you were charged, contact support with your
                order reference and we will verify it manually -- you will not
                be charged twice.
              </p>
            </>
          ) : state.kind === "denied" ? (
            <>
              <h1>We could not verify this payment</h1>
              <p role="alert">
                This checkout reference does not match a payment we can confirm.
                If you believe this is an error, contact support.
              </p>
            </>
          ) : (
            <>
              <h1>Missing checkout details</h1>
              <p role="alert">
                This link is missing the details we need to verify your payment.
                If you completed a purchase, check your email for a receipt or
                contact support.
              </p>
            </>
          )}
          <p className="muted">
            <Link href="/courses">Back to courses</Link>
          </p>
        </Card>
      </div>
    </div>
  );
}
