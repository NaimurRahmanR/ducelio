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
it("exposes actionable revision and evidence controls with no approval selected by default", () => {
  const html = renderToStaticMarkup(
    createElement(CourseRevisionForm, {
      sourceId: id,
      raw: '{"example":"<script>untrusted</script>"}',
      pending,
    }),
  );
  for (const name of [
    "rawPackage",
    "requestKey",
    "resolve_SOURCE_REVIEW",
    "evidence_SOURCE_REVIEW",
    "rationale_SOURCE_REVIEW",
    "attest",
  ])
    expect(html).toContain(`name="${name}"`);
  expect(html).not.toContain("checked=");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>untrusted</script>");
});
it("refuses asserted decisions without human attestation", async () => {
  expect(await reviseCourseAction({}, form())).toHaveProperty("error");
  expect(m.revise).not.toHaveBeenCalled();
});
it("retains unresolved findings and sends only the explicitly evidenced decision", async () => {
  const f = form();
  f.set("attest", "on");
  expect(await reviseCourseAction({}, f)).toHaveProperty("packageId", id);
  expect(m.revise.mock.calls[0][0]).toMatchObject({
    sourceId: id,
    requestKey: id,
    raw: { pendingDecisions: [pending[1]] },
    resolutions: [
      {
        key: "SOURCE_REVIEW",
        evidenceReference: "TEST ONLY evidence reference",
        rationale: "TEST ONLY actual human review fixture rationale.",
      },
    ],
  });
  expect(pending).toHaveLength(2);
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
