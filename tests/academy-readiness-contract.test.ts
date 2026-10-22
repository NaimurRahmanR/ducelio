import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ACADEMY_ERROR_TEXT,
  AcademyError,
  isMissingDatabaseDependency,
} from "@/domain/academy-delivery";

// Deployment-readiness guard for the Academy release. The contract must
// track the code: an Academy RPC the application calls but the contract
// omits would let a database without that function pass as ready.
type Contract = {
  migrations: string[];
  anonRpcs: string[];
  baselineRpcs: string[];
  rpcs: string[];
  privateSchemas: string[];
};
type Readiness = {
  ACADEMY_READINESS_CONTRACT: Contract;
  evaluateAcademyReadiness: (
    snapshot: unknown,
    contract?: Contract,
  ) => { name: string; ok: boolean; detail: string }[];
};
const loadGuard = () =>
  import("../scripts/acceptance/academy-readiness.mjs") as Promise<Readiness>;

const MIGRATIONS = "supabase/migrations";
const migrationFiles = readdirSync(MIGRATIONS).filter((f) =>
  /^\d{12}_.+\.sql$/.test(f),
);
const read = (f: string) => readFileSync(join(MIGRATIONS, f), "utf8");
const created = (sql: string) =>
  [
    ...sql.matchAll(
      /create\s+(?:or\s+replace\s+)?function\s+public\.([a-z0-9_]+)\s*\(/gi,
    ),
  ].map((m) => m[1].toLowerCase());
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory()
      ? walk(p)
      : /\.(ts|tsx)$/.test(n)
        ? [p]
        : [];
  });
const appSource = walk("src")
  .map((p) => readFileSync(p, "utf8"))
  .join("\n");

describe("Academy readiness contract", () => {
  it("names exactly the Academy migrations that exist in the repository", async () => {
    const { ACADEMY_READINESS_CONTRACT: c } = await loadGuard();
    for (const v of c.migrations)
      expect(
        migrationFiles.filter((f) => f.startsWith(`${v}_`)),
        v,
      ).toHaveLength(1);
  });

  it("lists every Academy-migration function that application code calls", async () => {
    const { ACADEMY_READINESS_CONTRACT: c } = await loadGuard();
    const academySql = migrationFiles
      .filter((f) => c.migrations.some((v) => f.startsWith(`${v}_`)))
      .map(read)
      .join("\n");
    const usedByApp = [...new Set(created(academySql))].filter((n) =>
      appSource.includes(`"${n}"`),
    );
    expect(usedByApp.length).toBeGreaterThan(40);
    expect(usedByApp.filter((n) => !c.rpcs.includes(n))).toEqual([]);
  });

  it("lists only RPCs a migration creates and the application calls", async () => {
    const { ACADEMY_READINESS_CONTRACT: c } = await loadGuard();
    const allCreated = new Set(migrationFiles.flatMap((f) => created(read(f))));
    expect(c.rpcs.filter((n) => !allCreated.has(n))).toEqual([]);
    expect(c.rpcs.filter((n) => !appSource.includes(`"${n}"`))).toEqual([]);
  });

  it("allows anon only where an Academy migration grants it, and baselines only pre-Academy functions", async () => {
    const { ACADEMY_READINESS_CONTRACT: c } = await loadGuard();
    const isAcademy = (f: string) =>
      c.migrations.some((v) => f.startsWith(`${v}_`));
    const academySql = migrationFiles.filter(isAcademy).map(read).join("\n");
    const anonGranted = c.rpcs.filter((n) =>
      new RegExp(
        `grant\\s+execute\\s+on\\s+function\\s+public\\.${n}\\s*\\([^)]*\\)\\s+to\\s+[^;]*\\banon\\b`,
        "i",
      ).test(academySql),
    );
    expect([...anonGranted].sort()).toEqual([...c.anonRpcs].sort());
    const earlier = migrationFiles
      .filter((f) => f < `${c.migrations[0]}_`)
      .flatMap((f) => created(read(f)));
    for (const n of c.baselineRpcs) expect(earlier, n).toContain(n);
  });
});

