import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseCoursePrice,
  unifiedPublicationSchema,
} from "@/domain/unified-course-engine";
import { approvedTestPackage } from "./academy-fixture";

const m = vi.hoisted(() => ({
  actor: vi.fn(),
  rpc: vi.fn(),
  upload: vi.fn(),
  validate: vi.fn(),
}));
vi.mock("@/server/identity", () => ({ getAuthenticatedActor: m.actor }));
vi.mock("@/server/supabase", () => ({
  createSupabase: async () => ({ rpc: m.rpc }),
}));
vi.mock("@/server/academy-course-engineering", () => ({
  uploadAcademyPackage: m.upload,
  validateAcademyPackage: m.validate,
}));
import {
  configureUnifiedCourseAgents,
  publishUnifiedCourse,
} from "@/server/unified-course-engine";

const id = "10000000-0000-4000-8000-000000000101";
const input = {
  packageId: id,
  slug: "synthetic-test",
  currency: "GBP",
  amountMinor: 1999,
  summary: null,
  reason: "Synthetic acceptance test",
};

beforeEach(() => {
  vi.resetAllMocks();
  m.actor.mockResolvedValue({ roles: ["ACADEMIC_ADMIN"] });
});

describe("one-price input and server authority", () => {
  it.each([
    ["1", 100],
    ["1.2", 120],
    ["1.23", 123],
    ["1000000.00", 100000000],
  ])("parses %s without rounding", (value, expected) =>
    expect(parseCoursePrice(value)).toBe(expected),
  );
  it.each([
    "0",
    "-1",
    "1.234",
    "1e3",
    "NaN",
    "Infinity",
    "1000000.01",
    "",
    "£5",
  ])("rejects invalid price %s", (value) =>
    expect(() => parseCoursePrice(value)).toThrow(),
  );
  it("rejects client-supplied authority and duration fields", () => {
    for (const extra of [
      { actorId: id },
      { organisationId: id },
      { role: "PLATFORM_ADMIN" },
      { formatId: "STANDARD_6W" },
    ])
      expect(
        unifiedPublicationSchema.safeParse({ ...input, ...extra }).success,
      ).toBe(false);
  });
  it.each([
    null,
    { roles: ["STUDENT"] },
    { roles: ["REGISTRAR"] },
    { roles: ["INSTRUCTOR"] },
  ])("denies unauthorised actors before DB access", async (actor) => {
    m.actor.mockResolvedValue(actor);
    await expect(publishUnifiedCourse(input)).rejects.toThrow("FORBIDDEN");
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it("calls one publication RPC with terms only", async () => {
    const data = { courseId: id, offerId: id, replayed: false };
    m.rpc.mockResolvedValue({ data, error: null });
    expect(await publishUnifiedCourse(input)).toEqual(data);
    expect(m.rpc).toHaveBeenCalledExactlyOnceWith("publish_unified_course", {
      p_package_id: id,
      p_offer_slug: input.slug,
      p_currency: "GBP",
      p_amount_minor: 1999,
      p_summary: null,
      p_reason: input.reason,
    });
  });
  it("does not expose raw SQL errors", async () => {
    m.rpc.mockResolvedValue({
      error: { message: "SECRET database protected text" },
    });
    await expect(publishUnifiedCourse(input)).rejects.toThrow(
      "SERVICE_UNAVAILABLE",
    );
  });
  it("leaves matching agent configuration and package history alone", async () => {
    const pkg = approvedTestPackage();
    m.rpc.mockResolvedValue({ data: pkg, error: null });
    expect(
      await configureUnifiedCourseAgents(
        id,
        pkg.curriculum.agentConfiguration,
        input.reason,
      ),
    ).toBe(id);
    expect(m.rpc).toHaveBeenCalledTimes(1);
  });
  it("records changed agents as a validated new revision and never mutates the original", async () => {
    const pkg = approvedTestPackage();
    const original = structuredClone(pkg);
    const agents = structuredClone(pkg.curriculum.agentConfiguration);
    agents.PROFESSOR.instructionalNotes = "Synthetic revised recorded notes";
    m.rpc
      .mockResolvedValueOnce({ data: pkg, error: null })
      .mockResolvedValueOnce({ data: id, error: null })
      .mockResolvedValueOnce({ data: { status: "UPLOADED" }, error: null });
    m.validate.mockResolvedValue({ valid: true });
    expect(await configureUnifiedCourseAgents(id, agents, input.reason)).toBe(
      id,
    );
    const revised = m.rpc.mock.calls.find(
      (c) => c[0] === "upload_unified_course_package",
    )![1].p_raw_package;
    expect(revised.packageRevision).toBe(pkg.packageRevision + 1);
    expect(revised.curriculum.packageRevision).toBe(revised.packageRevision);
    expect(revised.curriculum.agentConfiguration).toEqual(agents);
    expect(pkg).toEqual(original);
    expect(m.validate).toHaveBeenCalledWith(id, input.reason);
  });
  it("does not revalidate or rewrite an identical configuration revision already published on retry", async () => {
    const pkg = approvedTestPackage();
    const agents = structuredClone(pkg.curriculum.agentConfiguration);
    agents.PROFESSOR.instructionalNotes = "Synthetic revised recorded notes";
    m.rpc
      .mockResolvedValueOnce({ data: pkg, error: null })
      .mockResolvedValueOnce({ data: id, error: null })
      .mockResolvedValueOnce({ data: { status: "PUBLISHED" }, error: null });
    expect(await configureUnifiedCourseAgents(id, agents, input.reason)).toBe(
      id,
    );
    expect(m.validate).not.toHaveBeenCalled();
  });
});
