import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The public catalogue's failure diagnostics: every way list_commercial_v1_offers
// can be unavailable is classified server-side, while visitors still get one
// generic message. Only the Supabase client and configuration are stubbed.
const mocks = vi.hoisted(() => ({
  client: vi.fn(),
  rpc: vi.fn(),
  config: vi.fn(),
}));
vi.mock("@/server/identity", () => ({ requireActor: vi.fn() }));
vi.mock("@/server/supabase", () => ({ createSupabase: mocks.client }));
vi.mock("@/lib/env", () => ({
  config: mocks.config,
  commerceConfig: vi.fn(),
}));

import { listCommercialV1Offers } from "@/server/commercial-v1-commerce";
import {
  CatalogueUnavailableError,
  classifyInvalidResponse,
  classifyRpcFailure,
} from "@/server/commercial-v1-commerce/catalogue-diagnostics";

const SECRET_URL = "https://secret-project-ref.supabase.co";
const SECRET_KEY = "sb_publishable_SECRET_VALUE";
const offer = {
  slug: "organisation-course",
  title: "Organisation Course",
  examinationBody: "Partner Organisation",
  qualificationName: "Partner Certificate",
  priceAmountMinor: 4500,
  currency: "GBP",
  summary: null,
  cohortStartsOn: "2026-11-02",
  deliveryPlan: "STANDARD_6_WEEK",
};
let warn: { mock: { calls: unknown[][] }; mockRestore: () => void };
const logged = () =>
  warn.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");
const failure = async () => {
  const error = await listCommercialV1Offers().catch((e: unknown) => e);
  expect(error).toBeInstanceOf(CatalogueUnavailableError);
  // Visitors and callers only ever see the one generic message.
  expect((error as Error).message).toBe("Courses could not be loaded.");
  return (error as CatalogueUnavailableError).failure;
};

beforeEach(() => {
  vi.resetAllMocks();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.config.mockReturnValue({
    url: SECRET_URL,
    key: SECRET_KEY,
    configured: true,
  });
  mocks.client.mockResolvedValue({ rpc: mocks.rpc });
});
afterEach(() => warn.mockRestore());

describe("listCommercialV1Offers diagnostics", () => {
  it("returns every published offer, whoever runs the course", async () => {
    mocks.rpc.mockResolvedValue({ data: [offer], error: null, status: 200 });
    await expect(listCommercialV1Offers()).resolves.toEqual([offer]);
    expect(mocks.rpc).toHaveBeenCalledWith("list_commercial_v1_offers");
    expect(warn).not.toHaveBeenCalled();
  });

  it("treats an empty published catalogue as data, not a failure", async () => {
    mocks.rpc.mockResolvedValue({ data: [], error: null, status: 200 });
    await expect(listCommercialV1Offers()).resolves.toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("reports missing configuration without calling Supabase", async () => {
    mocks.config.mockReturnValue({ url: "", key: "", configured: false });
    expect((await failure()).reason).toBe("NOT_CONFIGURED");
    expect(mocks.client).not.toHaveBeenCalled();
    expect(logged()).toContain("[ducelio:catalogue-diagnostic]");
    expect(logged()).toContain('"reason":"NOT_CONFIGURED"');
  });

  it("reports configuration that fails validation", async () => {
    mocks.config.mockImplementation(() => {
      throw new Error(`Invalid URL ${SECRET_URL}`);
    });
    expect((await failure()).reason).toBe("INVALID_CONFIGURATION");
    expect(logged()).not.toContain(SECRET_URL);
  });

  it.each([
    [0, "", "RPC_UNREACHABLE"],
    [404, "PGRST202", "RPC_MISSING"],
    [403, "42501", "RPC_FORBIDDEN"],
    [401, "", "RPC_FORBIDDEN"],
    [500, "XX000", "RPC_ERROR"],
  ])("classifies an RPC response %i %s as %s", async (status, code, reason) => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code, message: `boom ${SECRET_KEY} ${SECRET_URL}` },
      status,
    });
    const result = await failure();
    expect(result.reason).toBe(reason);
    expect(result.httpStatus).toBe(status);
    // Never the message, URL or key.
    expect(logged()).not.toContain(SECRET_KEY);
    expect(logged()).not.toContain(SECRET_URL);
    expect(logged()).not.toContain("boom");
  });

  it("rejects a response outside the published-offer contract", async () => {
    mocks.rpc.mockResolvedValue({
      data: [{ ...offer, priceAmountMinor: 0 }],
      error: null,
      status: 200,
    });
    const result = await failure();
    expect(result).toMatchObject({
      reason: "INVALID_RESPONSE",
      issuePath: "0.priceAmountMinor",
      issueCount: 1,
    });
    expect(logged()).not.toContain("Organisation Course");
  });
});

describe("catalogue failure classification", () => {
  it("keeps only bounded codes and statuses", () => {
    expect(
      classifyRpcFailure(999, { code: "not a code; drop table" }),
    ).toMatchObject({ reason: "RPC_ERROR", httpStatus: null, errorCode: null });
  });

  it("never echoes data-derived path segments", () => {
    expect(
      classifyInvalidResponse([{ path: [2, "title with spaces"] }]),
    ).toMatchObject({ issuePath: "2.?", issueCount: 1 });
    expect(classifyInvalidResponse([{ path: [] }]).issuePath).toBe("(root)");
  });
});
