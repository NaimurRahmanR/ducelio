import { createHash, randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { testDatabase } from "./db-helper";
import {
  administrator,
  asExecutionUser,
  executionFixture,
  learner as executionLearner,
} from "./execution-fixture";
import { buildPackage } from "./activation-fixture";
import { validateCoursePackage } from "@/domain/course-package";
import {
  recoveryFixture,
  asPolicyUser,
  owner as recoveryOwner,
  value as recoveryValue,
  args as recoveryArgs,
  govern as recoveryGovern,
  type RecoveryFixture,
} from "./commercial-v1-examiner-recovery-fixture";

// AGENT-CONTROL-1 (migration 202610050050): academic agent configuration is
// bound to a ProgrammeVersion. Once that version is PUBLISHED or has an
// enrolment, academic-semantic configuration (instructional notes, model
// profile reference, capability widening, escalation policy except the one
// proven-safer EXAMINER transition) must fail closed, while the audited
// operational kill switch and capability narrowing remain available. Every
// write below goes through the real governed set_agent_config RPC as a real
// ACADEMIC_ADMIN, against the real migration chain.

let db: PGlite;

const SENTINEL_NOTE = "Governance sentinel professor note ALPHA-7731";
const SENTINEL_NOTE_HASH = createHash("sha256")
  .update(SENTINEL_NOTE, "utf8")
  .digest("hex");
const enrolledLearner = "10000000-0000-4000-8000-000000000003"; // seeded STUDENT

type Person = { auth: string; id: string };
let admin: Person;
let instructor: Person;
let learner: Person;
let programmeId: string;
let draftVersion: string;
let publishedVersion: string;
let enrolledVersion: string;

async function value<T = unknown>(sql: string, args: unknown[] = []) {
  return (await db.query<{ v: T }>(sql, args)).rows[0]?.v;
}
async function owner() {
  await db.exec("reset role; reset request.jwt.claim.sub");
}
async function as(person: Person) {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    person.auth,
  ]);
  await db.exec("set role authenticated");
}
async function signUp(name: string): Promise<Person> {
  await owner();
  const auth = randomUUID();
  await db.query(
    "insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at) values($1,$2,$3::jsonb,now())",
    [
      auth,
      `${name.toLowerCase().replace(/\s+/g, ".")}@agent-governance.example`,
      JSON.stringify({ display_name: name }),
    ],
  );
  const id = await value<string>(
    "select id as v from public.app_users where auth_user_id=$1",
    [auth],
  );
  return { auth, id: id! };
}
async function grantStaff(person: Person, role: string) {
  await owner();
  await db.query(
    "insert into public.staff_profiles(user_id,title) values($1,'Governance test staff') on conflict do nothing",
    [person.id],
  );
  await db.query(
    "insert into public.role_grants(user_id,role) values($1,$2) on conflict do nothing",
    [person.id, role],
  );
}

type Config = {
  enabled: boolean;
  ref: string | null;
  notes: string | null;
  caps: string[];
  escalation: "NONE" | "ACADEMIC_REVIEW";
};
const setConfigSql =
  "select public.set_agent_config($1,$2,$3,$4,$5,$6::text[],$7,$8) as v";
function configArgs(version: string, role: string, c: Config, reason: string) {
  return [
    version,
    role,
    c.enabled,
    c.ref,
    c.notes,
    c.caps,
    c.escalation,
    reason,
  ];
}
async function save(version: string, role: string, c: Config, reason: string) {
  await as(admin);
  try {
    return await value<string>(
      setConfigSql,
      configArgs(version, role, c, reason),
    );
  } finally {
    await owner();
  }
}
// Each refusal runs inside its own savepoint so a raised exception never
// poisons later statements, and never leaves a partial write behind.
async function refusedSave(
  version: string,
  role: string,
  c: Config,
  code: string,
) {
  await owner();
  await db.exec("begin");
  try {
    await as(admin);
    await expect(
      db.query(
        setConfigSql,
        configArgs(version, role, c, "Attempted post-binding change"),
      ),
    ).rejects.toThrow(code);
  } finally {
    await db.exec("rollback");
    await owner();
  }
}
async function stored(version: string, role: string) {
  await owner();
  return (
    await db.query<{
      enabled: boolean;
      model_profile_ref: string | null;
      instructional_notes: string | null;
      capabilities: string[];
      escalation_policy: string;
    }>(
      "select enabled,model_profile_ref,instructional_notes,capabilities,escalation_policy from public.academic_agent_configs where programme_version_id=$1 and role=$2",
      [version, role],
    )
  ).rows[0];
}