describe("Academy readiness evaluation", () => {
  const ready = (c: Contract) => ({
    ledger: ["202610160059", ...c.migrations],
    rpcs: c.rpcs.map((name) => ({
      name,
      overloads: 1,
      authenticated: true,
      anon: c.anonRpcs.includes(name),
      serviceRole: c.baselineRpcs.includes(name),
      securityDefiner: true,
      pinnedSearchPath: true,
    })),
    tables: [{ name: "academy_courses", rls: true, clientPrivileged: false }],
    schemas: c.privateSchemas.map((name) => ({ name, clientUsage: false })),
  });

  it("passes a fully deployed database", async () => {
    const { ACADEMY_READINESS_CONTRACT: c, evaluateAcademyReadiness } =
      await loadGuard();
    expect(evaluateAcademyReadiness(ready(c)).filter((r) => !r.ok)).toEqual([]);
  });

  it("fails the database observed on 2026-10-22 (ledger 001-059, no Academy objects)", async () => {
    const { ACADEMY_READINESS_CONTRACT: c, evaluateAcademyReadiness } =
      await loadGuard();
    const failed = evaluateAcademyReadiness({
      ledger: ["202610160059"],
      rpcs: c.rpcs.map((name) => ({
        name,
        overloads: c.baselineRpcs.includes(name) ? 1 : 0,
        authenticated: c.baselineRpcs.includes(name),
        anon: false,
        serviceRole: c.baselineRpcs.includes(name),
        securityDefiner: true,
        pinnedSearchPath: true,
      })),
      tables: [],
      schemas: [],
    })
      .filter((r) => !r.ok)
      .map((r) => r.name);
    expect(failed).toEqual([
      "Academy migrations recorded in the ledger",
      `Academy RPCs present (${c.rpcs.length})`,
      "Academy tables exist",
      "Academy private schemas present",
    ]);
  });

  it.each([
    ["one migration missing", (s: ReturnType<typeof ready>) => s.ledger.pop()],
    [
      "one RPC missing",
      (s: ReturnType<typeof ready>) => (s.rpcs[1].overloads = 0),
    ],
    [
      "an RPC not executable by authenticated users",
      (s: ReturnType<typeof ready>) => (s.rpcs[1].authenticated = false),
    ],
    [
      "an RPC exposed to anon outside the allow-list",
      (s: ReturnType<typeof ready>) =>
        (s.rpcs.find((r) => r.name === "upload_academy_course_package")!.anon =
          true),
    ],
    [
      "an Academy RPC executable by service_role",
      (s: ReturnType<typeof ready>) =>
        (s.rpcs.find((r) => r.name === "get_my_academy_attempt")!.serviceRole =
          true),
    ],
    [
      "a SECURITY DEFINER RPC without a pinned search_path",
      (s: ReturnType<typeof ready>) => (s.rpcs[2].pinnedSearchPath = false),
    ],
    [
      "a table without row level security",
      (s: ReturnType<typeof ready>) => (s.tables[0].rls = false),
    ],
    [
      "a table readable directly by a client role",
      (s: ReturnType<typeof ready>) => (s.tables[0].clientPrivileged = true),
    ],
    [
      "a private schema usable by a client role",
      (s: ReturnType<typeof ready>) => (s.schemas[0].clientUsage = true),
    ],
  ])("fails when %s", async (_label, mutate) => {
    const { ACADEMY_READINESS_CONTRACT: c, evaluateAcademyReadiness } =
      await loadGuard();
    const snapshot = ready(c);
    mutate(snapshot);
    expect(
      evaluateAcademyReadiness(snapshot).filter((r) => !r.ok),
    ).toHaveLength(1);
  });
});

describe("missing Academy database dependencies", () => {
  it.each(["PGRST202", "PGRST205", "42883", "42P01", "3F000"])(
    "classifies %s as a missing dependency",
    (code) => expect(isMissingDatabaseDependency({ code })).toBe(true),
  );
  it.each(["42501", "P0001", "PGRST301", undefined, 42883])(
    "does not classify %s as a missing dependency",
    (code) => expect(isMissingDatabaseDependency({ code })).toBe(false),
  );
});

const m = vi.hoisted(() => ({
  error: null as null | { code: string; message: string },
}));
vi.mock("@/server/identity", () => ({
  getAuthenticatedActor: async () => ({
    id: "admin",
    roles: ["ACADEMIC_ADMIN"],
  }),
}));
vi.mock("@/server/supabase", () => ({
  createSupabase: async () => ({
    rpc: async () => ({ data: null, error: m.error }),
  }),
}));

describe("administrator Academy RPC failures", () => {
  it("reports a missing RPC as NOT_INSTALLED, logging only the RPC name and code", async () => {
    const { listAcademyPackages } =
      await import("@/server/academy-course-engineering");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    m.error = {
      code: "PGRST202",
      message:
        "Could not find the function public.list_academy_course_packages without parameters in the schema cache",
    };
    const failure = await listAcademyPackages().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(AcademyError);
    expect((failure as AcademyError).code).toBe("NOT_INSTALLED");
    expect(warn).toHaveBeenCalledWith(
      "[ducelio:academy-readiness]",
      JSON.stringify({
        rpc: "list_academy_course_packages",
        errorCode: "PGRST202",
      }),
    );
    expect(ACADEMY_ERROR_TEXT.NOT_INSTALLED).not.toMatch(
      /list_academy|PGRST|schema cache|supabase/i,
    );
    warn.mockRestore();
  });

  it("keeps database refusals and unknown failures on their existing codes", async () => {
    const { listAcademyPackages } =
      await import("@/server/academy-course-engineering");
    m.error = { code: "P0001", message: "FORBIDDEN" };
    expect(
      ((await listAcademyPackages().catch((e: unknown) => e)) as AcademyError)
        .code,
    ).toBe("FORBIDDEN");
    m.error = { code: "XX000", message: "connection reset" };
    expect(
      ((await listAcademyPackages().catch((e: unknown) => e)) as AcademyError)
        .code,
    ).toBe("SERVICE_UNAVAILABLE");
  });

  it("does not change the learner-facing Academy error mapping", () => {
    const learnerServer = readFileSync(
      "src/server/academy-delivery.ts",
      "utf8",
    );
    expect(learnerServer).not.toMatch(
      /NOT_INSTALLED|isMissingDatabaseDependency/,
    );
  });
});
