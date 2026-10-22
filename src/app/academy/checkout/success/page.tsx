import Link from "next/link";
import { z } from "zod";
import { requireActor } from "@/server/identity";
import { reconcileAcademyOrder } from "@/server/academy-commerce";
import { PublicHeader, visitorWorkspace } from "@/components/public-header";
import { SiteFooter } from "@/components/site-footer";
import { Card } from "@/components/ui";

export const dynamic = "force-dynamic";

// The redirect itself proves nothing: access is granted only by the database
// fulfilment authority after the payment is verified with Stripe.
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ order?: string; session_id?: string }>;
}) {
  await requireActor("student");
  const params = await searchParams;
  const valid =
    z.uuid().safeParse(params.order).success &&
    typeof params.session_id === "string";
  const result = valid
    ? await reconcileAcademyOrder({
        orderId: params.order,
        sessionId: params.session_id,
      }).catch(() => null)
    : null;
  const workspace = await visitorWorkspace();
  const paid = result?.ok && result.fulfilled;
  return (
    <div className="launch-home">
      <div className="foundation">
        <PublicHeader workspace={workspace} catalogueLink />
        <main id="main" tabIndex={-1} className="course-page">
          <div className="section-content acad-learner">
            <Card>
              <h1>{paid ? "Payment confirmed" : "Checking your payment"}</h1>
              <p role="status">
                {paid
                  ? "Your course is ready. Choose your start date and study days to build your timetable."
                  : result?.ok
                    ? "Stripe has not confirmed this payment yet. If you paid, refresh in a moment; nothing is charged twice."
                    : "We could not confirm this payment. Nothing has been granted. If you were charged, contact support with your receipt."}
              </p>
              <Link className="button" href="/student/academy">
                Open My Academy courses
              </Link>
            </Card>
          </div>
        </main>
      </div>
      <SiteFooter workspace={workspace} />
    </div>
  );
}