const PROFESSOR: Config = {
  enabled: true,
  ref: "PROFESSOR_COMMERCIAL_V1",
  notes: SENTINEL_NOTE,
  caps: ["get_lesson_context", "get_lesson_objectives"],
  escalation: "NONE",
};
const TUTOR: Config = {
  enabled: true,
  ref: null,
  notes: null,
  caps: ["get_lesson_context", "get_lesson_objectives"],
  escalation: "NONE",
};
const LAB: Config = { ...TUTOR };
const EXAMINER: Config = {
  enabled: true,
  ref: null,
  notes: null,
  caps: ["grade_controlled_assessment", "grade_practical_lab"],
  escalation: "NONE",
};
const COUNSELLOR: Config = {
  enabled: false,
  ref: null,
  notes: null,
  caps: [],
  escalation: "NONE",
};

async function newVersion(label: string) {
  await owner();
  const version = (await value<string>(
    "insert into public.programme_versions(programme_id,label) values($1,$2) returning id as v",
    [programmeId, label],
  ))!;
  const moduleId = await value<string>(
    "insert into public.modules(programme_version_id,title,position) values($1,'Governance module',1) returning id as v",
    [version],
  );
  const lessonId = await value<string>(
    "insert into public.lessons(module_id,programme_version_id,title,position) values($1,$2,'Governance lesson',1) returning id as v",
    [moduleId, version],
  );
  await db.query(
    "insert into public.lesson_objectives(lesson_id,programme_version_id,description,position) values($1,$2,'Explain governed configuration',1)",
    [lessonId, version],
  );
  return version;
}
async function configureAll(version: string) {
  await save(version, "PROFESSOR", PROFESSOR, "Initial reviewed Professor");
  await save(version, "TUTOR", TUTOR, "Initial reviewed Tutor");
  await save(version, "LAB_INSTRUCTOR", LAB, "Initial reviewed Lab");
  await save(version, "EXAMINER", EXAMINER, "Initial reviewed Examiner");
}
async function publish(version: string) {
  await owner();
  await db.query(
    "update public.programme_versions set status='PUBLISHED' where id=$1",
    [version],
  );
}

beforeAll(async () => {
  db = await testDatabase();
  admin = await signUp("Ada Agent Admin");
  instructor = await signUp("Ira Agent Instructor");
  learner = await signUp("Lee Agent Learner");
  await grantStaff(admin, "ACADEMIC_ADMIN");
  await grantStaff(instructor, "INSTRUCTOR");

  await owner();
  programmeId = (await value<string>(
    "insert into public.programmes(slug,title,examination_body,qualification_name) values('agent-governance','Agent Governance Programme','Test body','Test qualification') returning id as v",
  ))!;
  draftVersion = await newVersion("Draft version");
  publishedVersion = await newVersion("Published version");
  enrolledVersion = await newVersion("Enrolled version");
  for (const version of [draftVersion, publishedVersion, enrolledVersion])
    await configureAll(version);
  await publish(publishedVersion);
  await publish(enrolledVersion);
  await owner();
  const cohort = await value<string>(
    "insert into public.cohorts(programme_version_id,title,starts_on) values($1,'Governance cohort','2026-11-01') returning id as v",
    [enrolledVersion],
  );
  await db.query(
    "insert into public.enrolments(student_id,cohort_id,programme_version_id) values($1,$2,$3)",
    [enrolledLearner, cohort, enrolledVersion],
  );
}, 60000);

afterAll(async () => {
  await db?.close();
});

describe("draft programme versions remain fully editable (control)", () => {
  it("accepts instructional-note, capability-widening and escalation changes while DRAFT and unenrolled", async () => {
    await save(
      draftVersion,
      "PROFESSOR",
      { ...PROFESSOR, notes: "Revised draft note" },
      "Draft note revision",
    );
    await save(
      draftVersion,
      "TUTOR",
      { ...TUTOR, caps: [...TUTOR.caps, "get_learning_resources"] },
      "Draft capability widening",
    );
    await save(
      draftVersion,
      "TUTOR",
      { ...TUTOR, ref: "TUTOR_COMMERCIAL_V1", escalation: "ACADEMIC_REVIEW" },
      "Draft profile ref and escalation",
    );
    expect(await stored(draftVersion, "PROFESSOR")).toMatchObject({
      instructional_notes: "Revised draft note",
    });
    expect(await stored(draftVersion, "TUTOR")).toMatchObject({
      model_profile_ref: "TUTOR_COMMERCIAL_V1",
      escalation_policy: "ACADEMIC_REVIEW",
    });
  });
});

