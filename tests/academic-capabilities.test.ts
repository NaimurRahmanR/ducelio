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
vi.mock("@/server/academic-activity", async (original) => ({
  ...(await original<typeof import("@/server/academic-activity")>()),
  assertStudentExplanationAllowed: mocks.firewall,
  getStudentAcademicActivity: mocks.activity,
}));
import { AcademicActivityBlocked } from "@/server/academic-activity";
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
];

beforeEach(() => {
  vi.resetAllMocks();
  mocks.actor.mockResolvedValue(principal);
  mocks.student.mockResolvedValue(principal);
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
});

describe("Professor capability boundary", () => {
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
        capability_contract_version: "PROFESSOR_READ_V1",
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
      ]) {
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

  it("has exactly the five approved capabilities", () => {
    expect(capabilityNameSchema.options).toEqual(
      requests.map((request) => request.capability),
    );
  });
});
