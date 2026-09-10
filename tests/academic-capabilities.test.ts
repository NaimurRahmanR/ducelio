import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/domain/policy";
import { AccessDenied } from "@/domain/policy";
import { AcademicContextUnavailable } from "@/domain/learning-context";
import {
  capabilityNameSchema,
  capabilityProvenanceSchema,
} from "@/domain/academic-capabilities";

const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  student: vi.fn(),
  firewall: vi.fn(),
  activity: vi.fn(),
  enrolment: vi.fn(),
  lesson: vi.fn(),
  objectives: vi.fn(),
  session: vi.fn(),
  resources: vi.fn(),
  history: vi.fn(),
  mastery: vi.fn(),
  beginRelease: vi.fn(),
  closeRelease: vi.fn(),
}));
vi.mock("@/server/academic-content-release", async (original) => ({
  ...(await original<typeof import("@/server/academic-content-release")>()),
  beginAcademicContentRelease: mocks.beginRelease,
  closeAcademicContentRelease: mocks.closeRelease,
}));
vi.mock("@/server/identity", () => ({
  getAuthenticatedActor: mocks.actor,
  requireStudentPrincipal: mocks.student,
}));
vi.mock("@/server/academy", () => ({
  getOwnedStudentEnrolment: mocks.enrolment,
}));
vi.mock("@/server/learning-context", () => ({
  getStudentLessonContext: mocks.lesson,
  getStudentLessonObjectives: mocks.objectives,
}));
vi.mock("@/server/class-sessions", () => ({
  getStudentRelevantClassSession: mocks.session,
}));
vi.mock("@/server/learning-resources", () => ({
  getStudentLessonResources: mocks.resources,
}));
vi.mock("@/server/learning-evidence", () => ({
  getStudentPermittedLearningHistory: mocks.history,
}));
vi.mock("@/server/objective-mastery", () => ({
  getStudentLessonMastery: mocks.mastery,
}));
vi.mock("@/server/academic-activity", async (original) => ({
  ...(await original<typeof import("@/server/academic-activity")>()),
  assertStudentExplanationAllowed: mocks.firewall,
  getStudentAcademicActivity: mocks.activity,
}));
import { AcademicActivityBlocked } from "@/server/academic-activity";
import { AcademicContentReleaseDenied } from "@/server/academic-content-release";
import { invokeProfessorCapability } from "@/server/academic-capabilities";

const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const principal: Actor = {
  id: id(1),
  displayName: "Learner",
  roles: ["STUDENT"],
};
const enrolment = {
  enrolmentId: id(2),
  programmeVersionId: id(3),
  cohortId: id(4),
  enrolmentStatus: "ACTIVE",
  programmeTitle: "Enrolled programme",
  programmeVersionLabel: "Historical version",
  cohortTitle: "Own cohort",
  cohortStartsOn: "2026-09-01",
};
const lesson = {
  enrolmentId: id(2),
  programmeVersionId: id(3),
  lessonId: id(5),
  moduleId: id(6),
  title: "Fixed lesson",
  position: 1,
};
const requests = [
  { capability: "get_actor_context", input: {} },
  { capability: "get_activity_permissions", input: {} },
  { capability: "get_current_learner_context", input: { enrolmentId: id(2) } },
  {
    capability: "get_lesson_context",
    input: { enrolmentId: id(2), lessonId: id(5) },
  },
  {
    capability: "get_lesson_objectives",
    input: { enrolmentId: id(2), lessonId: id(5) },
  },
  { capability: "get_current_class_session", input: { enrolmentId: id(2) } },
  {
    capability: "get_learning_resources",
    input: { enrolmentId: id(2), lessonId: id(5) },
  },
  {
    capability: "get_permitted_learning_history",
    input: { enrolmentId: id(2) },
  },
  {
    capability: "get_current_mastery_state",
    input: { enrolmentId: id(2), lessonId: id(5) },
  },
];

