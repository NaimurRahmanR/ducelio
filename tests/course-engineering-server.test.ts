import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireActor: vi.fn(),
  createSupabase: vi.fn(),
}));
vi.mock("@/server/identity", () => ({ requireActor: mocks.requireActor }));
vi.mock("@/server/supabase", () => ({ createSupabase: mocks.createSupabase }));

import {
  importCoursePackage,
  applyCoursePackage,
  publishCoursePackage,
  listCoursePackages,
} from "@/server/course-engineering";
import {
  setAgentConfig,
  listAgentConfigs,
} from "@/server/academic-agent-config";

function rpcClient(data: unknown, error: unknown = null) {
  const rpc = vi.fn().mockResolvedValue({ data, error });
  return { rpc };
}

describe("course engineering authorization boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("requires admin area access before touching the database", async () => {
    mocks.requireActor.mockRejectedValue(new Error("Access denied"));
    await expect(
      importCoursePackage({ packageKey: "x" }, "reason"),
    ).rejects.toThrow("Access denied");
    expect(mocks.createSupabase).not.toHaveBeenCalled();
  });

  it("denies an authenticated actor without ACADEMIC_ADMIN/PLATFORM_ADMIN", async () => {
    mocks.requireActor.mockResolvedValue({
      id: "u1",
      displayName: "Instructor",
      roles: ["INSTRUCTOR"],
    });
    await expect(
      applyCoursePackage("00000000-0000-4000-8000-000000000001", "reason"),
    ).rejects.toThrow();
    expect(mocks.createSupabase).not.toHaveBeenCalled();
  });

  it("rejects malformed package content before any database call", async () => {
    mocks.requireActor.mockResolvedValue({
      id: "admin",
      displayName: "Admin",
      roles: ["ACADEMIC_ADMIN"],
    });
    await expect(
      importCoursePackage({ notAPackage: true }, "A bounded reason"),
    ).rejects.toThrow();
    expect(mocks.createSupabase).not.toHaveBeenCalled();
  });

  it("calls import_course_package with the identity fields and raw content, never a client-computed hash", async () => {
    mocks.requireActor.mockResolvedValue({
      id: "admin",
      displayName: "Admin",
      roles: ["ACADEMIC_ADMIN"],
    });
    const client = rpcClient("10000000-0000-4000-8000-000000000099");
    mocks.createSupabase.mockResolvedValue(client);
    const rawPackage = {
      packageKey: "cyber-foundations",
      packageRevision: 1,
      schemaVersion: "COURSE_PACKAGE_V1",
    };
    const id = await importCoursePackage(rawPackage, "A bounded import reason");
    expect(id).toBe("10000000-0000-4000-8000-000000000099");
    expect(client.rpc).toHaveBeenCalledWith("import_course_package", {
      p_package_key: "cyber-foundations",
      p_package_revision: 1,
      p_schema_version: "COURSE_PACKAGE_V1",
      p_raw_package: rawPackage,
      p_reason: "A bounded import reason",
    });
    // The content hash is computed only by the database (from the exact
    // stored jsonb), never asserted by this caller.
    const args = client.rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(args).not.toHaveProperty("p_content_hash");
  });

  it("maps a known database error message to a structured code", async () => {
    mocks.requireActor.mockResolvedValue({
      id: "admin",
      displayName: "Admin",
      roles: ["PLATFORM_ADMIN"],
    });
    const client = rpcClient(null, { message: "Access denied" });
    mocks.createSupabase.mockResolvedValue(client);
    await expect(
      publishCoursePackage("00000000-0000-4000-8000-000000000001", "reason"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("falls back to SERVICE_UNAVAILABLE for an unrecognized database error", async () => {
    mocks.requireActor.mockResolvedValue({
      id: "admin",
      displayName: "Admin",
      roles: ["PLATFORM_ADMIN"],
    });
    const client = rpcClient(null, { message: "connection reset" });
    mocks.createSupabase.mockResolvedValue(client);
    await expect(listCoursePackages()).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
  });
});

describe("academic agent configuration authorization boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("requires admin access before saving a configuration", async () => {
    mocks.requireActor.mockRejectedValue(new Error("Access denied"));
    await expect(
      setAgentConfig({
        programmeVersionId: "00000000-0000-4000-8000-000000000001",
        role: "PROFESSOR",
        enabled: true,
        modelProfileRef: null,
        instructionalNotes: null,
        capabilities: ["get_lesson_context"],
        escalationPolicy: "NONE",
        reason: "A bounded configuration reason",
      }),
    ).rejects.toThrow("Access denied");
    expect(mocks.createSupabase).not.toHaveBeenCalled();
  });

  it("rejects a capability outside the role allowlist before any database call", async () => {
    mocks.requireActor.mockResolvedValue({
      id: "admin",
      displayName: "Admin",
      roles: ["ACADEMIC_ADMIN"],
    });
    await expect(
      setAgentConfig({
        programmeVersionId: "00000000-0000-4000-8000-000000000001",
        role: "COUNSELLOR",
        enabled: true,
        modelProfileRef: null,
        instructionalNotes: null,
        capabilities: ["get_current_mastery_state"],
        escalationPolicy: "NONE",
        reason: "Attempted capability escalation",
      }),
    ).rejects.toThrow();
    expect(mocks.createSupabase).not.toHaveBeenCalled();
  });

  it("denies listing configurations to a non-admin actor", async () => {
    mocks.requireActor.mockResolvedValue({
      id: "u1",
      displayName: "Counsellor",
      roles: ["COUNSELLOR"],
    });
    await expect(
      listAgentConfigs("00000000-0000-4000-8000-000000000001"),
    ).rejects.toThrow();
    expect(mocks.createSupabase).not.toHaveBeenCalled();
  });
});
