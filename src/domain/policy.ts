import type { Role } from "./academy";
export type Actor = { id: string; displayName: string; roles: Role[] };
export class AuthenticationRequired extends Error {
  constructor() {
    super("Authentication required");
    this.name = "AuthenticationRequired";
  }
}
export class AccessDenied extends Error {
  constructor() {
    super("Access denied");
    this.name = "AccessDenied";
  }
}
export type Area = "student" | "support" | "admin";
export function canEnter(actor: Actor, area: Area) {
  const roles: Role[] =
    area === "admin"
      ? ["ACADEMIC_ADMIN", "REGISTRAR", "PLATFORM_ADMIN"]
      : area === "support"
        ? ["COUNSELLOR"]
        : ["STUDENT"];
  return roles.some((role) => actor.roles.includes(role));
}
export function canAccessSupport(
  actor: Actor,
  studentId: string,
  assigned: boolean,
  privateRecord = false,
) {
  return (
    (actor.roles.includes("COUNSELLOR") && assigned) ||
    (!privateRecord &&
      actor.roles.includes("STUDENT") &&
      actor.id === studentId)
  );
}
export function assertArea(actor: Actor, area: Area) {
  if (!canEnter(actor, area)) throw new AccessDenied();
}
