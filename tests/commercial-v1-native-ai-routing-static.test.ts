import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const registry = readFileSync(
  "src/server/academic-runtime/profile-registry.ts",
  "utf8",
);
const provider = readFileSync(
  "src/server/academic-runtime/provider.ts",
  "utf8",
);
const envExample = readFileSync(".env.example", "utf8");

describe("PR22 native AI routing static safety", () => {
  it("keeps all production model identities server-owned", () => {
    expect(registry).toContain('model: "gpt-5.6-terra"');
    expect(registry).toContain('model: "gpt-5.6-luna"');
    expect(registry).toContain('model: "claude-sonnet-5"');
    expect(registry).toContain('model: "claude-opus-5-5"');
    expect(provider).not.toMatch(/request\.context\.model/);
    expect(provider).not.toMatch(/request\.context\.provider/);
  });

  it("uses fixed native API endpoints instead of environment-selected native endpoints", () => {
    expect(provider).toContain(
      'const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses"',
    );
    expect(provider).toContain(
      'const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages"',
    );
    expect(envExample).not.toContain("OPENAI_BASE_URL=");
    expect(envExample).not.toContain("ANTHROPIC_BASE_URL=");
  });

  it("keeps native secrets server-only", () => {
    expect(envExample).toContain("OPENAI_API_KEY=");
    expect(envExample).toContain("ANTHROPIC_API_KEY=");
    expect(envExample).not.toContain("NEXT_PUBLIC_OPENAI");
    expect(envExample).not.toContain("NEXT_PUBLIC_ANTHROPIC");
  });

  it("does not add an academic Counsellor provider path", () => {
    expect(registry).not.toContain("COUNSELLOR_COMMERCIAL_V1");
  });
});
