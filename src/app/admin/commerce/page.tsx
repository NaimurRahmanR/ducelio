import { requireAnyRole } from "@/server/identity";
import {
  listCommercialV1Campaigns,
  listCommercialV1OfferActivations,
} from "@/server/commercial-v1-commerce";
import { StaffShell, adminSectionsForRoles } from "@/components/staff-shell";
import {
  ArchiveCampaignForm,
  ArchiveOfferForm,
  CampaignList,
  CreateCampaignForm,
  PublishOfferForm,
} from "@/components/commerce-offer-forms";
import { Card } from "@/components/ui";
import {
  CommerceOperationsConsole,
  type CommerceSearchParams,
} from "@/components/commerce-operations-console";

export const dynamic = "force-dynamic";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<CommerceSearchParams>;
}) {
  const actor = await requireAnyRole(["ACADEMIC_ADMIN", "PLATFORM_ADMIN"]);
  const [activations, campaigns] = await Promise.all([
    listCommercialV1OfferActivations(),
    listCommercialV1Campaigns(),
  ]);
  const publishedOfferSlugs = activations
    .map((activation) => activation.publishedOfferSlug)
    .filter((slug): slug is string => Boolean(slug));

  return (
    <StaffShell
      kind="admin"
      name={actor.displayName}
      section="Commerce"
      sections={adminSectionsForRoles(actor.roles)}
      roles={actor.roles}
    >
      <CommerceOperationsConsole params={(await searchParams) ?? {}} />
      <Card>
        <h2>Publish a commercial offer</h2>
        <p>
          Choose an activated course, its immutable delivery plan and its
          sellable one-time price. Only one published offer may exist per
          activation at a time.
        </p>
        <PublishOfferForm activations={activations} />
      </Card>
      <Card>
        <h2>Create a launch campaign</h2>
        <p>
          Campaign pricing is deterministic and bounded by its UTC window and
          redemption limit. Complimentary reviewer campaigns never fabricate a
          payment order.
        </p>
        <CreateCampaignForm publishedOfferSlugs={publishedOfferSlugs} />
      </Card>
      <Card>
        <h2>Campaigns</h2>
        <CampaignList campaigns={campaigns} />
      </Card>
      <Card>
        <h2>Archive a campaign</h2>
        <p>
          Archival is one-way. Existing redemption and entitlement provenance
          remains immutable.
        </p>
        <ArchiveCampaignForm />
      </Card>
      <Card>
        <h2>Archive a commercial offer</h2>
        <p>
          Removes an offer from the public catalogue. Existing orders and
          entitlements are never affected -- to sell the same course again at a
          different price, archive the old offer and publish a new one.
        </p>
        <ArchiveOfferForm />
      </Card>
    </StaffShell>
  );
}
