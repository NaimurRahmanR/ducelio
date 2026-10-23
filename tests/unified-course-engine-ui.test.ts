import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { approvedTestPackage } from "./academy-fixture";
import { validateAcademyCoursePackage } from "@/domain/academy-course-package";
import { agentConfigurationSchema } from "@/domain/course-package";

const m = vi.hoisted(() => ({
  actor: vi.fn(),
  organisations: vi.fn(),
  list: vi.fn(),
  review: vi.fn(),
  agents: vi.fn(),
  publish: vi.fn(),
  configure: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement("a", { href }, children),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/admin/course-engineering",
  redirect: (url: string) => {
    throw new Error("REDIRECT:" + url);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: m.refresh }));
vi.mock("@/app/auth/actions", () => ({ logout: vi.fn() }));
vi.mock("@/server/identity", () => ({
  getAuthenticatedActor: m.actor,
  requireActor: m.actor,
}));
vi.mock("@/server/course-organisations", () => ({
  courseEngineeringAccess: async () => {
    const actor = await m.actor();
    return {
      actor,
      organisations: await m.organisations(),
      allowed:
        actor.roles.includes("ACADEMIC_ADMIN") ||
        actor.roles.includes("PLATFORM_ADMIN") ||
        (await m.organisations()).length > 0,
    };
  },
}));
vi.mock("@/server/unified-course-engine", () => ({
  listUnifiedCoursePackages: m.list,
  getUnifiedCourseAgents: m.agents,
  publishUnifiedCourse: m.publish,
  configureUnifiedCourseAgents: m.configure,
}));
vi.mock("@/server/academy-course-engineering", () => ({
  getAcademyPackageReview: m.review,
  listAcademyLabSubmissions: async () => [],
}));
import Page from "@/app/admin/course-engineering/page";
import OldPage from "@/app/admin/academy-course-engineering/page";
import { publishUnifiedAction } from "@/app/admin/course-engineering/unified-actions";

const id = "10000000-0000-4000-8000-000000000101";
const pkg = approvedTestPackage();
const checked = validateAcademyCoursePackage(pkg);
if (!checked.valid) throw new Error("Invalid synthetic fixture");
const row = {
  id,
  packageKey: pkg.packageKey,
  packageRevision: 1,
  status: "VALIDATED",
  curriculumImport: null,
  course: null,
  pendingDecisions: [],
};
const render = async (query = { packageId: id }) =>
  renderToStaticMarkup(await Page({ searchParams: Promise.resolve(query) }));
function form() {
  const f = new FormData();
  for (const [k, v] of Object.entries({
    packageId: id,
    slug: "synthetic-test",
    price: "99.99",
    currency: "GBP",
    reason: "Synthetic publication review",
    confirm: "on",
  }))
    f.set(k, v);
  for (const [role, cfg] of Object.entries(
    agentConfigurationSchema.parse(pkg.curriculum.agentConfiguration),
  )) {
    if (cfg.enabled) f.set(`${role}_enabled`, "on");
    f.set(`${role}_profile`, cfg.modelProfileRef ?? "");
    f.set(`${role}_notes`, cfg.instructionalNotes ?? "");
    for (const c of cfg.capabilities) f.set(`${role}_capability_${c}`, "on");
  }
  return f;
}
beforeEach(() => {
  vi.resetAllMocks();
  m.organisations.mockResolvedValue([]);
  m.actor.mockResolvedValue({
    id,
    displayName: "Admin",
    roles: ["ACADEMIC_ADMIN"],
  });
  m.list.mockResolvedValue([row]);
  m.review.mockResolvedValue({
    id,
    status: "VALIDATED",
    review: checked.review,
  });
  m.agents.mockResolvedValue(
    structuredClone(pkg.curriculum.agentConfiguration),
  );
  m.configure.mockResolvedValue(id);
  m.publish.mockResolvedValue({ courseId: id, offerId: id, replayed: false });
});
describe("single course engineering flow", () => {
  it("admits an external owner without granting global administrator roles", async () => {
    m.actor.mockResolvedValue({
      id,
      displayName: "External owner",
      roles: ["STUDENT"],
    });
    m.organisations.mockResolvedValue([
      {
        id,
        name: "External Organisation",
        slug: "external-org",
        canManage: true,
        canReview: true,
        canOwn: true,
      },
    ]);
    const html = await render();
    expect(html).toContain("External Organisation");
    expect(html).toContain('name="organisationId"');
    expect(html).toContain("Organisation permissions");
    expect(html).not.toContain("Host an organisation");
    expect(html).toContain("Publish");
  });

  it("denies registrars before reading any package", async () => {
    m.actor.mockResolvedValue({
      id,
      displayName: "Registrar",
      roles: ["REGISTRAR"],
    });
    expect(await render()).toContain(
      "You do not have access to this workspace",
    );
    expect(m.list).not.toHaveBeenCalled();
    expect(m.review).not.toHaveBeenCalled();
    expect(m.agents).not.toHaveBeenCalled();
  });
  it("offers one price, every configured role and one publish action without cohort setup", async () => {
    const html = await render();
    for (const text of [
      "Upload JSON",
      "Set price",
      "Configure agents",
      "Publish course",
      'name="price"',
      "PROFESSOR",
      "TUTOR",
      "LAB INSTRUCTOR",
      "EXAMINER",
      "COUNSELLOR",
    ])
      expect(html).toContain(text);
    expect(html).not.toMatch(
      /name="price_|Approve curriculum and run|Organisation Course Engineering|\/admin\/activation/,
    );
  });
  it("does not expose protected package data in its review or serialized children", async () => {
    const review = {
      ...checked.review,
      answerKey: "PRIVATE_SENTINEL",
      markingGuidance: "PRIVATE_SENTINEL",
    };
    m.review.mockResolvedValue({ id, status: "VALIDATED", review });
    expect(await render()).not.toContain("PRIVATE_SENTINEL");
  });
  it("distinguishes an unavailable register from an empty one", async () => {
    m.list.mockRejectedValue(new Error("PRIVATE_DATABASE_SENTINEL"));
    const html = await render();
    expect(html).toContain("unavailable");
    expect(html).not.toContain("PRIVATE_DATABASE_SENTINEL");
  });
  it("does not read or echo a malformed package handle", async () => {
    expect(await render({ packageId: "javascript:alert(1)" })).not.toContain(
      "javascript:alert(1)",
    );
    expect(m.review).not.toHaveBeenCalled();
    expect(m.agents).not.toHaveBeenCalled();
  });
  it("runs automatic preparation and publication through the unified server authority", async () => {
    const f = form();
    f.set("actorId", "forged");
    f.set("formatId", "forged");
    const result = await publishUnifiedAction({}, f);
    expect(result.error).toBeUndefined();
    expect(m.publish).toHaveBeenCalledExactlyOnceWith({
      packageId: id,
      slug: "synthetic-test",
      currency: "GBP",
      amountMinor: 9999,
      summary: null,
      reason: "Synthetic publication review",
    });
  });
  it("requires explicit commercial and policy approval before any configuration mutation", async () => {
    const f = form();
    f.delete("confirm");
    expect((await publishUnifiedAction({}, f)).error).toContain("Confirm");
    expect(m.configure).not.toHaveBeenCalled();
    expect(m.publish).not.toHaveBeenCalled();
  });
  it.each([
    "POLICY_PENDING",
    "RUBRIC_PENDING",
    "TEST_GATE_NOT_SATISFIED",
    "PUBLICATION_CONFLICT",
  ])("shows a resolvable %s publication failure", async (code) => {
    m.publish.mockRejectedValue(new Error(code));
    const result = await publishUnifiedAction({}, form());
    expect(result.error).toBeTruthy();
    expect(result.message).toBeUndefined();
  });
  it("keeps backend error content out of the action response", async () => {
    m.publish.mockRejectedValue(new Error("PRIVATE_DATABASE_SENTINEL"));
    expect(
      JSON.stringify(await publishUnifiedAction({}, form())),
    ).not.toContain("PRIVATE_DATABASE_SENTINEL");
  });
  it("retires the duplicate route with a validated redirect", async () => {
    await expect(
      OldPage({ searchParams: Promise.resolve({ packageId: id }) }),
    ).rejects.toThrow(`REDIRECT:/admin/course-engineering?packageId=${id}`);
    await expect(
      OldPage({
        searchParams: Promise.resolve({ packageId: "javascript:alert(1)" }),
      }),
    ).rejects.toThrow("REDIRECT:/admin/course-engineering");
  });
});
