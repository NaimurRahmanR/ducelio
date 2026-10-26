import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  source: vi.fn(),
  revise: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@/server/unified-course-engine", () => ({
  getUnifiedRevisionSource: m.source,
  reviseUnifiedCoursePackage: m.revise,
}));
vi.mock("next/cache", () => ({ revalidatePath: m.refresh }));
import { reviseCourseAction } from "@/app/admin/course-engineering/revision-actions";
import { CourseRevisionForm } from "@/components/course-revision-form";
const id = "10000000-0000-4000-8000-000000000101";
const pending = [
  {
    key: "SOURCE_REVIEW",
    summary: "Independent human source review required.",
  },
  {
    key: "EXAM_REVIEW",
    summary: "Independent human examination review required.",
  },
];
beforeEach(() => {
  vi.resetAllMocks();
  m.source.mockResolvedValue({ pendingDecisions: pending });
  m.revise.mockResolvedValue({ valid: true, packageId: id });
});
function form() {
  const f = new FormData();
  for (const [k, v] of Object.entries({
    sourceId: id,
    requestKey: id,
    rawPackage: JSON.stringify({ pendingDecisions: pending }),
    reason: "Synthetic human revision test",
    resolve_SOURCE_REVIEW: "on",
    evidence_SOURCE_REVIEW: "TEST ONLY evidence reference",
    rationale_SOURCE_REVIEW: "TEST ONLY actual human review fixture rationale.",
  }))
    f.set(k, v);
  return f;
}
it("is a content editor only: no approval controls, untrusted content escaped", () => {
  const html = renderToStaticMarkup(
    createElement(CourseRevisionForm, {
      sourceId: id,
      raw: '{"example":"<script>untrusted</script>"}',
      pending,
    }),
  );
  for (const name of ["rawPackage", "requestKey", "reason"])
    expect(html).toContain(`name="${name}"`);
  for (const name of [
    "resolve_SOURCE_REVIEW",
    "evidence_SOURCE_REVIEW",
    "attest",
  ])
    expect(html).not.toContain(`name="${name}"`);
  expect(html).toContain(
    `href="/admin/course-engineering/review?packageId=${id}"`,
  );
  expect(html).toContain("2 decisions remain pending");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>untrusted</script>");
});
it("ignores forged resolution fields: a content revision never resolves a decision", async () => {
  const f = form();
  f.set("attest", "on");
  expect(await reviseCourseAction({}, f)).toHaveProperty("packageId", id);
  expect(m.revise.mock.calls[0][0]).toMatchObject({
    sourceId: id,
    requestKey: id,
    raw: { pendingDecisions: pending },
    resolutions: [],
  });
});
it("explains a removed decision as belonging to Course academic review", async () => {
  m.revise.mockRejectedValue(new Error("ACADEMIC_EVIDENCE_REQUIRED"));
  const f = form();
  f.set("rawPackage", JSON.stringify({ pendingDecisions: [pending[1]] }));
  expect((await reviseCourseAction({}, f)).error).toMatch(
    /resolve decisions in Course academic review/,
  );
});
it("returns validation findings without publishing or presenting them as approval", async () => {
  const f = form();
  f.set("attest", "on");
  m.revise.mockResolvedValue({
    valid: false,
    issues: ["labs: Approved rubric required"],
  });
  expect(await reviseCourseAction({}, f)).toMatchObject({
    error: expect.stringContaining("failed validation"),
    issues: ["labs: Approved rubric required"],
  });
  expect(m.refresh).not.toHaveBeenCalled();
});
