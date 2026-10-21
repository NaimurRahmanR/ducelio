import { canEnter, type Actor } from "./policy";

// Where a signed-in visitor on a public page (homepage, catalogue) can go
// back to. Nothing here grants access: each destination enforces its own role.
export function workspaceFor(actor: Actor | null | undefined) {
  if (!actor) return null;
  if (canEnter(actor, "student"))
    return { href: "/student", label: "Go to your academy" };
  if (canEnter(actor, "admin"))
    return { href: "/admin", label: "Go to administration" };
  if (canEnter(actor, "support"))
    return { href: "/support", label: "Go to the counsellor workspace" };
  return null;
}