describe.each([
  ["published", () => publishedVersion],
  ["enrolled", () => enrolledVersion],
])(
  "a %s programme version refuses academic-semantic changes",
  (_label, version) => {
    it("refuses an instructional-note change", async () => {
      await refusedSave(
        version(),
        "PROFESSOR",
        { ...PROFESSOR, notes: "Silently rewritten note" },
        "AGENT_CONFIG_SEMANTIC_FROZEN",
      );
      expect((await stored(version(), "PROFESSOR")).instructional_notes).toBe(
        SENTINEL_NOTE,
      );
    });

    it("refuses clearing the instructional notes", async () => {
      await refusedSave(
        version(),
        "PROFESSOR",
        { ...PROFESSOR, notes: null },
        "AGENT_CONFIG_SEMANTIC_FROZEN",
      );
    });

    it("refuses a model profile reference change, even toward the same role's own profile", async () => {
      await refusedSave(
        version(),
        "TUTOR",
        { ...TUTOR, ref: "TUTOR_COMMERCIAL_V1" },
        "AGENT_CONFIG_SEMANTIC_FROZEN",
      );
      // Disabling the Professor cannot be used to clear its bound profile.
      await refusedSave(
        version(),
        "PROFESSOR",
        { ...PROFESSOR, enabled: false, ref: null },
        "AGENT_CONFIG_SEMANTIC_FROZEN",
      );
      expect((await stored(version(), "TUTOR")).model_profile_ref).toBeNull();
    });

    it("refuses capability widening", async () => {
      await refusedSave(
        version(),
        "TUTOR",
        { ...TUTOR, caps: [...TUTOR.caps, "get_learning_resources"] },
        "AGENT_CONFIG_SEMANTIC_FROZEN",
      );
      // Swapping one capability for another is widening too.
      await refusedSave(
        version(),
        "TUTOR",
        { ...TUTOR, caps: ["get_lesson_context", "get_learning_resources"] },
        "AGENT_CONFIG_SEMANTIC_FROZEN",
      );
      expect((await stored(version(), "TUTOR")).capabilities).toEqual(
        TUTOR.caps,
      );
    });

    it("refuses every escalation-policy change for PROFESSOR, TUTOR and LAB_INSTRUCTOR", async () => {
      await refusedSave(
        version(),
        "PROFESSOR",
        { ...PROFESSOR, escalation: "ACADEMIC_REVIEW" },
        "AGENT_CONFIG_SEMANTIC_FROZEN",
      );
      await refusedSave(
        version(),
        "TUTOR",
        { ...TUTOR, escalation: "ACADEMIC_REVIEW" },
        "AGENT_CONFIG_SEMANTIC_FROZEN",
      );
      await refusedSave(
        version(),
        "LAB_INSTRUCTOR",
        { ...LAB, escalation: "ACADEMIC_REVIEW" },
        "AGENT_CONFIG_SEMANTIC_FROZEN",
      );
    });

    it("refuses the same changes when written directly by the database owner, not only through the RPC", async () => {
      await owner();
      await db.exec("begin");
      try {
        await expect(
          db.query(
            "update public.academic_agent_configs set instructional_notes='Owner rewrite' where programme_version_id=$1 and role='PROFESSOR'",
            [version()],
          ),
        ).rejects.toThrow("AGENT_CONFIG_SEMANTIC_FROZEN");
      } finally {
        await db.exec("rollback");
      }
    });
  },
);

describe("operational changes remain available after publication and enrolment", () => {
  it("allows the enabled kill switch both ways and audits it without note content", async () => {
    await save(
      enrolledVersion,
      "PROFESSOR",
      { ...PROFESSOR, enabled: false },
      "Operational kill switch for live cohort",
    );
    expect((await stored(enrolledVersion, "PROFESSOR")).enabled).toBe(false);
    await save(
      enrolledVersion,
      "PROFESSOR",
      PROFESSOR,
      "Operational re-enable for live cohort",
    );
    const row = await stored(enrolledVersion, "PROFESSOR");
    expect(row).toMatchObject({
      enabled: true,
      instructional_notes: SENTINEL_NOTE,
      model_profile_ref: "PROFESSOR_COMMERCIAL_V1",
    });

    await owner();
    const audits = (
      await db.query<{
        actor_id: string;
        reason: string;
        before_state: Record<string, unknown>;
        after_state: Record<string, unknown>;
      }>(
        `select a.actor_id,a.reason,a.before_state,a.after_state from public.audit_events a
         join public.academic_agent_configs c on c.id=a.target_id
         where c.programme_version_id=$1 and c.role='PROFESSOR' and a.action='UPDATE'
         order by a.occurred_at`,
        [enrolledVersion],
      )
    ).rows;
    const killSwitch = audits.find(
      (a) => a.reason === "Operational kill switch for live cohort",
    );
    expect(killSwitch).toBeDefined();
    expect(killSwitch!.actor_id).toBe(admin.id);
    expect(killSwitch!.before_state.enabled).toBe(true);
    expect(killSwitch!.after_state.enabled).toBe(false);
    expect(killSwitch!.after_state.changed_fields).toEqual(["enabled"]);
  });

  it("allows capability narrowing but never re-widening afterwards", async () => {
    await save(
      publishedVersion,
      "LAB_INSTRUCTOR",
      { ...LAB, caps: ["get_lesson_context"] },
      "Operational capability narrowing",
    );
    expect(
      (await stored(publishedVersion, "LAB_INSTRUCTOR")).capabilities,
    ).toEqual(["get_lesson_context"]);
    await refusedSave(
      publishedVersion,
      "LAB_INSTRUCTOR",
      LAB,
      "AGENT_CONFIG_SEMANTIC_FROZEN",
    );
  });

  it("accepts an identical re-save (no semantic change) as a no-op update", async () => {
    await save(publishedVersion, "TUTOR", TUTOR, "Unchanged re-save");
    expect(await stored(publishedVersion, "TUTOR")).toMatchObject({
      capabilities: TUTOR.caps,
      model_profile_ref: null,
    });
  });

  it("allows EXAMINER NONE -> ACADEMIC_REVIEW and refuses the reverse direction", async () => {
    await save(
      publishedVersion,
      "EXAMINER",
      { ...EXAMINER, escalation: "ACADEMIC_REVIEW" },
      "Route new grading to human academic review",
    );
    expect((await stored(publishedVersion, "EXAMINER")).escalation_policy).toBe(
      "ACADEMIC_REVIEW",
    );
    await refusedSave(
      publishedVersion,
      "EXAMINER",
      EXAMINER,
      "AGENT_CONFIG_SEMANTIC_FROZEN",
    );
  });
});

