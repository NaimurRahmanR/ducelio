// Structural-only JWT inspection for the acceptance harness. This module
// NEVER verifies a signature, NEVER needs (or reads) any signing secret,
// and is NEVER itself acceptance evidence -- it exists only so
// ACCEPTANCE_EXPIRED_LEARNER_JWT (docs/38 section 3) can be confirmed
// genuinely expired (its `exp` claim is a past Unix timestamp) BEFORE
// surfaces.mjs sends it to the real hosted Supabase/PostgREST server,
// which is the actual, authoritative party that verifies it and produces
// the acceptance evidence. Acceptance-tooling-only; never imported by
// src/**; never logs or returns the raw token, only decoded claims the
// caller explicitly asks for.
function base64UrlDecode(segment) {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padding =
    padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return Buffer.from(padded + padding, "base64").toString("utf8");
}

/**
 * Returns the decoded payload object of a structurally JWT-shaped token
 * (three dot-separated base64url segments, middle segment valid JSON), or
 * null if the token is not shaped like a JWT at all. Never checks the
 * signature (the third segment) -- decoding the payload requires no
 * secret, exactly like any browser devtools JWT inspector.
 */
export function decodeJwtPayloadStructurally(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1]));
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

/** True only if `token` is structurally JWT-shaped. */
export function isStructurallyJwtShaped(token) {
  return decodeJwtPayloadStructurally(token) !== null;
}

/**
 * True only if `token` is structurally JWT-shaped AND its `exp` claim
 * (seconds since epoch, the standard JWT convention) is a genuinely past
 * timestamp -- comfortably past it, by at least `skewSeconds`, if given.
 * False for anything not structurally JWT-shaped, missing an `exp`
 * claim, or not (comfortably) expired -- callers must never treat
 * "false" here as itself proof the token is valid; it only gates whether
 * this harness may honestly claim to be testing GENUINE expiry. This is
 * only ever a LOCAL prerequisite check -- the actual expired-JWT
 * evidence is the real hosted PostgREST server's own rejection (see
 * supabase.mjs's isJwtExpiryRejection), never this function alone.
 *
 * `skewSeconds` (default 0) lets a caller require the expiry to be
 * comfortably beyond ordinary server clock-skew tolerance, so a token
 * that expired only moments ago (which some JWT verifiers deliberately
 * still accept, within a small skew allowance) is never mistaken for a
 * genuinely, unambiguously expired one.
 */
export function isStructurallyExpiredJwt(token, skewSeconds = 0) {
  const payload = decodeJwtPayloadStructurally(token);
  if (!payload || typeof payload.exp !== "number") return false;
  return payload.exp * 1000 < Date.now() - skewSeconds * 1000;
}
