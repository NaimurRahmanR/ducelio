import { AdminForbidden } from "@/components/admin-shell";
import {
  adminWorkspaceAccess,
  COURSE_ADMIN_ROLES,
} from "@/server/admin-access";
import Link from "next/link";
import { Bot, ExternalLink } from "lucide-react";
import {
  listCommercialV1Campaigns,
  listCommercialV1OfferActivations,
  listCommercialV1Offers,
} from "@/server/commercial-v1-commerce";
import { listCommerceOperations } from "@/server/commercial-v1-commerce/operations";
import { parseOfferRow, sourced } from "@/server/admin-control-centre";
import { AdminShell } from "@/components/admin-shell";
import {
  BarList,
  DataTable,
  Empty,
  LinkTabs,
  Panel,
  Pill,
  StatCard,
  Unavailable,
} from "@/components/admin-ui";
import {
  ArchiveCampaignForm,
  ArchiveOfferForm,
  CampaignList,
  CreateCampaignForm,
  PublishOfferForm,
} from "@/components/commerce-offer-forms";
import {
  CommerceOperationsConsole,
  type CommerceSearchParams,
} from "@/components/commerce-operations-console";
import { formatOfferPrice } from "@/domain/commercial-v1-commerce";
import { DELIVERY_PLAN_DEFINITIONS } from "@/domain/commercial-v1-launch";
import {
  isAcceptanceOffer,
  isAcceptanceOfferSlug,
  TEST_RECORD_NOTE,
} from "@/domain/admin-test-records";

export const dynamic = "force-dynamic";