describe("first binding of a missing role", () => {
  it("is refused on a published version that has no published course package authority at all", async () => {
    // This published version was never applied from a course package, so
    // there is no immutable package configuration a first binding could
    // match (independent-review correction): it fails closed.
    await refusedSave(
      publishedVersion,
      "COUNSELLOR",
      COUNSELLOR,
      "AGENT_CONFIG_PACKAGE_AUTHORITY_UNAVAILABLE",
    );
    expect(await stored(publishedVersion, "COUNSELLOR")).toBeUndefined();
  });

  it("is refused once the version has an enrolment", async () => {
    await refusedSave(
      enrolledVersion,
      "COUNSELLOR",
      COUNSELLOR,
      "AGENT_CONFIG_BINDING_CLOSED",
    );
    expect(await stored(enrolledVersion, "COUNSELLOR")).toBeUndefined();
  });
});

describe("audit privacy", () => {
  it("never records instructional-note text, a note hash or a preview in any agent-configuration audit payload", async () => {
    await save(
      draftVersion,
      "PROFESSOR",
      { ...PROFESSOR, notes: SENTINEL_NOTE },
      "Restore sentinel note on draft",
    );
    await owner();
    const payloads = (
      await db.query<{ payload: string }>(
        `select concat_ws('|',a.reason,a.before_state::text,a.after_state::text) as payload
         from public.audit_events a where a.target_type='academic_agent_configs'`,
      )
    ).rows.map((r) => r.payload);
    expect(payloads.length).toBeGreaterThan(0);
    const all = payloads.join("\n");
    expect(all).not.toContain("ALPHA-7731");
    expect(all).not.toContain(SENTINEL_NOTE_HASH);
    expect(all).not.toContain(SENTINEL_NOTE_HASH.slice(0, 12));
    expect(all).not.toMatch(/"instructional_notes"\s*:/);
    expect(all).not.toMatch(/note[_a-z]*(hash|digest|preview)/i);
  });

  it("records only the changed field categories for a draft note change", async () => {
    await save(
      draftVersion,
      "PROFESSOR",
      { ...PROFESSOR, notes: "Another draft revision" },
      "Draft note category check",
    );
    await owner();
    const after = await value<Record<string, unknown>>(
      `select a.after_state as v from public.audit_events a
       join public.academic_agent_configs c on c.id=a.target_id
       where c.programme_version_id=$1 and c.role='PROFESSOR' and a.reason='Draft note category check'`,
      [draftVersion],
    );
    expect(after!.changed_fields).toEqual(["instructional_notes"]);
    expect(JSON.stringify(after)).not.toContain("Another draft revision");
  });
});

describe("access control remains deny-by-default", () => {
  it("keeps every direct table privilege revoked for anon, authenticated and service_role", async () => {
    await owner();
    for (const role of ["anon", "authenticated", "service_role"]) {
      expect(
        await value<boolean>(
          "select has_table_privilege($1,'public.academic_agent_configs','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as v",
          [role],
        ),
      ).toBe(false);
      expect(
        await value<boolean>(
          "select has_any_column_privilege($1,'public.academic_agent_configs','SELECT,INSERT,UPDATE,REFERENCES') as v",
          [role],
        ),
      ).toBe(false);
    }
    await db.exec("set role service_role");
    await expect(
      db.query("update public.academic_agent_configs set enabled=false"),
    ).rejects.toThrow("permission denied");
    await owner();
  });

  it("keeps set_agent_config executable only by authenticated, and admin-authorised inside", async () => {
    await owner();
    const fn =
      "public.set_agent_config(uuid,text,boolean,text,text,text[],text,text)";
    expect(
      await value<boolean>(
        "select has_function_privilege('authenticated',$1,'EXECUTE') as v",
        [fn],
      ),
    ).toBe(true);
    for (const role of ["anon", "service_role"])
      expect(
        await value<boolean>(
          "select has_function_privilege($1,$2,'EXECUTE') as v",
          [role, fn],
        ),
      ).toBe(false);
    for (const person of [instructor, learner]) {
      await as(person);
      await expect(
        db.query(
          setConfigSql,
          configArgs(draftVersion, "TUTOR", TUTOR, "Non-admin attempt"),
        ),
      ).rejects.toThrow("Access denied");
    }
    await owner();
  });

  it("exposes no executable private governance schema or helper", async () => {
    await owner();
    for (const role of ["anon", "authenticated", "service_role"]) {
      expect(
        await value<boolean>(
          "select has_schema_privilege($1,'agent_config_governance_private','USAGE,CREATE') as v",
          [role],
        ),
      ).toBe(false);
      const executable = await value<number>(
        `select count(*)::int as v from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='agent_config_governance_private' and has_function_privilege($1,p.oid,'EXECUTE')`,
        [role],
      );
      expect(executable).toBe(0);
    }
  });
});

