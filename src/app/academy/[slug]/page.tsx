import Link from "next/link";
import { notFound } from "next/navigation";
import { Card } from "@/components/ui";
import { PublicHeader, visitorWorkspace } from "@/components/public-header";
import { SiteFooter } from "@/components/site-footer";
import { AcademyFormatTable } from "@/components/academy-offer-card";
import { listAcademyCatalogue } from "@/server/academy-delivery";

export const dynamic = "force-dynamic";

// Public page of one Ducelio Academy offer. Every statement and price comes
// from the published offer. Online checkout for Academy formats is not yet
// connected, so no purchase control is shown.
export default async function Page({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const [catalogue, workspace] = await Promise.all([
    listAcademyCatalogue().catch(() => null),
    visitorWorkspace(),
  ]);
  const offer = catalogue?.find((o) => o.slug === slug);
  if (!offer) notFound();
  return (
    <div className="launch-home">
      <div className="foundation">
        <PublicHeader workspace={workspace} catalogueLink />
        <main id="main" tabIndex={-1} className="course-page">
          <section className="course-hero" aria-labelledby="course-title">
            <p className="course-hero-provider">DUCELIO ACADEMY · SELF-PACED</p>
            <h1 id="course-title">{offer.title}</h1>
            <p className="course-hero-intro">
              {offer.summary ?? offer.description}
            </p>
          </section>
          <div className="section-content acad-learner">
            <Card>
              <h2>Choose your pace</h2>
              <p className="muted">
                Every format teaches the same {offer.lessons} lessons,{" "}
                {offer.labs} practical activities and {offer.assessments}{" "}
                assessments to the same standard. You pick the format, your
                start date, your study days and your class time; your
                assessments are scheduled from your own timetable.
              </p>
              <AcademyFormatTable offer={offer} />
            </Card>
            <Card>
              <h2>About this course</h2>
              <p>{offer.description}</p>
              {offer.qualificationPreparation && (
                <p className="muted">
                  {offer.qualificationPreparation.disclaimer}
                </p>
              )}
              {offer.demoContent && (
                <p className="badge muted">Demonstration content</p>
              )}
            </Card>
            <Card>
              <h2>How to join</h2>
              <p>
                Online checkout for Academy courses is not yet open. Learners
                with approved access will find this course under{" "}
                <Link href="/student/academy">My Academy courses</Link>.
              </p>
            </Card>
          </div>
        </main>
      </div>
      <SiteFooter workspace={workspace} />
    </div>
  );
}
