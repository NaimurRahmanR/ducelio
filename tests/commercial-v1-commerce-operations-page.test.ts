import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  diagnose: vi.fn(),
  authorise: vi.fn(),
}));
vi.mock("@/server/commercial-v1-commerce/operations", () => ({
  listCommerceOperations: mocks.list,
  diagnoseCommerceAccess: mocks.diagnose,
}));
vi.mock("@/server/identity", () => ({ requireAnyRole: mocks.authorise }));
vi.mock("@/server/commercial-v1-commerce", () => ({
  listCommercialV1Campaigns: async () => [],
  listCommercialV1OfferActivations: async () => [],
}));
vi.mock("@/components/commerce-operation-form", () => ({
  CommerceOperationForm: ({ operation }: { operation: string }) =>
    `CONTROL:${operation}`,
}));
import { CommerceOperationsConsole } from "@/components/commerce-operations-console";
import CommercePage from "@/app/admin/commerce/page";
const id = "10000000-0000-4000-8000-000000000001";
beforeEach(() => {
  vi.resetAllMocks();
  mocks.list.mockResolvedValue({ hasMore: false, rows: [] });
});
describe("admin commerce operational console", () => {
  it("page denies unauthorised access before retrieving commerce records", async () => {
    mocks.authorise.mockRejectedValue(new Error("Access denied"));
    await expect(
      CommercePage({ searchParams: Promise.resolve({}) }),
    ).rejects.toThrow("Access denied");
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it("renders search and honest empty results", async () => {
    const html = renderToStaticMarkup(
      await CommerceOperationsConsole({ params: {} }),
    );
    expect(html).toContain("Commerce operations");
    expect(html).toContain("No matching records");
    expect(html).toContain('name="q"');
    expect(html).toContain("Campaign redemptions");
  });
  it("orders link to database access diagnosis and preserve pagination", async () => {
    mocks.list.mockResolvedValue({
      hasMore: true,
      rows: [
        {
          id,
          title: "A learner",
          subtitle: "test-course",
          state: "PENDING",
          occurredAt: null,
          orderId: id,
          entitlementId: null,
          learnerId: id,
          offerId: id,
          reason: "PAID_AWAITING_FULFILMENT",
        },
      ],
    });
    const html = renderToStaticMarkup(
      await CommerceOperationsConsole({ params: { q: "learner" } }),
    );
    expect(html).toContain("Inspect order and access");
    expect(html).toContain("order=" + id);
    expect(html).toContain("offset=25");
    expect(html).toContain("Payment evidence exists");
  });
  it("unresolved receipt exposes governed retry with bounded diagnosis", async () => {
    mocks.list.mockResolvedValue({
      hasMore: false,
      rows: [
        {
          id,
          title: "evt_failure",
          subtitle: "checkout.session.completed",
          state: "UNRESOLVED",
          occurredAt: null,
          orderId: null,
          entitlementId: null,
          learnerId: null,
          offerId: null,
          reason: "ORDER_NOT_FOUND",
        },
      ],
    });
    const html = renderToStaticMarkup(
      await CommerceOperationsConsole({ params: { view: "issues" } }),
    );
    expect(html).toContain("CONTROL:retry");
    expect(html).toContain("ORDER_NOT_FOUND");
  });
  it("learner selection links to course selection without typed opaque IDs", async () => {
    mocks.list.mockResolvedValue({
      hasMore: false,
      rows: [
        {
          id,
          title: "A learner",
          subtitle: "D0001",
          state: "LEARNER",
          occurredAt: null,
          orderId: null,
          entitlementId: null,
          learnerId: id,
          offerId: null,
          reason: null,
        },
      ],
    });
    const html = renderToStaticMarkup(
      await CommerceOperationsConsole({ params: { view: "learners" } }),
    );
    expect(html).toContain("Choose course for diagnosis");
    expect(html).toContain("view=offers");
  });
  it("renders stored user content as text", async () => {
    mocks.list.mockResolvedValue({
      hasMore: false,
      rows: [
        {
          id,
          title: "<script>secret()</script>",
          subtitle: "course",
          state: "PENDING",
          occurredAt: null,
          orderId: id,
          entitlementId: null,
          learnerId: id,
          offerId: id,
          reason: null,
        },
      ],
    });
    const html = renderToStaticMarkup(
      await CommerceOperationsConsole({ params: {} }),
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
});