describe("admin agent-configuration scope read (admin_list_agent_configuration_scopes)", () => {
  type Scope = {
    programmeVersionId: string;
    programmeTitle: string;
    versionLabel: string;
    versionStatus: string;
    hasEnrolments: boolean;
    semanticConfigFrozen: boolean;
    configs: {
      role: string;
      enabled: boolean;
      modelProfileRef: string | null;
      hasInstructionalNotes: boolean;
      capabilities: string[];
      escalationPolicy: string;
    }[];
  };
  async function list(cursor?: { createdAt: string; id: string }) {
    await as(admin);
    try {
      return (await value<{
        versions: Scope[];
        hasMore: boolean;
        pageSize: number;
        nextCursor: { createdAt: string; id: string } | null;
      }>("select public.admin_list_agent_configuration_scopes($1,$2) as v", [
        cursor?.createdAt ?? null,
        cursor?.id ?? null,
      ]))!;
    } finally {
      await owner();
    }
  }

  it("reports binding state and configuration metadata without note text", async () => {
    const page = await list();
    const byId = new Map(page.versions.map((v) => [v.programmeVersionId, v]));
    expect(byId.get(draftVersion)).toMatchObject({
      versionStatus: "DRAFT",
      hasEnrolments: false,
      semanticConfigFrozen: false,
    });
    expect(byId.get(publishedVersion)).toMatchObject({
      versionStatus: "PUBLISHED",
      hasEnrolments: false,
      semanticConfigFrozen: true,
    });
    const enrolled = byId.get(enrolledVersion)!;
    expect(enrolled).toMatchObject({
      programmeTitle: "Agent Governance Programme",
      versionLabel: "Enrolled version",
      hasEnrolments: true,
      semanticConfigFrozen: true,
    });
    expect(enrolled.configs.find((c) => c.role === "PROFESSOR")).toMatchObject({
      modelProfileRef: "PROFESSOR_COMMERCIAL_V1",
      hasInstructionalNotes: true,
      escalationPolicy: "NONE",
    });
    expect(JSON.stringify(page)).not.toContain("ALPHA-7731");
    expect(JSON.stringify(page)).not.toContain('instructionalNotes"');
  });

  it("pages with a keyset cursor and never repeats a version", async () => {
    const first = await list();
    expect(first.pageSize).toBe(50);
    const seen = new Set(first.versions.map((v) => v.programmeVersionId));
    let cursor = first.nextCursor;
    let more = first.hasMore;
    while (more && cursor) {
      const next = await list(cursor);
      for (const v of next.versions) {
        expect(seen.has(v.programmeVersionId)).toBe(false);
        seen.add(v.programmeVersionId);
      }
      more = next.hasMore;
      cursor = next.nextCursor;
    }
    await owner();
    expect(seen.size).toBe(
      await value<number>(
        "select count(*)::int as v from public.programme_versions",
      ),
    );
  });

  it("refuses non-admin callers and is not executable by anon or service_role", async () => {
    for (const person of [instructor, learner]) {
      await as(person);
      await expect(
        db.query(
          "select public.admin_list_agent_configuration_scopes(null,null)",
        ),
      ).rejects.toThrow("FORBIDDEN");
    }
    await owner();
    for (const role of ["anon", "service_role"])
      expect(
        await value<boolean>(
          "select has_function_privilege($1,'public.admin_list_agent_configuration_scopes(timestamptz,uuid)','EXECUTE') as v",
          [role],
        ),
      ).toBe(false);
  });

  it("refuses a half-specified cursor", async () => {
    await as(admin);
    await expect(
      db.query(
        "select public.admin_list_agent_configuration_scopes(now(),null)",
      ),
    ).rejects.toThrow("INVALID_INPUT");
    await owner();
  });
});

