import "server-only";

// Server-side diagnostics for the public course catalogue. Visitors only ever
// see one generic "could not be loaded" message; this records WHICH step
// failed so an operator can tell a missing configuration from a database or
// RPC fault or a response that broke the published-offer contract. Each
// record is built only from a fixed reason, an HTTP status and bounded
// PostgREST/PostgreSQL codes or schema paths. It never contains the Supabase
// URL, keys, cookies, error messages or offer contents, and nothing here is
// ever returned to the browser.
//
// An empty catalogue is not a failure: list_commercial_v1_offers returns []
// when no offer is in the PUBLISHED state, and the page says so.
const PREFIX = "[ducelio:catalogue-diagnostic]";
const CODE = /^[A-Za-z0-9_]{1,32}$/;
const PATH_SEGMENT = /^[A-Za-z0-9_]{1,64}$/;

export type CatalogueFailureReason =
  // NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY absent.
  | "NOT_CONFIGURED"
  // Present but rejected by config validation (for example a non-HTTP URL).
  | "INVALID_CONFIGURATION"
  // No HTTP response: DNS, network or TLS failure (postgrest-js status 0).
  | "RPC_UNREACHABLE"
  // The RPC is not exposed: migration not applied or schema cache stale.
  | "RPC_MISSING"
  // The API key or role was refused, or EXECUTE is not granted.
  | "RPC_FORBIDDEN"
  // Any other database/RPC error response.
  | "RPC_ERROR"
  // The RPC answered, but not with the published-offer contract.
  | "INVALID_RESPONSE";

export type CatalogueFailure = {
  reason: CatalogueFailureReason;
  httpStatus: number | null;
  errorCode: string | null;
  issuePath: string | null;
  issueCount: number | null;
};

export class CatalogueUnavailableError extends Error {
  readonly failure: CatalogueFailure;
  constructor(failure: CatalogueFailure) {
    super("Courses could not be loaded.");
    this.name = "CatalogueUnavailableError";
    this.failure = failure;
  }
}

function boundedCode(value: unknown) {
  return typeof value === "string" && CODE.test(value) ? value : null;
}

function boundedStatus(value: unknown) {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < 600
    ? value
    : null;
}

export function catalogueFailure(
  reason: CatalogueFailureReason,
  fields: Partial<Omit<CatalogueFailure, "reason">> = {},
): CatalogueFailure {
  return {
    reason,
    httpStatus: null,
    errorCode: null,
    issuePath: null,
    issueCount: null,
    ...fields,
  };
}

export function classifyRpcFailure(
  status: unknown,
  error: { code?: unknown } | null,
): CatalogueFailure {
  const httpStatus = boundedStatus(status);
  const errorCode = boundedCode(error?.code);
  const reason: CatalogueFailureReason =
    httpStatus === 0
      ? "RPC_UNREACHABLE"
      : errorCode === "PGRST202" || errorCode === "42883" || httpStatus === 404
        ? "RPC_MISSING"
        : errorCode === "42501" ||
            errorCode === "PGRST301" ||
            errorCode === "PGRST302" ||
            httpStatus === 401 ||
            httpStatus === 403
          ? "RPC_FORBIDDEN"
          : "RPC_ERROR";
  return catalogueFailure(reason, { httpStatus, errorCode });
}

export function classifyInvalidResponse(
  issues: readonly { path: readonly PropertyKey[] }[],
): CatalogueFailure {
  const first = issues[0]?.path ?? [];
  const segments = first.map((segment) =>
    typeof segment === "number"
      ? String(segment)
      : typeof segment === "string" && PATH_SEGMENT.test(segment)
        ? segment
        : "?",
  );
  return catalogueFailure("INVALID_RESPONSE", {
    issuePath: segments.length ? segments.join(".") : "(root)",
    issueCount: issues.length,
  });
}

export function logCatalogueFailure(failure: CatalogueFailure) {
  console.warn(PREFIX, JSON.stringify({ stage: "list", ...failure }));
}
