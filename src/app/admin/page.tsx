import { requireActor } from "@/server/identity";
import { Brand,EmptyState } from "@/components/ui";
export default async function Page(){await requireActor("admin");return <main id="main" className="foundation"><Brand/><EmptyState title="Academy administration">Institutional operations are being established.</EmptyState></main>;}