// The single post-binding escalation transition migration 050 permits is
// EXAMINER NONE -> ACADEMIC_REVIEW. This proves, against a real published,
// activated and enrolled course, that it is truthful: the next governed
// Examiner admission becomes a durable ESCALATED claim that appears in the
// existing human academic-review worklist (migration 047). The initial-
// grading path's identical claim shape is proven by
// commercial-v1-examiner-grading-db.test.ts case E; regrade (migration 032)
// never reads this field and is unaffected.
describe("EXAMINER escalation transition on a live course", () => {
  let f: RecoveryFixture;
  beforeAll(async () => {
    f = await recoveryFixture({ withLabs: false });
  }, 120000);
  afterAll(async () => {
    await f?.db.close();
  });

  it("routes the next admitted Examiner claim to a durable human academic-review case", async () => {
    await recoveryOwner(f.db);
    expect(
      await recoveryValue<string>(
        f.db,
        "select status as v from programme_versions where id=$1",
        [f.programmeVersionId],
      ),
    ).toBe("PUBLISHED");
    expect(
      await recoveryValue<number>(
        f.db,
        "select count(*)::int as v from enrolments where programme_version_id=$1",
        [f.programmeVersionId],
      ),
    ).toBeGreaterThan(0);

    await asPolicyUser(f.db, 2);
    await f.db.query(
      "select public.set_agent_config($1,'EXAMINER',true,null,null,array['grade_controlled_assessment','grade_practical_lab'],'ACADEMIC_REVIEW','Route grading to human review')",
      [f.programmeVersionId],
    );
    const result = (await recoveryGovern(f, recoveryArgs(f))) as {
      ok: boolean;
      execution: { executionId: string; state: string; reviewPath: string };
    };
    expect(result).toMatchObject({
      ok: true,
      execution: { state: "ESCALATED", reviewPath: "ACADEMIC_REVIEW" },
    });

    await asPolicyUser(f.db, 2);
    const cases = await recoveryValue<{
      cases: { caseKind: string; caseId: string; caseState: string }[];
    }>(f.db, "select public.list_commercial_v1_academic_review_cases() as v");
    expect(cases.cases).toContainEqual(
      expect.objectContaining({
        caseKind: "RECOVERY_ESCALATION",
        caseId: result.execution.executionId,
        caseState: "ESCALATED",
      }),
    );

    await expect(
      f.db.query(
        "select public.set_agent_config($1,'EXAMINER',true,null,null,array['grade_controlled_assessment','grade_practical_lab'],'NONE','Attempted revert to automated grading')",
        [f.programmeVersionId],
      ),
    ).rejects.toThrow("AGENT_CONFIG_SEMANTIC_FROZEN");
    await recoveryOwner(f.db);
  });
});

