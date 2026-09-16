import { requireAnyRole } from "@/server/identity";
import { listCommercialV1OfferActivations } from "@/server/commercial-v1-commerce";
import { StaffShell, adminSectionsForRoles } from "@/components/staff-shell";
import {
  PublishOfferForm,
  ArchiveOfferForm,
} from "@/components/commerce-offer-forms";
import { Card } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function Page() {
  const actor = await requireAnyRole(["ACADEMIC_ADMIN", "PLATFORM_ADMIN"]);
  const activations = await listCommercialV1OfferActivations().catch(() => []);
  return (
    <StaffShell
      kind="admin"
      name={actor.displayName}
      section="Programmes"
      sections={adminSectionsForRoles(actor.roles)}
    >
      <Card>
        <h2>Publish a commercial offer</h2>
        <p>
          Choose an activated course and set its sellable price. Only one
          published offer may exist per activation at a time.
        </p>
        <PublishOfferForm activations={activations} />
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
