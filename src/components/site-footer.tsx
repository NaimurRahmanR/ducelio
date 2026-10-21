import Link from "next/link";
import { Brand } from "./ui";

// The public homepage footer. Every link goes to a page that exists and is
// public; nothing here points at the protected /support counsellor workspace
// or /student routes. No support channel, billing contact, email, phone,
// address, social account or legal page is published yet (LR-09), so the
// footer says so instead of inventing one.
export function SiteFooter({
  workspace,
}: {
  workspace: { href: string; label: string } | null;
}) {
  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <div className="site-footer-grid">
          <section aria-labelledby="footer-brand">
            <h2 id="footer-brand" className="sr-only">
              Ducelio
            </h2>
            <Brand />
            <p className="site-footer-tagline">
              An intelligent academy{" "}
              <span className="site-footer-gold">designed for you.</span>
            </p>
          </section>

          <nav aria-labelledby="footer-links">
            <h2 id="footer-links">Quick links</h2>
            <ul>
              <li>
                <Link href="/courses">Browse courses</Link>
              </li>
              {workspace ? (
                <li>
                  <Link href={workspace.href}>{workspace.label}</Link>
                </li>
              ) : (
                <>
                  <li>
                    <Link href="/login">Sign in</Link>
                  </li>
                  <li>
                    <Link href="/signup">Create an account</Link>
                  </li>
                </>
              )}
              <li>
                <Link href="/demo">Demo academy (fictional records)</Link>
              </li>
            </ul>
          </nav>

          <section aria-labelledby="footer-help">
            <h2 id="footer-help">Help &amp; Support</h2>
            <dl>
              <div>
                <dt>Course enquiries</dt>
                <dd>
                  Each course page sets out its format, price and cohort start
                  date.
                </dd>
              </div>
              <div>
                <dt>Account assistance</dt>
                <dd>
                  Forgotten your password?{" "}
                  <Link href="/forgot-password">Reset it here</Link>.
                </dd>
              </div>
              <div>
                <dt>Technical issues</dt>
                <dd>
                  Signed-in learners can ask Sarah, the AI learner guide, about
                  access and finding their way around.
                </dd>
              </div>
              <div>
                <dt>Billing support</dt>
                <dd>A billing support contact will be published here.</dd>
              </div>
            </dl>
          </section>

          <section aria-labelledby="footer-contact">
            <h2 id="footer-contact">Contact</h2>
            <p>
              Official contact details are being finalised and will be published
              here.
            </p>
          </section>
        </div>

        <div className="site-footer-bottom">
          <p>© {new Date().getFullYear()} Ducelio</p>
          <p>
            Ducelio prepares learners for external qualifications. It does not
            award them: qualifications and certifications are awarded only by
            the relevant examination body.
          </p>
        </div>
      </div>
    </footer>
  );
}
