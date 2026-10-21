import "server-only";
import { requireActor } from "./identity";
import type { Role } from "@/domain/academy";

export const COURSE_ADMIN_ROLES: readonly Role[] = [
  "ACADEMIC_ADMIN",
  "PLATFORM_ADMIN",
];
export const PLATFORM_ADMIN_ROLES: readonly Role[] = ["PLATFORM_ADMIN"];

// Page-level guard for every admin workspace. It is the first thing a page
// does, before any data is read:
// - signed out: redirected to sign in;
// - signed in without any administrative role (learner, instructor,
//   counsellor): redirected to sign in with the forbidden notice, exactly
//   as /admin always did;
// - an administrator without this workspace's role: allowed=false, so the
//   page renders a refusal inside the control centre and loads nothing.
// It is defence in depth, not the only check: every service this page then
// calls re-checks the role, and each database RPC checks it again.
export async function adminWorkspaceAccess(roles: readonly Role[]) {
  const actor = await requireActor("admin");
  return {
    actor,
    allowed: roles.some((role) => actor.roles.includes(role)),
  };
}
