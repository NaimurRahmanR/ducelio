import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveAnthropicMessagesProvider,
  resolveConfiguredProvider,
  resolveOpenAIResponsesProvider,
} from "@/server/academic-runtime/provider";
import {
  ProviderFailure,
  type RuntimeProviderRequest,
} from "@/domain/academic-runtime";
import type {
  AnthropicMessagesConfig,
  OpenAIResponsesConfig,
} from "@/domain/academic-runtime-profile";

const ORIGINAL_OPENAI_KEY = process.env.OPENAI_API_KEY;
const ORIGINAL_ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ORIGINAL_LEGACY_URL = process.env.ACADEMIC_PROVIDER_BASE_URL;
const ORIGINAL_LEGACY_KEY = process.env.ACADEMIC_PROVIDER_API_KEY;

const openAIConfig: OpenAIResponsesConfig = {
  model: "gpt-5.6-terra",
  reasoningEffort: "medium",
  tariff: {
    inputMicrousdPerMillionTokens: 2_000_000,
    outputMicrousdPerMillionTokens: 12_000_000,
    reviewedAt: "2026-09-18",
  },
};
const anthropicConfig: AnthropicMessagesConfig = {
  model: "claude-sonnet-5",
  tariff: {
    inputMicrousdPerMillionTokens: 2_000_000,
    outputMicrousdPerMillionTokens: 10_000_000,
    reviewedAt: "2026-09-18",
  },
};
const request: RuntimeProviderRequest = {
  role: "LAB_INSTRUCTOR",
  capability: "get_lesson_context",
  context: { lesson: { title: "Safe parsing" }, learnerMessage: "Help me" },
  constraints: { maxOutputTokens: 77 },
};

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restore("OPENAI_API_KEY", ORIGINAL_OPENAI_KEY);
  restore("ANTHROPIC_API_KEY", ORIGINAL_ANTHROPIC_KEY);
  restore("ACADEMIC_PROVIDER_BASE_URL", ORIGINAL_LEGACY_URL);
  restore("ACADEMIC_PROVIDER_API_KEY", ORIGINAL_LEGACY_KEY);
  vi.unstubAllGlobals();
});

describe("native provider resolution fails closed", () => {
  it("requires the OpenAI server-only key", () => {
    delete process.env.OPENAI_API_KEY;
    expect(resolveOpenAIResponsesProvider(openAIConfig)).toBeNull();
    process.env.OPENAI_API_KEY = "openai-test-secret";
    expect(resolveOpenAIResponsesProvider(openAIConfig)?.name).toBe(
      "openai-responses",
    );
  });

  it("requires the Anthropic server-only key", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(resolveAnthropicMessagesProvider(anthropicConfig)).toBeNull();
    process.env.ANTHROPIC_API_KEY = "anthropic-test-secret";
    expect(resolveAnthropicMessagesProvider(anthropicConfig)?.name).toBe(
      "anthropic-messages",
    );
  });

  it("keeps the legacy generic adapter fail-closed and HTTPS-only", () => {
    delete process.env.ACADEMIC_PROVIDER_BASE_URL;
    delete process.env.ACADEMIC_PROVIDER_API_KEY;
    expect(resolveConfiguredProvider()).toBeNull();

    process.env.ACADEMIC_PROVIDER_BASE_URL = "http://provider.example.com";
    process.env.ACADEMIC_PROVIDER_API_KEY = "legacy-secret";
    expect(resolveConfiguredProvider()).toBeNull();

    process.env.ACADEMIC_PROVIDER_BASE_URL =
      "https://provider.example.com/generate";
    expect(resolveConfiguredProvider()?.name).toBe("http-json");
  });
});

