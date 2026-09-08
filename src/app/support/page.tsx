import { requireActor } from "@/server/identity";
import { Brand,EmptyState } from "@/components/ui";
export default async function Page(){await requireActor("support");return <main id="main" className="foundation"><Brand/><EmptyState title="Your support workspace">Your assigned learners will appear here.</EmptyState></main>;}