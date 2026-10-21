import Link from "next/link";
import { Brand } from "./ui";
import { getCurrentActor } from "@/server/identity";
import { workspaceFor } from "@/domain/public-workspace";

export type PublicWorkspace = ReturnType<typeof workspaceFor>;

// Where a signed-in visitor on a public course page can go back to. A
// visitor whose session cannot be resolved is treated as signed out.
export async function visitorWorkspace(): Promise<PublicWorkspace> {
  try {
    return workspaceFor(await getCurrentActor());
  } catch {
    return null;
  }
}

// The header shared by the course catalogue and course pages.
export function PublicHeader({
  workspace,
  catalogueLink = false,
}: {
  workspace: PublicWorkspace;
  catalogueLink?: boolean;
}) {
  return (
    <header className="courses-header">
      <Brand />
      <nav aria-label="Account" className="courses-nav">
        {catalogueLink && (
          <Link href="/courses" className="button secondary">
            All courses
          </Link>
        )}
        {workspace ? (
          <Link href={workspace.href} className="button">
            {workspace.label}
          </Link>
        ) : catalogueLink ? (
          // A course page already offers sign-in and sign-up next to its fee.
          <Link href="/login" className="button">
            Sign in
          </Link>
        ) : (
          <>
            <Link href="/login" className="button secondary">
              Sign in
            </Link>
            <Link href="/signup" className="button">
              Create account
            </Link>
          </>
        )}
      </nav>
    </header>
  );
}