const TABS = [
  { id: "offers", label: "Offers & pricing" },
  { id: "campaigns", label: "Discounts & campaigns" },
  { id: "orders", label: "Orders & payments" },
  { id: "exceptions", label: "Exceptions & reconciliation" },
  { id: "performance", label: "Sales performance" },
] as const;

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<CommerceSearchParams>;
}) {
  const access = await adminWorkspaceAccess(COURSE_ADMIN_ROLES);
  if (!access.allowed)
    return (
      <AdminForbidden
        actor={access.actor}
        active="sales"
        title="Sales & Commerce"
        requires={COURSE_ADMIN_ROLES}
      />
    );
  const actor = access.actor;
  const params = (await searchParams) ?? {};
  const tab = TABS.find((t) => t.id === params.tab)?.id ?? "offers";
  const [activations, campaigns, offersView, live] = await Promise.all([
    sourced(() => listCommercialV1OfferActivations()),
    sourced(() => listCommercialV1Campaigns()),
    sourced(() => listCommerceOperations({ view: "offers" })),
    sourced(() => listCommercialV1Offers()),
  ]);
  // Business figures exclude acceptance-test and staging records; those are
  // listed separately, labelled, and never counted as sales.
  const allOffers = offersView.ok
    ? offersView.data.rows.map(parseOfferRow)
    : [];
  const offerRows = allOffers.filter((o) => !isAcceptanceOffer(o));
  const testOffers = allOffers.filter((o) => isAcceptanceOffer(o));
  const testSlugs = new Set(testOffers.map((o) => o.slug));
  const isTestSlug = (slug: string) =>
    testSlugs.has(slug) || isAcceptanceOfferSlug(slug);
  const allPublished = allOffers.filter((o) => o.state === "PUBLISHED");
  const published = offerRows.filter((o) => o.state === "PUBLISHED");
  const testPublished = testOffers.filter((o) => o.state === "PUBLISHED");
  const unsold = activations.ok
    ? activations.data.filter(
        (a) =>
          !a.publishedOfferSlug &&
          !isAcceptanceOffer({
            slug: null,
            course: a.programmeTitle,
            cohort: a.cohortTitle,
          }),
      )
    : [];
  const businessCampaigns = campaigns.ok
    ? campaigns.data.filter((c) => !isTestSlug(c.offerSlug))
    : [];
  const testCampaigns = campaigns.ok
    ? campaigns.data.filter((c) => isTestSlug(c.offerSlug))
    : [];
  const activeCampaigns = businessCampaigns.filter((c) => c.state === "ACTIVE");
  const liveOffers = live.ok
    ? live.data.filter((o) => !isTestSlug(o.slug))
    : [];
  const liveSlugs = new Set(live.ok ? live.data.map((o) => o.slug) : []);
  const offerTable = (rows: typeof allOffers, caption: string) => (
    <DataTable
      caption={caption}
      columns={["Course", "Cohort", "Price", "Status", "Public page"]}
      rows={rows.map((o) => [
        <span key="c" className="ac-strong">
          {o.course}
        </span>,
        o.cohort,
        o.priceAmountMinor !== null && o.currency
          ? formatOfferPrice(o.priceAmountMinor, o.currency)
          : "—",
        o.state === "PUBLISHED" ? (
          <Pill key="s" tone="good">
            Published
          </Pill>
        ) : (
          <Pill key="s">Archived</Pill>
        ),
        o.state === "PUBLISHED" && liveSlugs.has(o.slug) ? (
          <Link key="l" href={`/courses/${o.slug}`} className="ac-link">
            /courses/{o.slug} <ExternalLink size={12} aria-hidden="true" />
          </Link>
        ) : (
          <span key="l" className="ac-muted">
            /courses/{o.slug}
          </span>
        ),
      ])}
      empty={
        <Empty title="No business offers yet">
          {testOffers.length
            ? "Only acceptance-test offers exist; they are listed separately below."
            : undefined}
        </Empty>
      }
    />
  );

  return (
    <AdminShell
      active="sales"
      name={actor.displayName}
      roles={actor.roles}
      title="Sales & Commerce"
      description="Offers, prices, campaigns, orders and payment exceptions. Prices and discounts are always computed by the server."
      actions={
        <Link
          href="/admin/operations-engineer?action=list_offers"
          className="ac-button"
        >
          <Bot size={16} aria-hidden="true" /> Ask Operations Engineer
        </Link>
      }
    >
      <div className="ac-stat-grid">
        <StatCard
          label="Published offers"
          value={offersView.ok ? published.length : "—"}
          detail={
            offersView.ok && offersView.data.hasMore
              ? "Of the latest 25 offers · test records excluded"
              : "Business offers · test records excluded"
          }
          href="/admin/sales?tab=offers"
        />
        <StatCard
          label="Activated, not yet on sale"
          value={activations.ok ? unsold.length : "—"}
          detail="Deliveries without an offer"
          href="/admin/sales?tab=offers#publish-offer"
        />
        <StatCard
          label="Active campaigns"
          value={campaigns.ok ? activeCampaigns.length : "—"}
          detail="Test campaigns excluded"
          href="/admin/sales?tab=campaigns"
        />
        <StatCard
          label="Acceptance-test offers"
          value={offersView.ok ? testPublished.length : "—"}
          detail={
            offersView.ok
              ? `Still published, not business · ${testOffers.length} test offers in all`
              : "Offers unavailable"
          }
          href="/admin/sales?tab=offers#test-offers"
          tone={testPublished.length > 0 ? "attention" : "default"}
        />
      </div>

      <LinkTabs
        label="Sales and commerce areas"
        active={tab}
        tabs={TABS.map((t) => ({
          id: t.id,
          label: t.label,
          href: `/admin/sales?tab=${t.id}`,
        }))}
      />

      {tab === "offers" && (
        <>
          <Panel
            id="offers"
            title="Offers and pricing"
            description="Every commercial offer, newest first, with its exact published price."
          >
            {!offersView.ok ? (
              <Unavailable what="Commercial offers" />
            ) : (
              offerTable(offerRows, "Business offers")
            )}
          </Panel>
          {testOffers.length > 0 && (
            <Panel
              id="test-offers"
              title="Acceptance-test and staging offers"
              description="Offers created for acceptance testing or sold to staging cohorts. They are not business offers and are excluded from every sales figure."
            >
              {testPublished.length > 0 && (
                <p className="ac-note">
                  {testPublished.length} of them are still published, so they
                  appear in the public catalogue. Archiving them is a deliberate
                  decision, made with “Archive an offer” below.
                </p>
              )}
              <details className="ac-details">
                <summary>
                  Show {testOffers.length} acceptance-test and staging offer
                  {testOffers.length === 1 ? "" : "s"}
                </summary>
                {offerTable(testOffers, "Acceptance-test and staging offers")}
              </details>
              <p className="ac-muted">{TEST_RECORD_NOTE}</p>
            </Panel>
          )}
          <div className="ac-grid-2">
            <Panel
              id="publish-offer"
              title="Publish an offer"
              description="Choose an activated delivery, its delivery plan and a one-time price in minor units (pence or cents). One published offer per activation."
            >
              {activations.ok ? (
                unsold.length ? (
                  <PublishOfferForm activations={activations.data} />
                ) : (
                  <Empty title="Every activated delivery already has an offer">
                    Activate another delivery in Courses first.
                  </Empty>
                )
              ) : (
                <Unavailable what="Activated deliveries" />
              )}
            </Panel>
            <Panel
              title="Archive an offer"
              description="Removes it from the public catalogue. Orders and entitlements are never changed."
            >
              <ArchiveOfferForm />
            </Panel>
          </div>
        </>
      )}

      {tab === "campaigns" && (
        <>
          <Panel id="campaigns" title="Campaigns">
            {campaigns.ok ? (
              <CampaignList campaigns={businessCampaigns} />
            ) : (
              <Unavailable what="Campaigns" />
            )}
            {testCampaigns.length > 0 && (
              <details className="ac-details">
                <summary>
                  Show {testCampaigns.length} acceptance-test campaign
                  {testCampaigns.length === 1 ? "" : "s"} (for test offers, not
                  counted)
                </summary>
                <CampaignList campaigns={testCampaigns} />
              </details>
            )}
          </Panel>
          <div className="ac-grid-2">
            <Panel
              title="Create a campaign"
              description="Deterministic pricing within a UTC window and a redemption limit. Reviewer campaigns never create a payment order."
            >
              <CreateCampaignForm
                publishedOfferSlugs={allPublished.map((o) => o.slug)}
              />
            </Panel>
            <Panel
              title="Archive a campaign"
              description="One-way. Existing redemptions keep their recorded price."
            >
              <ArchiveCampaignForm />
            </Panel>
          </div>
        </>
      )}

      {(tab === "orders" || tab === "exceptions") && (
        <Panel
          id={tab}
          title={
            tab === "orders"
              ? "Orders and payments"
              : "Payment exceptions and reconciliation"
          }
          description={
            tab === "orders"
              ? "Orders, entitlements, redemptions and learner access. A pending order is a payment attempt, not revenue."
              : "Payment events that did not resolve, and the governed retry and reconciliation actions."
          }
        >
          <p className="ac-note">
            This is the operational register: it lists every record, including
            acceptance-test traffic (offer slugs beginning “acceptance-”), so
            that each one can be inspected and corrected. It is not a measure of
            business performance.
          </p>
          <CommerceOperationsConsole
            params={{
              view: tab === "exceptions" ? "issues" : "orders",
              ...params,
            }}
            basePath="/admin/sales"
            baseParams={{ tab }}
          />
        </Panel>
      )}

      {tab === "performance" && (
        <>
          <Panel
            id="performance"
            title="Campaign redemptions"
            description="Recorded redemptions per business campaign code, from the campaign register. Acceptance-test campaigns are excluded."
          >
            {!campaigns.ok ? (
              <Unavailable what="Campaigns" />
            ) : businessCampaigns.length === 0 ? (
              <Empty title="No business campaigns yet">
                {testCampaigns.length > 0
                  ? `${testCampaigns.length} acceptance-test campaigns exist and are not counted.`
                  : undefined}
              </Empty>
            ) : (
              <BarList
                label="Redemptions by campaign"
                items={businessCampaigns.map((c) => ({
                  label: c.code,
                  value: c.redemptionCount,
                }))}
              />
            )}
          </Panel>
          <Panel
            title="Offers by delivery plan"
            description="Business offers in the public catalogue. Acceptance-test offers are excluded."
          >
            {live.ok ? (
              <BarList
                label="Published offers by delivery plan"
                items={Object.entries(DELIVERY_PLAN_DEFINITIONS).map(
                  ([plan, d]) => ({
                    label: d.label,
                    value: liveOffers.filter((o) => o.deliveryPlan === plan)
                      .length,
                  }),
                )}
              />
            ) : (
              <Unavailable what="The public catalogue" />
            )}
          </Panel>
          <Panel title="Revenue reporting">
            <p>
              Settled revenue is not reported here yet. The commerce records
              expose individual orders and verified payment events, but no
              reviewed aggregate of settled payments net of refunds exists, and
              adding up order attempts would overstate revenue.
            </p>
            <p className="ac-muted">
              Needed: a read-only, administrator-scoped database function that
              totals verified PAID payment events minus recorded refunds, per
              currency and period. It is listed in this release&apos;s required
              database changes and is not created here.
            </p>
          </Panel>
        </>
      )}
    </AdminShell>
  );
}
