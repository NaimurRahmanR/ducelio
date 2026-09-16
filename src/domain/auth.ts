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
//    recovery destination, the public course catalogue, and one specific
//    published course page. Any other same-origin path (/admin, /api/...,
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
export function safeAuthDestination(
  value: string | null | undefined,
  fallback = "/student",
) {
  const resolved = parseSameOriginPath(value);
  if (!resolved) return fallback;
  // Query/hash are never part of the allowlisted destinations themselves --
  // dropped rather than merely ignored, so nothing downstream can be
  // steered by an unexamined suffix.
  const rawPathname = resolved.split(/[?#]/)[0];
  // V3 correction (defect 2): "/courses/" (a bare trailing slash, no slug)
  // is the SAME bounded public catalogue destination as "/courses" --
  // deterministically canonicalized to it rather than rejected, so the
  // allowlist below only ever needs the one canonical entry.
  const pathname = rawPathname === "/courses/" ? "/courses" : rawPathname;
  if (ALLOWED_AUTH_PATHS.has(pathname)) return pathname;
  const course = /^\/courses\/([a-z0-9-]{3,80})$/.exec(pathname);
  if (course && OFFER_SLUG_SEGMENT.test(course[1])) return pathname;
  return fallback;
}
export const confirmationTypeSchema = z.enum(["email", "recovery"]);
export type AuthState = { error?: string; message?: string };
