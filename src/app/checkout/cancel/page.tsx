import Link from "next/link";
import { Brand, Card } from "@/components/ui";

export const dynamic = "force-dynamic";

// PR13 section 13: a cancel-URL visit is NEVER treated as authoritative
// financial state (V2 correction, finding 8) -- it only means the browser
// was sent back here. No order state is read or written here, and this
// page makes no claim about whether a charge did or did not occur.
export default function Page() {
  return (
    <div className="foundation">
      <header className="courses-header">
        <Brand />
      </header>
      <main id="main" tabIndex={-1} className="checkout-result">
        <Card>
          <h1>Checkout was not completed here</h1>
          <p>
            Ducelio has not confirmed a completed payment from this page. If you
            believe a payment was taken, contact support and we will verify it.
            Otherwise, you can pick up where you left off whenever you are
            ready.
          </p>
          <Link href="/courses" className="button">
            Back to courses <span aria-hidden="true">→</span>
          </Link>
        </Card>
      </main>
    </div>
  );
}
