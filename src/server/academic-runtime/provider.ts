import "server-only";
import { z } from "zod";
import {
  ProviderFailure,
  type ProviderAdapter,
  type ProviderResponse,
  type RuntimeProviderRequest,
} from "@/domain/academic-runtime";

// Fail-closed resolver: returns null unless a real provider is configured
// through server-only environment variables. No vendor SDK is installed or
// imported here (no strategic provider choice is made by this layer); a
// real integration is a generic HTTP/JSON adapter the operator points at
// whichever endpoint they have reviewed and provisioned. These variables
// are never NEXT_PUBLIC_* and are never sent to browser code, logged, or
// echoed into any error/result. This is the adapter construction boundary
// only; authorization to reach it at all is decided entirely upstream by
// src/server/academic-runtime/profile-registry.ts and the composition
// boundary — this function makes no policy decision of its own beyond
// "is a production endpoint/credential present and well-formed".
export function resolveConfiguredProvider(): ProviderAdapter | null {
  const baseUrl = process.env.ACADEMIC_PROVIDER_BASE_URL;
  const apiKey = process.env.ACADEMIC_PROVIDER_API_KEY;
  if (!baseUrl || !apiKey) return null;
  if (!isSafeProviderEndpoint(baseUrl)) return null;
  return new HttpJsonProviderAdapter(baseUrl, apiKey);
}

// Production provider-endpoint policy, independent of any course/user
// input (the URL is only ever read from server environment configuration):
// HTTPS only, and no embedded userinfo (a URL like
// https://user:pass@host/ could otherwise leak credentials through the
// endpoint string itself rather than the authorization header).
function isSafeProviderEndpoint(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" && !url.username && !url.password;
}

const providerResponseSchema = z.strictObject({
  outputText: z.string().max(20000),
  usage: z.strictObject({
    inputTokens: z.number().int().min(0).max(200000),
    outputTokens: z.number().int().min(0).max(200000),
    estimatedCostMicrousd: z.number().int().min(0).max(5_000_000),
  }),
});

// A generic, provider-agnostic HTTP/JSON adapter. It is never exercised
// against a live provider by this checkpoint's local test gate; hosted
// provider-live acceptance remains outstanding and must not be implied by
// passing local tests (see docs/implementation-progress.md).
class HttpJsonProviderAdapter implements ProviderAdapter {
  readonly name = "http-json";
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async generate(
    request: RuntimeProviderRequest,
    signal: AbortSignal,
  ): Promise<ProviderResponse> {
    let res: Response;
    try {
      res = await fetch(this.baseUrl, {
        method: "POST",
        // A redirect is never followed: a 3xx response here is treated as a
        // network-level failure instead, so the bearer credential in the
        // Authorization header can never be silently replayed to a second,
        // unreviewed host.
        redirect: "error",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          role: request.role,
          capability: request.capability,
          context: request.context,
          // The server's requested generation ceiling, communicated to the
          // provider up front. The runtime still re-checks usage after the
          // call as a safety net; a provider is not guaranteed to honour
          // this request.
          maxOutputTokens: request.constraints.maxOutputTokens,
        }),
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new ProviderFailure(
        "PROVIDER_UNAVAILABLE",
        "The configured provider could not be reached.",
      );
    }
    if (res.status === 429)
      throw new ProviderFailure(
        "PROVIDER_RATE_LIMITED",
        "The configured provider rate-limited this request.",
      );
    if (res.status >= 500)
      throw new ProviderFailure(
        "PROVIDER_UNAVAILABLE",
        "The configured provider reported a server error.",
      );
    if (!res.ok)
      throw new ProviderFailure(
        "PROVIDER_ERROR",
        `The configured provider rejected this request (${res.status}).`,
      );
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new ProviderFailure(
        "PROVIDER_INVALID_RESPONSE",
        "The configured provider returned a non-JSON response.",
      );
    }
    const parsed = providerResponseSchema.safeParse(json);
    if (!parsed.success)
      throw new ProviderFailure(
        "PROVIDER_INVALID_RESPONSE",
        "The configured provider returned an unexpected response shape.",
      );
    return parsed.data;
  }
}
