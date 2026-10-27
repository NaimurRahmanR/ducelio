import { z } from "zod";
export const emailSchema = z.email().trim().max(254);
export const passwordSchema = z
  .string()
  .min(12, "Use at least 12 characters.")
  .max(128, "Use no more than 128 characters.");
export const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});
export const signUpSchema = signInSchema.extend({
  displayName: z.string().trim().min(1).max(100),
  password: passwordSchema,
});
// PR13 section 11 (V2 correction): a BOUNDED return-target allowlist, so a
// commercial purchase's selected course/checkout destination survives
// signup/login/email verification without turning `next=` into an
// arbitrary same-origin redirect. Two layers:
//
// 1. parseSameOriginPath rejects every open-redirect SHAPE (absolute
//    external URL, protocol-relative "//host", a scheme like
//    "javascript:", encoded tricks) by resolving the candidate against a
//    fixed dummy origin via the WHATWG URL parser -- the same parsing
//    algorithm a browser's own Location handling uses -- and requiring the
//    result to still be that same dummy origin. A literal backslash is
//    rejected outright first, since some historical URL/redirect handling
//    treats "\" as "/" (the classic "/\evil.example" bypass) even though
//    this parser does not.
// 2. safeAuthDestination then checks the resulting pathname against a
//    SMALL, EXPLICIT allowlist of destinations an existing Ducelio auth
//    flow actually needs -- the default learner home, the password-
//    recovery destination, the public course catalogue, one specific
//    published course page, and (LR-03) the checkout success return for one
//    validated order and session. Any other same-origin path (/admin, /api/...,
//    an internal implementation route, an unrecognised path) still falls
//    back to the default -- being same-origin is necessary, never
//    sufficient.
const LOCAL_PATH_ORIGIN = "http://ducelio.local-path.invalid";
function parseSameOriginPath(value: string | null | undefined): string | null {
  if (!value || value.length > 2048) return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  if (value.includes("\\")) return null;
  let resolved: URL;
  try {
    resolved = new URL(value, LOCAL_PATH_ORIGIN);
  } catch {
    return null;
  }
  if (resolved.origin !== LOCAL_PATH_ORIGIN) return null;
  const path = resolved.pathname + resolved.search + resolved.hash;
  if (!path.startsWith("/") || path.startsWith("//")) return null;
  return path;
}
const OFFER_SLUG_SEGMENT = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ALLOWED_AUTH_PATHS = new Set(["/student", "/reset-password", "/courses"]);
const CHECKOUT_ORDER =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CHECKOUT_SESSION = /^cs_(test|live)_[A-Za-z0-9]{1,190}$/;
// LR-03: the ONE destination that keeps a query. A buyer whose sign-in
// lapsed during Stripe Checkout returns to the success page, which must
// survive login to reconcile that exact order. Accepted only with exactly
// `order` (UUID) and `session_id` (Stripe Checkout Session id), each once,
// and no fragment; it is rebuilt from the validated values, never passed
// through. The success page still requires the signed-in owner of the
// order and verifies payment server-side.
function checkoutSuccessDestination(resolved: string) {
  const url = new URL(resolved, LOCAL_PATH_ORIGIN);
  if (url.hash) return null;
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 2 || new Set(keys).size !== 2) return null;
  const order = url.searchParams.get("order");
  const session = url.searchParams.get("session_id");
  if (!order || !session) return null;
  if (!CHECKOUT_ORDER.test(order) || !CHECKOUT_SESSION.test(session))
    return null;
  return `/checkout/success?order=${order}&session_id=${session}`;
}
export function safeAuthDestination(
  value: string | null | undefined,
  fallback = "/student",
) {
  const resolved = parseSameOriginPath(value);
  if (!resolved) return fallback;
  // Query/hash are never part of the allowlisted destinations themselves --
  // dropped rather than merely ignored, so nothing downstream can be
  // steered by an unexamined suffix. The single exception is the checkout
  // success page below, whose two values are validated and rebuilt.
  const rawPathname = resolved.split(/[?#]/)[0];
  // V3 correction (defect 2): "/courses/" (a bare trailing slash, no slug)
  // is the SAME bounded public catalogue destination as "/courses" --
  // deterministically canonicalized to it rather than rejected, so the
  // allowlist below only ever needs the one canonical entry.
  const pathname = rawPathname === "/courses/" ? "/courses" : rawPathname;
  if (ALLOWED_AUTH_PATHS.has(pathname)) return pathname;
  if (pathname === "/checkout/success")
    return checkoutSuccessDestination(resolved) ?? fallback;
  const course = /^\/courses\/([a-z0-9-]{3,80})$/.exec(pathname);
  if (course && OFFER_SLUG_SEGMENT.test(course[1])) return pathname;
  return fallback;
}
// "email_change" completes Supabase Auth's verified email-change flow; the
// confirm route sends it to a fixed profile destination, never to `next`.
export const confirmationTypeSchema = z.enum([
  "email",
  "recovery",
  "email_change",
]);
export const EMAIL_CHANGE_CONFIRMED_PATH =
  "/student/profile?email-change=link-accepted";
export type AuthState = { error?: string; message?: string };

// Where a newly signed-in account lands when no explicit, allowlisted return
// destination was requested. Administrators reach the control centre first
// (even if they also hold a learner role); learners keep /student. This only
// picks a starting page: the destination enforces its own authority.
const ADMIN_HOME_ROLES = ["ACADEMIC_ADMIN", "REGISTRAR", "PLATFORM_ADMIN"];
export function signInHome(roles: readonly string[]) {
  if (roles.some((role) => ADMIN_HOME_ROLES.includes(role))) return "/admin";
  if (roles.includes("STUDENT")) return "/student";
  if (roles.includes("COUNSELLOR")) return "/support";
  return "/student";
}
