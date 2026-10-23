import { beforeEach, describe, expect, it, vi } from "vitest";

// The server reader for the admin course register's delivery-model
// evidence: a fixed number of set-based reads (one per 500 curriculum
// imports), never one per course, and never partial evidence.
const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  roles: ["ACADEMIC_ADMIN"] as string[],
}));
vi.mock("@/server/identity", () => ({
  getAuthenticatedActor: async () => ({
    id: "60000000-0000-4000-8000-000000000001",
    roles: m.roles,
  }),
}));
vi.mock("@/server/supabase", () => ({
  createSupabase: async () => ({ rpc: m.rpc }),
}));

import { getAcademyDeliveryEvidence } from "@/server/academy-course-engineering";
import { AcademyError } from "@/domain/academy-delivery";

const uuid = (i: number) =>
  `10000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;

beforeEach(() => {
  m.rpc.mockReset();
  m.roles = ["ACADEMIC_ADMIN"];
  m.rpc.mockImplementation(
    async (_name: string, args: { p_import_ids: string[] }) => ({
      data: { links: [], packagesWithoutCurriculum: 4 },
      error: null,
      args,
    }),
  );
});

describe("course register delivery evidence (server)", () => {
  it("reads 1,200 imports in three batches, not one call per course", async () => {
    const ids = Array.from({ length: 1200 }, (_, i) => uuid(i));
    const result = await getAcademyDeliveryEvidence(ids);
    expect(m.rpc).toHaveBeenCalledTimes(3);
    expect(
      m.rpc.mock.calls.map(
        ([name, args]) => `${name}:${args.p_import_ids.length}`,
      ),
    ).toEqual([
      "get_academy_delivery_evidence:500",
      "get_academy_delivery_evidence:500",
      "get_academy_delivery_evidence:200",
    ]);
    expect(
      new Set(m.rpc.mock.calls.flatMap(([, a]) => a.p_import_ids)).size,
    ).toBe(1200);
    expect(result.packagesWithoutCurriculum).toBe(4);
  });

  it("still reads the unattached-package count for an empty register", async () => {
    await getAcademyDeliveryEvidence([]);
    expect(m.rpc).toHaveBeenCalledTimes(1);
    expect(m.rpc.mock.calls[0][1]).toEqual({ p_import_ids: [] });
  });

  it("fails the whole read when any batch fails, so partial evidence is never used", async () => {
    m.rpc.mockImplementation(
      async (_n: string, args: { p_import_ids: string[] }) =>
        args.p_import_ids[0] === uuid(500)
          ? { data: null, error: { code: "57014", message: "timeout" } }
          : { data: { links: [], packagesWithoutCurriculum: 0 }, error: null },
    );
    await expect(
      getAcademyDeliveryEvidence(
        Array.from({ length: 1200 }, (_, i) => uuid(i)),
      ),
    ).rejects.toBeInstanceOf(AcademyError);
  });

  it("refuses non-administrators before any database call", async () => {
    m.roles = ["INSTRUCTOR"];
    await expect(getAcademyDeliveryEvidence([uuid(1)])).rejects.toThrow(
      "FORBIDDEN",
    );
    expect(m.rpc).not.toHaveBeenCalled();
  });
});