beforeEach(() => {
  vi.resetAllMocks();
  mocks.actor.mockResolvedValue(principal);
  mocks.student.mockResolvedValue(principal);
  mocks.beginRelease.mockImplementation(async (invocationId) => ({
    ok: true,
    release_id: id(9),
    student_id: principal.id,
    invocation_id: invocationId,
  }));
  mocks.closeRelease.mockResolvedValue(undefined);
  mocks.firewall.mockResolvedValue(undefined);
  mocks.activity.mockResolvedValue({
    activityState: "NORMAL",
    explanationAllowed: true,
  });
  mocks.enrolment.mockResolvedValue(enrolment);
  mocks.lesson.mockResolvedValue(lesson);
  mocks.objectives.mockResolvedValue({
    enrolmentId: id(2),
    programmeVersionId: id(3),
    lessonId: id(5),
    objectives: [
      { objectiveId: id(7), description: "Fixed objective", position: 1 },
    ],
    nextAfterPosition: null,
  });
  mocks.session.mockResolvedValue({
    enrolmentId: id(2),
    programmeVersionId: id(3),
    cohortId: id(4),
    selectedAt: "2026-09-09T12:00:00Z",
    selection: "NONE",
    session: null,
  });
  mocks.resources.mockResolvedValue({
    enrolmentId: id(2),
    programmeVersionId: id(3),
    lessonId: id(5),
    resources: [],
    nextCursor: null,
  });
  mocks.history.mockResolvedValue({
    enrolmentId: id(2),
    programmeVersionId: id(3),
    objectiveId: null,
    events: [],
    nextCursor: null,
  });
  mocks.mastery.mockResolvedValue({
    enrolmentId: id(2),
    programmeVersionId: id(3),
    lessonId: id(5),
    persistedOnly: true,
    records: [],
  });
});

