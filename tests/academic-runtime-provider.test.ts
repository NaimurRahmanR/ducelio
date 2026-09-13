import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfiguredProvider } from "@/server/academic-runtime/provider";

const ORIGINAL_BASE_URL = process.env.ACADEMIC_PROVIDER_BASE_URL;
const ORIGINAL_API_KEY = process.env.ACADEMIC_PROVIDER_API_KEY;

function setEnv(baseUrl: string | undefined, apiKey: string | undefined) {
  if (baseUrl === undefined) delete process.env.ACADEMIC_PROVIDER_BASE_URL;
  else process.env.ACADEMIC_PROVIDER_BASE_URL = baseUrl;
  if (apiKey === undefined) delete process.env.ACADEMIC_PROVIDER_API_KEY;
  else process.env.ACADEMIC_PROVIDER_API_KEY = apiKey;
}

afterEach(() => {
  setEnv(ORIGINAL_BASE_URL, ORIGINAL_API_KEY);
  vi.unstubAllGlobals();
});

describe("resolveConfiguredProvider fail-closed resolution", () => {
  it("returns null when both variables are unset", () => {
    setEnv(undefined, undefined);
    expect(resolveConfiguredProvider()).toBeNull();
  });

  it("returns null when only the base URL is set", () => {
    setEnv("https://provider.example.com/generate", undefined);
    expect(resolveConfiguredProvider()).toBeNull();
  });

  it("returns null when only the API key is set", () => {
    setEnv(undefined, "test-key");
    expect(resolveConfiguredProvider()).toBeNull();
  });

  it("rejects a non-HTTPS endpoint", () => {
    setEnv("http://provider.example.com/generate", "test-key");
    expect(resolveConfiguredProvider()).toBeNull();
  });

  it("rejects an endpoint with embedded userinfo credentials", () => {
    setEnv("https://user:pass@provider.example.com/generate", "test-key");
    expect(resolveConfiguredProvider()).toBeNull();
  });

  it("rejects an unparsable endpoint", () => {
    setEnv("not a url", "test-key");
    expect(resolveConfiguredProvider()).toBeNull();
  });

  it("resolves a real adapter for a well-formed HTTPS endpoint with no userinfo", () => {
    setEnv("https://provider.example.com/generate", "test-key");
    const adapter = resolveConfiguredProvider();
    expect(adapter).not.toBeNull();
    expect(adapter?.name).toBe("http-json");
  });
});

describe("HttpJsonProviderAdapter production hardening", () => {
  beforeEach(() => {
    setEnv("https://provider.example.com/generate", "test-secret-key");
  });

  it("never follows a redirect (credentials cannot move to a second host)", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.redirect).toBe("error");
      return new Response(
        JSON.stringify({
          outputText: "ok",
          usage: { inputTokens: 1, outputTokens: 1, estimatedCostMicrousd: 1 },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = resolveConfiguredProvider();
    await adapter?.generate(
      {
        role: "PROFESSOR",
        capability: "get_lesson_context",
        context: {},
        constraints: { maxOutputTokens: 10 },
      },
      new AbortController().signal,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never logs or throws the API key in an error message", async () => {
    const fetchMock = vi.fn(
      async () => new Response("not json", { status: 500 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = resolveConfiguredProvider();
    let caught: unknown;
    try {
      await adapter?.generate(
        {
          role: "PROFESSOR",
          capability: "get_lesson_context",
          context: {},
          constraints: { maxOutputTokens: 10 },
        },
        new AbortController().signal,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain("test-secret-key");
  });

  it("forwards the requested output-token ceiling in the request body", async () => {
    let capturedBody: string | undefined;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      return new Response(
        JSON.stringify({
          outputText: "ok",
          usage: { inputTokens: 1, outputTokens: 1, estimatedCostMicrousd: 1 },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = resolveConfiguredProvider();
    await adapter?.generate(
      {
        role: "PROFESSOR",
        capability: "get_lesson_context",
        context: {},
        constraints: { maxOutputTokens: 77 },
      },
      new AbortController().signal,
    );
    expect(JSON.parse(capturedBody ?? "{}").maxOutputTokens).toBe(77);
  });
});
