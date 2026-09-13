import "server-only";
import {
  ProviderFailure,
  type ProviderAdapter,
  type ProviderFailureCode,
  type ProviderResponse,
  type RuntimeProviderRequest,
} from "@/domain/academic-runtime";

// TEST-ONLY deterministic adapter. No production code path imports this
// module or ever registers it as a configured provider; resolveConfiguredProvider
// (./provider.ts) never returns it. It refuses to run outside test/development
// so a fake response can never reach a real production path even by mistake.
export class DeterministicFakeProviderAdapter implements ProviderAdapter {
  readonly name = "deterministic-fake";
  private calls = 0;
  private requests: RuntimeProviderRequest[] = [];

  constructor(
    private readonly script: Array<
      | { kind: "success"; response: ProviderResponse; delayMs?: number }
      | { kind: "failure"; code: ProviderFailureCode; delayMs?: number }
      | { kind: "hang" }
    >,
  ) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "DeterministicFakeProviderAdapter must never run in production.",
      );
    }
  }

  get callCount() {
    return this.calls;
  }

  // Exposed for tests that need to assert exactly what the runtime sent the
  // adapter (e.g. the requested output-token ceiling), without weakening
  // the adapter/runtime boundary itself.
  get lastRequest(): RuntimeProviderRequest | undefined {
    return this.requests[this.requests.length - 1];
  }

  async generate(
    request: RuntimeProviderRequest,
    signal: AbortSignal,
  ): Promise<ProviderResponse> {
    this.requests.push(request);
    const step = this.script[Math.min(this.calls, this.script.length - 1)];
    this.calls += 1;
    if (step.kind === "hang") {
      await new Promise((_, reject) => {
        signal.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      });
      throw new Error("unreachable");
    }
    if (step.delayMs) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, step.delayMs);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    }
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    if (step.kind === "failure")
      throw new ProviderFailure(step.code, "Deterministic test failure.");
    return step.response;
  }
}