describe("Professor capability boundary", () => {
  const contentCases = requests.slice(2).map((request, index) => ({
    request,
    service: [
      mocks.enrolment,
      mocks.lesson,
      mocks.objectives,
      mocks.session,
      mocks.resources,
      mocks.history,
      mocks.mastery,
    ][index],
  }));
  it.each(contentCases)(
    "holds a release through validation for $request.capability",
    async ({ request, service }) => {
      const result = await invokeProfessorCapability(request);
      expect(result.ok).toBe(true);
      expect(mocks.beginRelease).toHaveBeenCalledWith(
        result.provenance.invocation_id,
        request.capability,
      );
      expect(mocks.beginRelease.mock.invocationCallOrder[0]).toBeLessThan(
        service.mock.invocationCallOrder[0],
      );
      expect(mocks.student.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.closeRelease.mock.invocationCallOrder[0],
      );
      expect(mocks.firewall.mock.invocationCallOrder.at(-1)).toBeLessThan(
        mocks.closeRelease.mock.invocationCallOrder[0],
      );
      expect(mocks.closeRelease).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ release_id: id(9) }),
        true,
      );
    },
  );
  it.each(contentCases)(
    "does not load content when a release is denied for $request.capability",
    async ({ request, service }) => {
      mocks.beginRelease.mockRejectedValue(
        new AcademicContentReleaseDenied("ACTIVITY_BLOCKED"),
      );
      expect(await invokeProfessorCapability(request)).toMatchObject({
        ok: false,
        error: { code: "ACTIVITY_BLOCKED" },
      });
      expect(service).not.toHaveBeenCalled();
      expect(mocks.closeRelease).not.toHaveBeenCalled();
    },
  );
  it.each(contentCases)(
    "aborts service and malformed-output failures for $request.capability",
    async ({ request, service }) => {
      service.mockRejectedValueOnce(new Error("Private response body"));
      service.mockResolvedValueOnce({ support_prose: "Private support" });
      for (let n = 0; n < 2; n++) {
        const result = await invokeProfessorCapability(request);
        expect(result).toMatchObject({
          ok: false,
          error: { code: "SERVICE_UNAVAILABLE" },
        });
        expect(result).not.toHaveProperty("data");
        expect(mocks.closeRelease).toHaveBeenLastCalledWith(
          expect.anything(),
          false,
        );
      }
      expect(mocks.closeRelease).toHaveBeenCalledTimes(2);
    },
  );
  it.each(contentCases)(
    "aborts changed principal/role and final firewall denial for $request.capability",
    async ({ request }) => {
      mocks.student.mockResolvedValueOnce({ ...principal, id: id(8) });
      mocks.student.mockRejectedValueOnce(new AccessDenied());
      for (const code of ["CONTEXT_CONFLICT", "FORBIDDEN"]) {
        expect(await invokeProfessorCapability(request)).toMatchObject({
          ok: false,
          error: { code },
        });
        expect(mocks.closeRelease).toHaveBeenLastCalledWith(
          expect.anything(),
          false,
        );
      }
      mocks.firewall
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new AcademicActivityBlocked());
      expect(await invokeProfessorCapability(request)).toMatchObject({
        ok: false,
        error: { code: "ACTIVITY_BLOCKED" },
      });
      expect(mocks.closeRelease).toHaveBeenLastCalledWith(
        expect.anything(),
        false,
      );
    },
  );
  it.each(contentCases)(
    "discards content on close or abort failure for $request.capability",
    async ({ request, service }) => {
      mocks.closeRelease.mockRejectedValue(new Error("SQL audit secret"));
      for (let n = 0; n < 2; n++) {
        if (n) service.mockRejectedValueOnce(new AcademicContextUnavailable());
        const result = await invokeProfessorCapability(request);
        expect(result).toMatchObject({
          ok: false,
          error: { code: "SERVICE_UNAVAILABLE" },
        });
        expect(result).not.toHaveProperty("data");
        expect(JSON.stringify(result)).not.toContain("SQL audit secret");
      }
    },
  );
  it.each(contentCases)(
    "aborts inconsistent release identity for $request.capability",
    async ({ request, service }) => {
      mocks.beginRelease.mockResolvedValue({
        ok: true,
        release_id: id(9),
        student_id: id(8),
        invocation_id: id(7),
      });
      expect(await invokeProfessorCapability(request)).toMatchObject({
        ok: false,
        error: { code: "CONTEXT_CONFLICT" },
      });
      expect(service).not.toHaveBeenCalled();
      expect(mocks.closeRelease).toHaveBeenCalledWith(expect.anything(), false);
    },
  );
  it.each(requests.slice(0, 2))(
    "never leases introspection $capability",
    async (request) => {
      expect((await invokeProfessorCapability(request)).ok).toBe(true);
      expect(mocks.beginRelease).not.toHaveBeenCalled();
      expect(mocks.closeRelease).not.toHaveBeenCalled();
    },
  );
  it.each(requests)(
    "requires authentication for $capability",
    async (request) => {
      mocks.actor.mockResolvedValue(null);
      const result = await invokeProfessorCapability(request);
      expect(result).toMatchObject({
        ok: false,
        error: { code: "UNAUTHENTICATED" },
        provenance: { actor_user_id: null, authorized_scope: null },
      });
      expect(mocks.firewall).not.toHaveBeenCalled();
      expect(mocks.enrolment).not.toHaveBeenCalled();
    },
  );

  it.each([
    "INSTRUCTOR",
    "COUNSELLOR",
    "ACADEMIC_ADMIN",
    "REGISTRAR",
    "PLATFORM_ADMIN",
  ])("denies %s without STUDENT on every capability", async (role) => {
    mocks.actor.mockResolvedValue({ ...principal, roles: [role] });
    for (const request of requests) {
      expect(await invokeProfessorCapability(request)).toMatchObject({
        ok: false,
        error: { code: "FORBIDDEN" },
      });
    }
    expect(mocks.activity).not.toHaveBeenCalled();
    expect(mocks.lesson).not.toHaveBeenCalled();
  });

  it.each(requests)(
    "returns strict output and server provenance for $capability",
    async (request) => {
      const first = await invokeProfessorCapability(request);
      const second = await invokeProfessorCapability(request);
      expect(first.ok).toBe(true);
      expect(
        capabilityProvenanceSchema.safeParse(first.provenance).success,
      ).toBe(true);
      expect(first.provenance).toMatchObject({
        actor_user_id: id(1),
        agent_profile: "PROFESSOR",
        capability_contract_version: "PROFESSOR_READ_V2",
        outcome: "SUCCESS",
        denial_code: null,
      });
      expect(first.provenance.invocation_id).not.toBe(
        second.provenance.invocation_id,
      );
    },
  );

  it("projects only the STUDENT role even when the principal holds every staff role", async () => {
    mocks.actor.mockResolvedValue({
      ...principal,
      roles: [
        "STUDENT",
        "ACADEMIC_ADMIN",
        "PLATFORM_ADMIN",
        "REGISTRAR",
        "COUNSELLOR",
        "INSTRUCTOR",
      ],
    });
    const result = await invokeProfessorCapability(requests[0]);
    expect(result).toMatchObject({
      ok: true,
      data: { actor_user_id: id(1), effective_institutional_role: "STUDENT" },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /ACADEMIC_ADMIN|PLATFORM_ADMIN|displayName|auth_user_id/,
    );
  });

  it.each([
    null,
    [],
    {},
    { capability: 5, input: {} },
    { capability: "", input: {} },
    { capability: "get_actor_context" },
    { capability: "get_actor_context", input: {}, agent_profile: "EXAMINER" },
  ])("normalizes malformed envelope %j", async (request) => {
    expect(await invokeProfessorCapability(request)).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
  });

  it.each([
    "record_learning_evidence",
    "request_mastery_evaluation",
    "create_learning_handoff",
    "__proto__",
    "constructor",
    "anything_else",
  ])("does not expose %s", async (capability) => {
    const result = await invokeProfessorCapability({ capability, input: {} });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "CAPABILITY_UNAVAILABLE" },
      provenance: { capability_name: null },
    });
    expect(mocks.firewall).not.toHaveBeenCalled();
  });

  it.each(requests)(
    "rejects unknown/forged fields for $capability",
    async (request) => {
      for (const extra of [
        { actor_user_id: id(8) },
        { agent_profile: "EXAMINER" },
        { role: "PLATFORM_ADMIN" },
        { action: "EXAMINER_DELIVERY" },
        { objectiveId: id(8) },
        { programmeVersionId: id(8) },
        { releaseId: id(8) },
        { studentId: id(8) },
        { actorId: id(8) },
        { contractVersion: "FORGED" },
        { auditState: "COMPLETED" },
        { authorizedScope: {} },
      ]) {
        if (
          request.capability === "get_permitted_learning_history" &&
          "objectiveId" in extra
        )
          continue;
        expect(
          await invokeProfessorCapability({
            ...request,
            input: { ...request.input, ...extra },
          }),
        ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
      }
      expect(mocks.enrolment).not.toHaveBeenCalled();
    },
  );

  it("bounds pagination and rejects coercion", async () => {
    for (const afterPosition of [-1, 1.5, "10", Infinity, 2147483648]) {
      expect(
        await invokeProfessorCapability({
          ...requests[4],
          input: { ...requests[4].input, afterPosition },
        }),
      ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    }
  });

  it.each(requests.slice(2))(
    "blocks $capability before invoking learning services",
    async (request) => {
      mocks.firewall.mockRejectedValue(new AcademicActivityBlocked());
      expect(await invokeProfessorCapability(request)).toMatchObject({
        ok: false,
        error: { code: "ACTIVITY_BLOCKED" },
      });
      expect(mocks.enrolment).not.toHaveBeenCalled();
      expect(mocks.lesson).not.toHaveBeenCalled();
      expect(mocks.objectives).not.toHaveBeenCalled();
    },
  );

  it("does not use an earlier permission snapshot to authorize a later read", async () => {
    expect((await invokeProfessorCapability(requests[1])).ok).toBe(true);
    mocks.firewall.mockRejectedValue(new AcademicActivityBlocked());
    expect(await invokeProfessorCapability(requests[3])).toMatchObject({
      ok: false,
      error: { code: "ACTIVITY_BLOCKED" },
    });
  });

  it("discards content if the firewall closes during execution", async () => {
    mocks.firewall
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new AcademicActivityBlocked());
    const result = await invokeProfessorCapability(requests[3]);
    expect(mocks.lesson).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      ok: false,
      error: { code: "ACTIVITY_BLOCKED" },
    });
    expect(result).not.toHaveProperty("data");
    expect(result.provenance.authorized_scope).not.toHaveProperty("lesson_id");
  });

  it("does not disclose foreign resource existence or requested scope in denial provenance", async () => {
    mocks.lesson.mockRejectedValue(new AcademicContextUnavailable());
    const result = await invokeProfessorCapability(requests[3]);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND_OR_FORBIDDEN" },
      provenance: {
        outcome: "DENIED",
        authorized_scope: { student_user_id: id(1) },
      },
    });
    expect(JSON.stringify(result)).not.toContain(id(5));
  });

  it.each([
    "expected_answer",
    "marking_guidance",
    "support_prose",
    "response_body",
    "service_role_key",
  ])("rejects accidental output field %s without leaking it", async (field) => {
    mocks.lesson.mockResolvedValue({
      ...lesson,
      [field]: "sensitive-sentinel",
    });
    const result = await invokeProfessorCapability(requests[3]);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "SERVICE_UNAVAILABLE" },
    });
    expect(JSON.stringify(result)).not.toContain("sensitive-sentinel");
  });

  it("normalizes identity, firewall, service and malformed-output failures", async () => {
    for (const source of [mocks.actor, mocks.firewall, mocks.lesson]) {
      source.mockRejectedValueOnce(
        new Error("Supabase SQL credential-sensitive-sentinel"),
      );
      const result = await invokeProfessorCapability(requests[3]);
      expect(result).toMatchObject({
        ok: false,
        error: { code: "SERVICE_UNAVAILABLE" },
        provenance: { outcome: "ERROR" },
      });
      expect(JSON.stringify(result)).not.toContain("sensitive-sentinel");
    }
    mocks.lesson.mockResolvedValue(null);
    expect(await invokeProfessorCapability(requests[3])).toMatchObject({
      ok: false,
      error: { code: "SERVICE_UNAVAILABLE" },
    });
  });

  it("rejects a service result for a different requested enrolment or lesson", async () => {
    for (const replacement of [{ enrolmentId: id(8) }, { lessonId: id(8) }]) {
      mocks.lesson.mockResolvedValue({ ...lesson, ...replacement });
      expect(await invokeProfessorCapability(requests[3])).toMatchObject({
        ok: false,
        error: { code: "CONTEXT_CONFLICT" },
      });
    }
  });

  it("revalidates principal identity and STUDENT authority before release", async () => {
    mocks.student.mockResolvedValue({ ...principal, id: id(8) });
    expect(await invokeProfessorCapability(requests[3])).toMatchObject({
      ok: false,
      error: { code: "CONTEXT_CONFLICT" },
      provenance: { authorized_scope: null },
    });
    mocks.student.mockRejectedValue(new AccessDenied());
    expect(await invokeProfessorCapability(requests[3])).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
  });

  it("has exactly the nine approved capabilities", () => {
    expect(capabilityNameSchema.options).toEqual(
      requests.map((request) => request.capability),
    );
  });

  it("permission introspection reports all nine informational flags", async () => {
    const result = await invokeProfessorCapability({
      capability: "get_activity_permissions",
      input: {},
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected permission snapshot");
    expect(result.data.informational_only).toBe(true);
    expect(Object.keys(result.data.permissions)).toEqual(
      capabilityNameSchema.options,
    );
    expect(Object.values(result.data.permissions).every(Boolean)).toBe(true);
  });

  it.each([
    { request: requests[5], service: mocks.session },
    { request: requests[6], service: mocks.resources },
    { request: requests[7], service: mocks.history },
    { request: requests[8], service: mocks.mastery },
  ])(
    "normalizes failures and revalidates release for $request.capability",
    async ({ request, service }) => {
      service.mockRejectedValueOnce(new Error("SQL/private-secret"));
      const failed = await invokeProfessorCapability(request);
      expect(failed).toMatchObject({
        ok: false,
        error: { code: "SERVICE_UNAVAILABLE" },
      });
      expect(JSON.stringify(failed)).not.toContain("private-secret");
      mocks.student.mockResolvedValueOnce({ ...principal, id: id(8) });
      expect(await invokeProfessorCapability(request)).toMatchObject({
        ok: false,
        error: { code: "CONTEXT_CONFLICT" },
      });
      mocks.student.mockRejectedValueOnce(new AccessDenied());
      expect(await invokeProfessorCapability(request)).toMatchObject({
        ok: false,
        error: { code: "FORBIDDEN" },
      });
      mocks.firewall
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new AcademicActivityBlocked());
      expect(await invokeProfessorCapability(request)).toMatchObject({
        ok: false,
        error: { code: "ACTIVITY_BLOCKED" },
      });
      service.mockResolvedValueOnce({
        enrolmentId: id(2),
        expected_answer: "private-secret",
      });
      const malformed = await invokeProfessorCapability(request);
      expect(malformed).toMatchObject({
        ok: false,
        error: { code: "SERVICE_UNAVAILABLE" },
      });
      expect(JSON.stringify(malformed)).not.toContain("private-secret");
    },
  );

  it("rejects malformed cursors without passing filter syntax to a service", async () => {
    for (const cursor of [
      { afterPosition: "5" },
      { afterPosition: -1 },
      { afterPosition: 1, role: "ADMIN" },
    ]) {
      expect(
        await invokeProfessorCapability({
          ...requests[6],
          input: { ...requests[6].input, cursor },
        }),
      ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    }
    for (const cursor of [
      { beforeRecordedAt: "now(),or(id.gt.0)", beforeId: id(8) },
      { beforeRecordedAt: "2026-09-09T00:00:00Z", beforeId: "injected,id" },
    ]) {
      expect(
        await invokeProfessorCapability({
          ...requests[7],
          input: { ...requests[7].input, cursor },
        }),
      ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    }
    expect(mocks.resources).not.toHaveBeenCalled();
    expect(mocks.history).not.toHaveBeenCalled();
  });
});