// Independent-review correction: on a PUBLISHED version, a role that has no
// configuration row may receive its first binding ONLY when the new row
// exactly matches that version's single, immutable published course
// package proposal, which the database derives itself from
// course_package_imports. That is exactly what migration 027/037's
// course_activation_private.configs() supplies, so real activation keeps
// working, while arbitrary post-publication authoring does not. The version
// below is built through the real governed pipeline (import -> validate ->
// apply -> configure -> pre-publication test -> publish), and every test
// runs in its own rolled-back transaction.
//
// A published package version normally already has all five rows (the
// pre-publication test requires them), so a MISSING row is test-owner
// seeded by deleting one with the history guard disabled -- the same
// pattern commercial-v1-examiner-grading-db.test.ts uses. This models the
// state in which activation materialises a missing role row.
describe("first binding on a published package version must match the immutable package", () => {
  let pdb: PGlite;
  let importId: string;
  let packageVersion: string;
  let packageCohort: string;
  const packageNote = "  Package professor note: use worked examples.  ";
  const disabled = {
    enabled: false,
    modelProfileRef: null,
    instructionalNotes: null,
    capabilities: [],
    escalationPolicy: "NONE" as const,
  };
  const pkg = buildPackage({
    packageKey: "agent-governance-package",
    assignmentTemplates: [],
    assessmentTemplates: [],
    agentConfiguration: {
      PROFESSOR: {
        enabled: true,
        modelProfileRef: "PROFESSOR_COMMERCIAL_V1",
        instructionalNotes: packageNote,
        capabilities: ["get_lesson_objectives", "get_lesson_context"],
        escalationPolicy: "NONE",
      },
      TUTOR: {
        enabled: true,
        modelProfileRef: null,
        instructionalNotes: null,
        capabilities: ["get_lesson_context", "get_lesson_objectives"],
        escalationPolicy: "ACADEMIC_REVIEW",
      },
      LAB_INSTRUCTOR: disabled,
      EXAMINER: disabled,
      COUNSELLOR: disabled,
    },
  });
  type Role = keyof typeof pkg.agentConfiguration;
  type Row = {
    enabled: boolean;
    ref: string | null;
    notes: string | null;
    caps: string[];
    escalation: string;
  };
  const proposal = (role: Role): Row => {
    const c = pkg.agentConfiguration[role];
    return {
      enabled: c.enabled,
      ref: c.modelProfileRef,
      notes: c.instructionalNotes,
      caps: [...c.capabilities],
      escalation: c.escalationPolicy,
    };
  };
  async function pv<T = string>(sql: string, params: unknown[] = []) {
    return (await pdb.query<{ v: T }>(sql, params)).rows[0]?.v as T;
  }
  async function asAdmin() {
    await asExecutionUser(pdb, 2);
  }
  async function asOwner() {
    await pdb.exec("reset role");
  }
  const setSql =
    "select public.set_agent_config($1,$2,$3,$4,$5,$6::text[],$7,$8) as v";
  function setArgs(role: Role, r: Row, reason: string) {
    return [
      packageVersion,
      role,
      r.enabled,
      r.ref,
      r.notes,
      r.caps,
      r.escalation,
      reason,
    ];
  }
  async function refused(role: Role, r: Row, code: string) {
    await pdb.exec("savepoint refusal");
    try {
      await asAdmin();
      await expect(
        pdb.query(setSql, setArgs(role, r, "Post-publication first binding")),
      ).rejects.toThrow(code);
    } finally {
      await pdb.exec(
        "rollback to savepoint refusal; release savepoint refusal",
      );
      await asOwner();
    }
  }
  async function removeRow(role: Role) {
    await asOwner();
    await pdb.exec(
      "alter table public.academic_agent_configs disable trigger guard_agent_config_history",
    );
    await pdb.query(
      "delete from public.academic_agent_configs where programme_version_id=$1 and role=$2",
      [packageVersion, role],
    );
    await pdb.exec(
      "alter table public.academic_agent_configs enable trigger guard_agent_config_history",
    );
  }
  async function row(role: Role) {
    await asOwner();
    return (
      await pdb.query<{
        enabled: boolean;
        model_profile_ref: string | null;
        instructional_notes: string | null;
        capabilities: string[];
        escalation_policy: string;
      }>(
        "select enabled,model_profile_ref,instructional_notes,capabilities,escalation_policy from public.academic_agent_configs where programme_version_id=$1 and role=$2",
        [packageVersion, role],
      )
    ).rows[0];
  }
  const activationSql =
    "select public.activate_course_package($1,$2,$3,'[]'::jsonb,'[]'::jsonb,'Reviewed package activation') as v";

  beforeAll(async () => {
    ({ db: pdb } = await executionFixture());
    await asAdmin();
    importId = await pv(
      "select public.import_course_package($1,1,$2,$3::jsonb,'Governance package import') as v",
      [pkg.packageKey, pkg.schemaVersion, JSON.stringify(pkg)],
    );
    const validated = validateCoursePackage(pkg);
    if (!validated.valid) throw new Error("Invalid governance package");
    await pdb.query(
      "select public.mark_course_package_validated($1,$2::jsonb,'Governance package validated')",
      [importId, JSON.stringify(validated.report)],
    );
    packageVersion = await pv(
      "select public.apply_course_package($1,'Governance package applied') as v",
      [importId],
    );
    for (const role of Object.keys(pkg.agentConfiguration) as Role[])
      await pdb.query(
        setSql,
        setArgs(role, proposal(role), "Configure exactly as proposed"),
      );
    expect(
      await pv(
        "select outcome as v from public.run_course_package_test($1,'Governance pre-publication test')",
        [importId],
      ),
    ).toBe("PASS");
    await pdb.query(
      "select public.publish_course_package($1,'Publish governance package')",
      [importId],
    );
    await asOwner();
    packageCohort = randomUUID();
    await pdb.query(
      "insert into public.cohorts(id,programme_version_id,title,starts_on) values($1,$2,'Governance package cohort',current_date)",
      [packageCohort, packageVersion],
    );
    expect(
      await pv<string>(
        "select status as v from public.programme_versions where id=$1",
        [packageVersion],
      ),
    ).toBe("PUBLISHED");
    expect(
      await pv<number>(
        "select count(*)::int as v from public.enrolments where programme_version_id=$1",
        [packageVersion],
      ),
    ).toBe(0);
  }, 120000);
  afterAll(async () => {
    await pdb?.close();
  });
  beforeEach(async () => {
    await asOwner();
    await pdb.exec("begin");
  });
  afterEach(async () => {
    await pdb.exec("rollback; reset role");
  });

  it("refuses arbitrary instructional notes that differ from the package", async () => {
    await removeRow("PROFESSOR");
    await refused(
      "PROFESSOR",
      { ...proposal("PROFESSOR"), notes: "Post-publication rewritten note" },
      "AGENT_CONFIG_PACKAGE_MISMATCH",
    );
    expect(await row("PROFESSOR")).toBeUndefined();
  });

  it("refuses a model profile reference that differs from the package", async () => {
    await removeRow("TUTOR");
    await refused(
      "TUTOR",
      { ...proposal("TUTOR"), ref: "TUTOR_COMMERCIAL_V1" },
      "AGENT_CONFIG_PACKAGE_MISMATCH",
    );
    expect(await row("TUTOR")).toBeUndefined();
  });

  it("refuses capabilities that differ from the package, narrower or wider", async () => {
    await removeRow("PROFESSOR");
    await refused(
      "PROFESSOR",
      { ...proposal("PROFESSOR"), caps: ["get_lesson_context"] },
      "AGENT_CONFIG_PACKAGE_MISMATCH",
    );
    await refused(
      "PROFESSOR",
      {
        ...proposal("PROFESSOR"),
        caps: [...proposal("PROFESSOR").caps, "get_learning_resources"],
      },
      "AGENT_CONFIG_PACKAGE_MISMATCH",
    );
    expect(await row("PROFESSOR")).toBeUndefined();
  });

  it("refuses an escalation policy that differs from the package", async () => {
    await removeRow("TUTOR");
    await refused(
      "TUTOR",
      { ...proposal("TUTOR"), escalation: "NONE" },
      "AGENT_CONFIG_PACKAGE_MISMATCH",
    );
    expect(await row("TUTOR")).toBeUndefined();
  });

  it("refuses an availability that differs from the package", async () => {
    await removeRow("TUTOR");
    await refused(
      "TUTOR",
      { ...proposal("TUTOR"), enabled: false },
      "AGENT_CONFIG_PACKAGE_MISMATCH",
    );
    expect(await row("TUTOR")).toBeUndefined();
  });

  it("allows the exact immutable package configuration, normalised exactly as activation does", async () => {
    await removeRow("PROFESSOR");
    await asAdmin();
    await pdb.query(
      setSql,
      setArgs(
        "PROFESSOR",
        {
          ...proposal("PROFESSOR"),
          // The same set in another order; notes differ only by the trim
          // normalisation set_agent_config and activation both apply.
          caps: ["get_lesson_context", "get_lesson_objectives"],
          notes: packageNote,
        },
        "Exact package first binding",
      ),
    );
    expect(await row("PROFESSOR")).toEqual({
      enabled: true,
      model_profile_ref: "PROFESSOR_COMMERCIAL_V1",
      instructional_notes: packageNote.trim(),
      capabilities: ["get_lesson_context", "get_lesson_objectives"],
      escalation_policy: "NONE",
    });
  });

  it("lets real course activation create a missing role row exactly as the package proposes", async () => {
    await removeRow("TUTOR");
    await asAdmin();
    const activationId = await pv(activationSql, [
      importId,
      packageCohort,
      administrator,
    ]);
    expect(activationId).toBeTruthy();
    expect(await row("TUTOR")).toEqual({
      enabled: true,
      model_profile_ref: null,
      instructional_notes: null,
      capabilities: ["get_lesson_context", "get_lesson_objectives"],
      escalation_policy: "ACADEMIC_REVIEW",
    });
  });

  it("refuses a first binding once learners are enrolled even when it matches the package, and activation cannot create one either", async () => {
    await asAdmin();
    await pdb.query(
      "select public.create_enrolment($1,$2,'Reviewed governance enrolment')",
      [executionLearner, packageCohort],
    );
    await removeRow("COUNSELLOR");
    await refused(
      "COUNSELLOR",
      proposal("COUNSELLOR"),
      "AGENT_CONFIG_BINDING_CLOSED",
    );
    await pdb.exec("savepoint activation");
    try {
      await asAdmin();
      await expect(
        pdb.query(activationSql, [importId, packageCohort, administrator]),
      ).rejects.toThrow("AGENT_CONFIG_BINDING_CLOSED");
    } finally {
      await pdb.exec(
        "rollback to savepoint activation; release savepoint activation",
      );
      await asOwner();
    }
    expect(await row("COUNSELLOR")).toBeUndefined();
  });

  it("fails closed when more than one course package claims the programme version", async () => {
    await removeRow("PROFESSOR");
    await asOwner();
    // Test-owner seeded ambiguity: the schema has no unique constraint on
    // course_package_imports.programme_version_id, so the guard must never
    // pick an arbitrary row, even when both rows carry the same package.
    await pdb.query(
      `insert into public.course_package_imports(package_key,package_revision,schema_version,content_hash,raw_package,validation_report,status,programme_id,programme_version_id,created_by,applied_at,applied_by,published_at,published_by)
       select 'agent-governance-duplicate',1,schema_version,content_hash,raw_package,validation_report,'PUBLISHED',programme_id,programme_version_id,created_by,applied_at,applied_by,published_at,published_by
       from public.course_package_imports where id=$1`,
      [importId],
    );
    await refused(
      "PROFESSOR",
      proposal("PROFESSOR"),
      "AGENT_CONFIG_PACKAGE_AUTHORITY_UNAVAILABLE",
    );
    expect(await row("PROFESSOR")).toBeUndefined();
  });
});
