import "server-only";

// Temporary, development-only OAuth diagnostics. The auth callback converts
// every failure into one generic public error, which hides WHICH step of the
// PKCE flow failed. Each record below is built only from fixed keys, booleans,
// bounded enum-like codes and an HTTP status. It never contains the
// authorization code, PKCE verifier, tokens, cookie values, flow id values,
// error descriptions/messages or any URL/query string, and nothing here is
// ever returned to the browser.
const PREFIX = "[ducelio:oauth-diagnostic]";
const CODE = /^[a-z0-9_]{1,64}$/;
const NAME = /^[A-Za-z]{1,64}$/;
// @supabase/ssr chunks large cookies as `<name>.<n>`.
const VERIFIER_COOKIE = /-code-verifier(\.\d+)?$/;
const SESSION_COOKIE = /^sb-[A-Za-z0-9]+-auth-token(\.\d+)?$/;

export type OAuthCallbackOutcome =
  | "EXCHANGED"
  | "NOT_CONFIGURED"
  | "PROVIDER_ERROR"
  | "NO_CODE"
  | "VERIFIER_MISSING"
  | "EXCHANGE_REJECTED"
  | "EXCHANGE_TRANSPORT"
  | "EXCHANGE_SERVER_ERROR"
  | "EXCHANGE_FAILED";

export function oauthDiagnosticsEnabled() {
  return process.env.NODE_ENV === "development";
}

function boundedCode(value: unknown) {
  return typeof value === "string" && CODE.test(value) ? value : null;
}

function errorFields(error: unknown) {
  if (!error || typeof error !== "object")
    return { errorName: null, errorCode: null, errorStatus: null };
  const { name, code, status } = error as {
    name?: unknown;
    code?: unknown;
    status?: unknown;
  };
  return {
    errorName: typeof name === "string" && NAME.test(name) ? name : "Unknown",
    errorCode: boundedCode(code),
    errorStatus:
      typeof status === "number" &&
      Number.isInteger(status) &&
      status >= 0 &&
      status < 600
        ? status
        : null,
  };
}

export function hostMatchesAppUrl(host: string | null, appUrl: string) {
  return host !== null && host.toLowerCase() === new URL(appUrl).host;
}

export function cookiePresence(names: readonly string[]) {
  return {
    verifierCookiePresent: names.some((name) => VERIFIER_COOKIE.test(name)),
    sessionCookiePresent: names.some((name) => SESSION_COOKIE.test(name)),
  };
}

export function classifyExchange(error: unknown): OAuthCallbackOutcome {
  if (!error) return "EXCHANGED";
  const { errorName, errorStatus } = errorFields(error);
  if (errorName === "AuthPKCECodeVerifierMissingError")
    return "VERIFIER_MISSING";
  // auth-js reports a network failure as status 0 and every 5xx answer as
  // AuthRetryableFetchError with that status.
  if (errorStatus === 0) return "EXCHANGE_TRANSPORT";
  if (errorStatus !== null && errorStatus >= 500)
    return "EXCHANGE_SERVER_ERROR";
  if (errorName === "AuthApiError") return "EXCHANGE_REJECTED";
  return "EXCHANGE_FAILED";
}

export function logOAuthStart(input: {
  provider: "google" | "linkedin_oidc";
  requestHost: string | null;
  appUrl: string;
  cookieNames: readonly string[];
  authorizeUrlReturned: boolean;
  error: unknown;
}) {
  if (!oauthDiagnosticsEnabled()) return;
  console.warn(
    PREFIX,
    JSON.stringify({
      stage: "start",
      provider: input.provider,
      requestHostMatchesAppUrl: hostMatchesAppUrl(
        input.requestHost,
        input.appUrl,
      ),
      verifierCookieWritten: cookiePresence(input.cookieNames)
        .verifierCookiePresent,
      authorizeUrlReturned: input.authorizeUrlReturned,
      ...errorFields(input.error),
    }),
  );
}

export function logOAuthCallback(input: {
  configured: boolean;
  params: URLSearchParams;
  requestHost: string | null;
  appUrl: string;
  cookieNames: readonly string[];
  exchangeAttempted: boolean;
  error: unknown;
}) {
  if (!oauthDiagnosticsEnabled()) return;
  const hasCode = input.params.has("code");
  const providerError = boundedCode(input.params.get("error"));
  const outcome: OAuthCallbackOutcome = !input.configured
    ? "NOT_CONFIGURED"
    : input.exchangeAttempted
      ? classifyExchange(input.error)
      : input.params.has("error")
        ? "PROVIDER_ERROR"
        : "NO_CODE";
  console.warn(
    PREFIX,
    JSON.stringify({
      stage: "callback",
      outcome,
      hasCode,
      hasFlowId: input.params.has("sb_flow_id"),
      providerError,
      providerErrorCode: boundedCode(input.params.get("error_code")),
      requestHostMatchesAppUrl: hostMatchesAppUrl(
        input.requestHost,
        input.appUrl,
      ),
      ...cookiePresence(input.cookieNames),
      ...errorFields(input.exchangeAttempted ? input.error : null),
    }),
  );
}