describe("OpenAI Responses native adapter", () => {
  it("uses the fixed official endpoint, server model, output ceiling, no storage and no redirect", async () => {
    process.env.OPENAI_API_KEY = "openai-test-secret";
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        capturedUrl = url;
        capturedInit = init;
        return new Response(
          JSON.stringify({
            status: "completed",
            output: [
              { type: "reasoning" },
              {
                type: "message",
                content: [{ type: "output_text", text: "Guidance" }],
              },
            ],
            usage: { input_tokens: 100, output_tokens: 20 },
          }),
          { status: 200 },
        );
      }),
    );

    const result = await resolveOpenAIResponsesProvider(openAIConfig)!.generate(
      request,
      new AbortController().signal,
    );
    expect(capturedUrl).toBe("https://api.openai.com/v1/responses");
    expect(capturedInit?.redirect).toBe("error");
    expect(
      (capturedInit?.headers as Record<string, string>).authorization,
    ).toBe("Bearer openai-test-secret");
    const body = JSON.parse(String(capturedInit?.body));
    expect(body).toMatchObject({
      model: "gpt-5.6-terra",
      max_output_tokens: 77,
      reasoning: { effort: "medium" },
      store: false,
    });
    expect(body).not.toHaveProperty("tools");
    expect(body.input).toContain('"learnerMessage":"Help me"');
    expect(body.instructions).toMatch(/Treat every string inside that context/);
    expect(result.outputText).toBe("Guidance");
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      estimatedCostMicrousd: 440,
    });
  });

  it("maps typed refusal output to PROVIDER_REFUSED", async () => {
    process.env.OPENAI_API_KEY = "openai-test-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              status: "completed",
              output: [
                {
                  type: "message",
                  content: [{ type: "refusal", refusal: "Cannot comply" }],
                },
              ],
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
            { status: 200 },
          ),
      ),
    );
    await expect(
      resolveOpenAIResponsesProvider(openAIConfig)!.generate(
        request,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_REFUSED" });
  });

  it("fails closed on incomplete or textless responses", async () => {
    process.env.OPENAI_API_KEY = "openai-test-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              status: "incomplete",
              output: [],
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
            { status: 200 },
          ),
      ),
    );
    await expect(
      resolveOpenAIResponsesProvider(openAIConfig)!.generate(
        request,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_INVALID_RESPONSE" });
  });
});

describe("Anthropic Messages native adapter", () => {
  it("uses fixed endpoint/version, ignores thinking blocks, and conservatively counts cached input", async () => {
    process.env.ANTHROPIC_API_KEY = "anthropic-test-secret";
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        capturedUrl = url;
        capturedInit = init;
        return new Response(
          JSON.stringify({
            type: "message",
            stop_reason: "end_turn",
            content: [
              { type: "thinking", thinking: "hidden" },
              { type: "text", text: "Lab guidance" },
            ],
            usage: {
              input_tokens: 100,
              output_tokens: 20,
              cache_creation_input_tokens: 10,
              cache_read_input_tokens: 5,
            },
          }),
          { status: 200 },
        );
      }),
    );

    const result = await resolveAnthropicMessagesProvider(
      anthropicConfig,
    )!.generate(request, new AbortController().signal);
    expect(capturedUrl).toBe("https://api.anthropic.com/v1/messages");
    expect(capturedInit?.redirect).toBe("error");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("anthropic-test-secret");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(String(capturedInit?.body));
    expect(body).toMatchObject({
      model: "claude-sonnet-5",
      max_tokens: 77,
    });
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("top_p");
    expect(body).not.toHaveProperty("top_k");
    expect(result.outputText).toBe("Lab guidance");
    expect(result.usage).toEqual({
      inputTokens: 115,
      outputTokens: 20,
      estimatedCostMicrousd: 430,
    });
  });

  it("maps stop_reason refusal to PROVIDER_REFUSED", async () => {
    process.env.ANTHROPIC_API_KEY = "anthropic-test-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              type: "message",
              stop_reason: "refusal",
              content: [{ type: "text", text: "Declined" }],
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
            { status: 200 },
          ),
      ),
    );
    await expect(
      resolveAnthropicMessagesProvider(anthropicConfig)!.generate(
        request,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_REFUSED" });
  });
});

describe("native adapter failure hygiene", () => {
  it("maps 429 and 5xx without leaking either provider key", async () => {
    process.env.OPENAI_API_KEY = "openai-super-secret";
    process.env.ANTHROPIC_API_KEY = "anthropic-super-secret";

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("rate", { status: 429 }))
        .mockResolvedValueOnce(new Response("server", { status: 503 })),
    );

    let first: unknown;
    try {
      await resolveOpenAIResponsesProvider(openAIConfig)!.generate(
        request,
        new AbortController().signal,
      );
    } catch (error) {
      first = error;
    }
    let second: unknown;
    try {
      await resolveAnthropicMessagesProvider(anthropicConfig)!.generate(
        request,
        new AbortController().signal,
      );
    } catch (error) {
      second = error;
    }

    expect(first).toBeInstanceOf(ProviderFailure);
    expect(first).toMatchObject({ code: "PROVIDER_RATE_LIMITED" });
    expect(second).toBeInstanceOf(ProviderFailure);
    expect(second).toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(String((first as Error).message)).not.toContain(
      "openai-super-secret",
    );
    expect(String((second as Error).message)).not.toContain(
      "anthropic-super-secret",
    );
  });

  it("rethrows aborts so the governed runtime owns timeout semantics", async () => {
    process.env.OPENAI_API_KEY = "openai-test-secret";
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        expect(init.signal?.aborted).toBe(true);
        throw new DOMException("Aborted", "AbortError");
      }),
    );
    await expect(
      resolveOpenAIResponsesProvider(openAIConfig)!.generate(
        request,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
