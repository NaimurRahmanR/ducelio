import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  executionFixture,
  asExecutionUser,
  openExecutionRelease,
  learner,
  foreignLearner,
  administrator,
  type ExecutionFixture,
} from "./execution-fixture";
import {
  signedProviderCommand,
  sendProviderCommand,
} from "./provider-execution-fixture";

// AC-2 / migration 202610050051 against the real migration chain:
//   * Level-3 behaviour configuration authority and freeze;
//   * attested, database-verified Professor execution provenance;
//   * attested, learner-owned, firewall-gated Professor classroom memory;
//   * authoritative classroom timing.
// Every test runs inside its own rolled-back transaction.

let f: ExecutionFixture;
const seededVersion = "20000000-0000-4000-8000-000000000002"; // published + enrolled
const seededProgramme = "20000000-0000-4000-8000-000000000001";
const cohort = "50000000-0000-4000-8000-000000000001";
const lesson = "40000000-0000-4000-8000-000000000001";
let classSession: string;
let pastClassSession: string;
let draftVersion: string;

async function value<T = unknown>(sql: string, args: unknown[] = []) {
  return (await f.db.query<{ v: T }>(sql, args)).rows[0]?.v as T;
}
async function owner() {
  await f.db.exec("reset role");
}
const as = (n: number) => asExecutionUser(f.db, n);

function mac(canonical: string) {
  return createHmac("sha256", f.key).update(canonical, "utf8").digest("hex");
}
function window() {
  const issuedAt = Math.floor(Date.now() / 1000);
  return { issuedAt, expiresAt: issuedAt + 10 };
}
type Provenance = {
  executionId: string;
  releaseId: string;
  objectivesReleaseId: string;
  classSessionId: string;
  // Defaults to [lesson context (outer), objectives].
  manifest?: [string, string][];
  // Sign one manifest but submit another.
  signedManifest?: [string, string][];
  ref: string | null;
  institutionalBaselineVersion?: string;
  behaviourVersion: string;
  configVersion: string;
  actor?: string;
  keyId?: string;
  tamper?: boolean;
};
async function recordProvenance(p: Provenance) {
  const { issuedAt, expiresAt } = window();
  const keyId = p.keyId ?? f.keyId;
  const manifest: [string, string][] = p.manifest ?? [
    ["get_lesson_context", p.releaseId],
    ["get_lesson_objectives", p.objectivesReleaseId],
  ];
  const canonical = [
    "DUCELIO_AGENT_PROVENANCE_HMAC_SHA256_V1",
    "PROFESSOR",
    keyId,
    p.actor ?? learner,
    p.executionId,
    p.releaseId,
    p.classSessionId,
    (p.signedManifest ?? manifest).map(([c, r]) => `${c}:${r}`).join(","),
    p.ref ?? "NONE",
    p.institutionalBaselineVersion ?? "DUCELIO_INSTITUTIONAL_BASELINE_V1",
    p.behaviourVersion,
    p.configVersion,
    String(issuedAt),
    String(expiresAt),
  ].join("\n");
  return value<{ ok: boolean; code?: string }>(
    "select public.record_professor_execution_provenance($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) as v",
    [
      keyId,
      p.executionId,
      p.releaseId,
      p.classSessionId,
      manifest.map(([c]) => c),
      manifest.map(([, r]) => r),
      p.ref,
      p.institutionalBaselineVersion ?? "DUCELIO_INSTITUTIONAL_BASELINE_V1",
      p.behaviourVersion,
      p.configVersion,
      issuedAt,
      expiresAt,
      p.tamper ? "0".repeat(64) : mac(canonical),
    ],
  );
}
const sha = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");
async function recordTurn(t: {
  executionId: string;
  classSessionId: string;
  kind: "BEGIN_LESSON" | "LEARNER_QUESTION";
  learnerMessage: string | null;
  professorMessage: string;
  signedProfessorMessage?: string;
}) {
  const { issuedAt, expiresAt } = window();
  const canonical = [
    "DUCELIO_CLASSROOM_TURN_HMAC_SHA256_V1",
    "PROFESSOR",
    f.keyId,
    learner,
    t.executionId,
    t.classSessionId,
    t.kind,
    sha(t.learnerMessage ?? ""),
    sha(t.signedProfessorMessage ?? t.professorMessage),
    String(issuedAt),
    String(expiresAt),
  ].join("\n");
  return value<{ ok: boolean; code?: string; duplicate?: boolean }>(
    "select public.record_professor_classroom_turn($1,$2,$3,$4,$5,$6,$7,$8,$9) as v",
    [
      f.keyId,
      t.executionId,
      t.classSessionId,
      t.kind,
      t.learnerMessage,
      t.professorMessage,
      issuedAt,
      expiresAt,
      mac(canonical),
    ],
  );
}
async function openRelease(capability: string) {
  return value<{ ok: boolean; release_id: string }>(
    "select public.begin_academic_content_release($1,$2,'PROFESSOR_READ_V2') as v",
    [randomUUID(), capability],
  );
}
async function professorExecution(): Promise<{
  executionId: string;
  releaseId: string;
  objectivesReleaseId: string;
}> {
  await as(1);
  const releaseId = (await openExecutionRelease(f.db)).release_id;
  // Nested, exactly as the runtime composes them: opened after the outer.
  const objectivesReleaseId = (await openRelease("get_lesson_objectives"))
    .release_id;
  const executionId = randomUUID();
  const authorized = await sendProviderCommand(
    f.db,
    signedProviderCommand(f, {
      executionId,
      releaseId,
      operation: "AUTHORIZE",
      state: "AUTHORIZED",
    }),
  );
  expect(authorized).toMatchObject({
    ok: true,
    execution: { state: "AUTHORIZED" },
  });
  return { executionId, releaseId, objectivesReleaseId };
}
async function startAndSucceed(
  executionId: string,
  releaseId: string,
  objectivesReleaseId?: string,
) {
  await as(1);
  const zero = { maxCalls: 0, maxOutput: 0, maxCost: 0 };
  const started = await sendProviderCommand(
    f.db,
    signedProviderCommand(f, {
      executionId,
      releaseId,
      operation: "START",
      state: "RUNNING",
      ...zero,
    }),
  );
  expect(started).toMatchObject({ ok: true, execution: { state: "RUNNING" } });
  // Exactly as the gateways do: every content release closes before FINALIZE.
  for (const id of [objectivesReleaseId, releaseId].filter(Boolean))
    await f.db.query("select public.close_academic_content_release($1,true)", [
      id,
    ]);
  const result = await sendProviderCommand(
    f.db,
    signedProviderCommand(f, {
      executionId,
      releaseId,
      operation: "FINALIZE",
      state: "SUCCEEDED",
      reason: "PROVIDER_COMPLETE",
      ...zero,
      calls: 1,
      attempts: 1,
      input: 100,
      output: 50,
      cost: 1000,
      elapsed: 100,
    }),
  );
  expect(result).toMatchObject({ ok: true, execution: { state: "SUCCEEDED" } });
}
const validProvenance = (e: {
  executionId: string;
  releaseId: string;
  objectivesReleaseId: string;
}) => ({
  ...e,
  classSessionId: classSession,
  ref: "PROFESSOR_COMMERCIAL_V1",
  behaviourVersion: "PROFESSOR_BEHAVIOUR_V1",
  configVersion: "AGENT_BEHAVIOUR_DEFAULT_V1",
});
async function withoutGuard(
  trigger: string,
  table: string,
  sql: string,
  args: unknown[],
) {
  await owner();
  await f.db.exec(`alter table ${table} disable trigger ${trigger}`);
  await f.db.query(sql, args);
  await f.db.exec(`alter table ${table} enable trigger ${trigger}`);
}

beforeAll(async () => {
  f = await executionFixture();
  await owner();
  // Fixture-owner seeding of state the governed RPCs correctly refuse on an
  // already published and enrolled version (AC-1 / migration 050): the
  // seeded demo version's PROFESSOR configuration.
  await withoutGuard(
    "guard_agent_config_semantic_binding",
    "public.academic_agent_configs",
    "insert into public.academic_agent_configs(programme_version_id,role,enabled,model_profile_ref,capabilities,escalation_policy,created_by) values($1,'PROFESSOR',true,'PROFESSOR_COMMERCIAL_V1',array['get_lesson_context','get_lesson_objectives'],'NONE',$2)",
    [seededVersion, administrator],
  );
  classSession = await value(
    "insert into public.class_sessions(cohort_id,programme_version_id,lesson_id,instructor_id,scheduled_start,scheduled_end,created_by) values($1,$2,$3,$4,clock_timestamp()-interval '10 minutes',clock_timestamp()+interval '50 minutes',$4) returning id as v",
    [cohort, seededVersion, lesson, administrator],
  );
  pastClassSession = await value(
    "insert into public.class_sessions(cohort_id,programme_version_id,lesson_id,instructor_id,scheduled_start,scheduled_end,created_by) values($1,$2,$3,$4,clock_timestamp()-interval '3 hours',clock_timestamp()-interval '2 hours',$4) returning id as v",
    [cohort, seededVersion, lesson, administrator],
  );
  draftVersion = await value(
    "insert into public.programme_versions(programme_id,label) values($1,'AC-2 behaviour draft') returning id as v",
    [seededProgramme],
  );
  await as(1);
  for (const s of [classSession, pastClassSession])
    expect(
      await value("select public.open_professor_classroom($1) as v", [s]),
    ).toMatchObject({ ok: true });
  await owner();
}, 120000);
beforeEach(async () => {
  await owner();
  await f.db.exec("begin");
});
afterEach(async () => {
  await f.db.exec("rollback; reset role");
});
afterAll(async () => {
  await f.db?.close();
});

const setSql =
  "select public.admin_set_agent_behaviour_config($1,$2,$3,$4,$5,$6,$7,$8) as v";
async function refused(sql: string, args: unknown[], code: string) {
  await f.db.exec("savepoint refusal");
  try {
    await expect(f.db.query(sql, args)).rejects.toThrow(code);
  } finally {
    await f.db.exec("rollback to savepoint refusal; release savepoint refusal");
  }
}

async function newDraft(label: string) {
  await owner();
  return value<string>(
    "insert into public.programme_versions(programme_id,label) values($1,$2) returning id as v",
    [seededProgramme, label],
  );
}
async function publish(version: string) {
  await owner();
  const moduleId = await value<string>(
    "insert into public.modules(programme_version_id,title,position) values($1,'Module',1) returning id as v",
    [version],
  );
  const lessonId = await value<string>(
    "insert into public.lessons(module_id,programme_version_id,title,position) values($1,$2,'Lesson',1) returning id as v",
    [moduleId, version],
  );
  await f.db.query(
    "insert into public.lesson_objectives(lesson_id,programme_version_id,description,position) values($1,$2,'Objective',1)",
    [lessonId, version],
  );
  await f.db.query(
    "update public.programme_versions set status='PUBLISHED' where id=$1",
    [version],
  );
}
async function enrolForeignLearner(version: string) {
  await owner();
  const cohortId = await value<string>(
    "insert into public.cohorts(programme_version_id,title,starts_on) values($1,'Binding cohort','2026-09-01') returning id as v",
    [version],
  );
  return value<string>(
    "insert into public.enrolments(student_id,cohort_id,programme_version_id) values($1,$2,$3) returning id as v",
    [foreignLearner, cohortId, version],
  );
}
const setArgs = (version: string, role: string, depth = "STANDARD") => [
  version,
  role,
  depth,
  "CONCEPT_FIRST",
  "STANDARD",
  "STANDARD",
  null,
  "Behaviour freeze matrix",
];
describe("level-3 behaviour configuration authority", () => {
  it("lets an academic admin author a draft version's configuration, audited without note text", async () => {
    await as(2);
    const id = await value<string>(setSql, [
      draftVersion,
      "PROFESSOR",
      "DETAILED",
      "WORKED_EXAMPLE_FIRST",
      "HIGH",
      "FOUNDATION",
      "  Use CompTIA terminology SENTINEL-NOTE.  ",
      "Draft behaviour authoring",
    ]);
    await value(setSql, [
      draftVersion,
      "PROFESSOR",
      "CONCISE",
      "WORKED_EXAMPLE_FIRST",
      "HIGH",
      "FOUNDATION",
      "Revised SENTINEL-NOTE",
      "Draft behaviour revision",
    ]);
    await owner();
    const row = (
      await f.db.query(
        "select response_depth,course_context_notes from public.academic_agent_behaviour_configs where id=$1",
        [id],
      )
    ).rows[0];
    expect(row).toEqual({
      response_depth: "CONCISE",
      course_context_notes: "Revised SENTINEL-NOTE",
    });
    const audits = JSON.stringify(
      (
        await f.db.query(
          "select before_state,after_state from public.audit_events where target_type='academic_agent_behaviour_configs' and target_id=$1",
          [id],
        )
      ).rows,
    );
    expect(audits).not.toContain("SENTINEL-NOTE");
    expect(audits).toContain(
      '"changed_fields":["response_depth","course_context_notes"]',
    );
  });

  it("rejects invalid enums, unbounded notes, a missing reason and unknown roles", async () => {
    await as(2);
    const base = [
      draftVersion,
      "TUTOR",
      "STANDARD",
      "CONCEPT_FIRST",
      "STANDARD",
      "STANDARD",
      null,
      "Valid reason text",
    ];
    for (const [index, bad] of [
      [2, "EXHAUSTIVE"],
      [3, "LECTURE"],
      [4, "NEVER"],
      [5, "EXPERT"],
      [6, "x".repeat(2001)],
      [7, "no"],
      [1, "EXAMINER"],
      [1, "COUNSELLOR"],
    ] as const) {
      const args = [...base];
      args[index] = bad;
      await refused(setSql, args, "INVALID_INPUT");
    }
  });

  it("is admin-only and not executable by anon or service_role", async () => {
    await as(1);
    await refused(
      setSql,
      [
        draftVersion,
        "TUTOR",
        "STANDARD",
        "CONCEPT_FIRST",
        "STANDARD",
        "STANDARD",
        null,
        "Learner attempt",
      ],
      "FORBIDDEN",
    );
    await refused(
      "select public.admin_list_agent_behaviour_configs($1)",
      [draftVersion],
      "FORBIDDEN",
    );
    await owner();
    for (const role of ["anon", "service_role"])
      expect(
        await value(
          "select has_function_privilege($1,'public.admin_set_agent_behaviour_config(uuid,text,text,text,text,text,text,text)','EXECUTE') as v",
          [role],
        ),
      ).toBe(false);
  });

  it("refuses any configuration change on a published or enrolled version, and never deletes", async () => {
    await as(2);
    await refused(
      setSql,
      [
        seededVersion,
        "PROFESSOR",
        "DETAILED",
        "CONCEPT_FIRST",
        "STANDARD",
        "STANDARD",
        null,
        "Post-publication behaviour change",
      ],
      "AGENT_BEHAVIOUR_CONFIG_FROZEN",
    );
    await value(setSql, [
      draftVersion,
      "LAB_INSTRUCTOR",
      "STANDARD",
      "GUIDED_QUESTIONING",
      "STANDARD",
      "STANDARD",
      null,
      "Before publication",
    ]);
    await owner();
    await f.db.query(
      "insert into public.modules(programme_version_id,title,position) values($1,'Module',1)",
      [draftVersion],
    );
    const moduleId = await value<string>(
      "select id as v from public.modules where programme_version_id=$1",
      [draftVersion],
    );
    const lessonId = await value<string>(
      "insert into public.lessons(module_id,programme_version_id,title,position) values($1,$2,'Lesson',1) returning id as v",
      [moduleId, draftVersion],
    );
    await f.db.query(
      "insert into public.lesson_objectives(lesson_id,programme_version_id,description,position) values($1,$2,'Objective',1)",
      [lessonId, draftVersion],
    );
    await f.db.query(
      "update public.programme_versions set status='PUBLISHED' where id=$1",
      [draftVersion],
    );
    await as(2);
    await refused(
      setSql,
      [
        draftVersion,
        "LAB_INSTRUCTOR",
        "DETAILED",
        "GUIDED_QUESTIONING",
        "STANDARD",
        "STANDARD",
        null,
        "After publication",
      ],
      "AGENT_BEHAVIOUR_CONFIG_FROZEN",
    );
    await owner();
    await refused(
      "delete from public.academic_agent_behaviour_configs where programme_version_id=$1",
      [draftVersion],
      "AGENT_BEHAVIOUR_CONFIG_HISTORY",
    );
  });

  const directInsert =
    "insert into public.academic_agent_behaviour_configs(programme_version_id,role,response_depth,teaching_approach,understanding_check_frequency,challenge_level,created_by) values($1,$2,'DETAILED','CONCEPT_FIRST','STANDARD','STANDARD',$3)";

  it("allows first insert and update only on a draft, and freezes FIRST inserts as well as updates once published or enrolled", async () => {
    // DRAFT / unbound: first insert, then update.
    const published = await newDraft("AC-2 freeze: published");
    await as(2);
    const id = await value<string>(setSql, setArgs(published, "PROFESSOR"));
    expect(
      await value<string>(setSql, setArgs(published, "PROFESSOR", "DETAILED")),
    ).toBe(id);
    await owner();
    expect(
      await value(
        "select response_depth as v from public.academic_agent_behaviour_configs where id=$1",
        [id],
      ),
    ).toBe("DETAILED");

    // PUBLISHED (no enrolments): no first insert, no update, no delete,
    // whether through the governed RPC or a direct owner write.
    await publish(published);
    await as(2);
    await refused(
      setSql,
      setArgs(published, "TUTOR"),
      "AGENT_BEHAVIOUR_CONFIG_FROZEN",
    );
    await refused(
      setSql,
      setArgs(published, "PROFESSOR", "CONCISE"),
      "AGENT_BEHAVIOUR_CONFIG_FROZEN",
    );
    await owner();
    await refused(
      directInsert,
      [published, "LAB_INSTRUCTOR", administrator],
      "AGENT_BEHAVIOUR_CONFIG_FROZEN",
    );
    await refused(
      "update public.academic_agent_behaviour_configs set response_depth='CONCISE' where id=$1",
      [id],
      "AGENT_BEHAVIOUR_CONFIG_FROZEN",
    );
    await refused(
      "delete from public.academic_agent_behaviour_configs where id=$1",
      [id],
      "AGENT_BEHAVIOUR_CONFIG_HISTORY",
    );

    // ENROLLED (enrolment requires PUBLISHED, migration 005): a row written
    // while it was a draft, then published and enrolled.
    const enrolled = await newDraft("AC-2 freeze: enrolled");
    await as(2);
    const labRow = await value<string>(
      setSql,
      setArgs(enrolled, "LAB_INSTRUCTOR"),
    );
    await publish(enrolled);
    const cohortId = await value<string>(
      "insert into public.cohorts(programme_version_id,title,starts_on) values($1,'Freeze cohort','2026-09-01') returning id as v",
      [enrolled],
    );
    await f.db.query(
      "insert into public.enrolments(student_id,cohort_id,programme_version_id) values($1,$2,$3)",
      [foreignLearner, cohortId, enrolled],
    );
    await as(2);
    await refused(
      setSql,
      setArgs(enrolled, "PROFESSOR"),
      "AGENT_BEHAVIOUR_CONFIG_FROZEN",
    );
    await refused(
      setSql,
      setArgs(enrolled, "LAB_INSTRUCTOR", "DETAILED"),
      "AGENT_BEHAVIOUR_CONFIG_FROZEN",
    );
    await owner();
    await refused(
      directInsert,
      [enrolled, "TUTOR", administrator],
      "AGENT_BEHAVIOUR_CONFIG_FROZEN",
    );
    await refused(
      "delete from public.academic_agent_behaviour_configs where id=$1",
      [labRow],
      "AGENT_BEHAVIOUR_CONFIG_HISTORY",
    );
    // Nothing was added after binding: roles without a row keep the
    // default values frozen into their binding at publication.
    expect(
      await value(
        "select array_agg(role order by role) as v from public.academic_agent_behaviour_configs where programme_version_id in ($1,$2)",
        [published, enrolled],
      ),
    ).toEqual(["LAB_INSTRUCTOR", "PROFESSOR"]);
    await as(3);
    const foreignEnrolment = await value<string>(
      "select id as v from public.enrolments where cohort_id=$1",
      [cohortId],
    );
    expect(
      await value(
        "select public.get_agent_behaviour_for_enrolment($1,'PROFESSOR') as v",
        [foreignEnrolment],
      ),
    ).toEqual({
      ok: true,
      source: "DEFAULT",
      configVersion: "AGENT_BEHAVIOUR_DEFAULT_V1",
      behaviourVersion: "PROFESSOR_BEHAVIOUR_V1",
      config: {
        responseDepth: "STANDARD",
        teachingApproach: "CONCEPT_FIRST",
        understandingCheckFrequency: "STANDARD",
        challengeLevel: "STANDARD",
        courseContextNotes: null,
      },
      institutionalBaselineVersion: "DUCELIO_INSTITUTIONAL_BASELINE_V1",
    });
  });

  it("serialises configuration writes with publication and enrolment on the shared programme-version row lock", async () => {
    await owner();
    // The guard fires BEFORE every insert, update and delete.
    expect(
      (
        await f.db.query<{ event: string; timing: string }>(
          "select event_manipulation as event, action_timing as timing from information_schema.triggers where event_object_table='academic_agent_behaviour_configs' and trigger_name='guard_agent_behaviour_config' order by 1",
        )
      ).rows,
    ).toEqual([
      { event: "DELETE", timing: "BEFORE" },
      { event: "INSERT", timing: "BEFORE" },
      { event: "UPDATE", timing: "BEFORE" },
    ]);
    // It takes the programme_versions row lock (FOR UPDATE) BEFORE it
    // evaluates "bound"; enrolment takes FOR SHARE and publication FOR
    // UPDATE on the same row, so they cannot interleave with the check.
    const guard = await value<string>(
      "select pg_get_functiondef('agent_behaviour_private.guard_behaviour_config()'::regprocedure) as v",
    );
    const lock = guard.indexOf(
      "from public.programme_versions where id = NEW.programme_version_id for update",
    );
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(guard.indexOf("version_bound"));
    expect(
      await value<string>(
        "select pg_get_functiondef('public.guard_enrolment_history()'::regprocedure) as v",
      ),
    ).toMatch(
      /from public\.programme_versions\s+where id=NEW\.programme_version_id\s+for share/,
    );
    // Within one transaction the write really holds the version row lock.
    const version = await newDraft("AC-2 lock evidence");
    await as(2);
    await value(setSql, setArgs(version, "TUTOR"));
    await owner();
    expect(
      await value<boolean>(
        "select exists(select 1 from pg_locks l join pg_class c on c.oid=l.relation where c.relname='programme_versions' and l.mode='RowShareLock' and l.pid=pg_backend_pid()) as v",
      ),
    ).toBe(true);
  });

  it("fingerprints effective behaviour deterministically: a draft change changes it, binding freezes it", async () => {
    const version = await newDraft("AC-2 fingerprint");
    const other = await newDraft("AC-2 fingerprint twin");
    await as(2);
    const read = async (v: string) =>
      (
        await value<{
          behaviourFingerprint: string;
          fingerprintPolicy: string;
        }>("select public.admin_list_agent_behaviour_configs($1) as v", [v])
      ).behaviourFingerprint;
    const initial = await read(version);
    expect(initial).toMatch(/^[0-9a-f]{64}$/);
    expect(await read(version)).toBe(initial);
    // Bound to the version identity, not only to content.
    expect(await read(other)).not.toBe(initial);
    await value(setSql, setArgs(version, "PROFESSOR", "DETAILED"));
    const changed = await read(version);
    expect(changed).not.toBe(initial);
    await value(setSql, setArgs(version, "PROFESSOR", "CONCISE"));
    expect(await read(version)).not.toBe(changed);
    // Same semantic content again: same fingerprint (timestamps excluded).
    await value(setSql, setArgs(version, "PROFESSOR", "DETAILED"));
    expect(await read(version)).toBe(changed);
    expect(
      await value("select public.admin_list_agent_behaviour_configs($1) as v", [
        version,
      ]),
    ).toMatchObject({ fingerprintPolicy: "AGENT_BEHAVIOUR_FINGERPRINT_V1" });
    await publish(version);
    await as(2);
    await refused(
      setSql,
      setArgs(version, "PROFESSOR", "CONCISE"),
      "AGENT_BEHAVIOUR_CONFIG_FROZEN",
    );
    expect(await read(version)).toBe(changed);
  });

  it("gives the owning learner the frozen effective configuration, defaulting honestly, and isolates versions", async () => {
    await as(1);
    expect(
      await value(
        "select public.get_agent_behaviour_for_enrolment($1,'PROFESSOR') as v",
        [f.enrolmentId],
      ),
    ).toEqual({
      ok: true,
      source: "DEFAULT",
      configVersion: "AGENT_BEHAVIOUR_DEFAULT_V1",
      behaviourVersion: "PROFESSOR_BEHAVIOUR_V1",
      config: {
        responseDepth: "STANDARD",
        teachingApproach: "CONCEPT_FIRST",
        understandingCheckFrequency: "STANDARD",
        challengeLevel: "STANDARD",
        courseContextNotes: null,
      },
      institutionalBaselineVersion: "DUCELIO_INSTITUTIONAL_BASELINE_V1",
    });
    // A draft version's configuration never reaches learners enrolled on
    // another (historical, published) version.
    await as(2);
    await value(setSql, [
      draftVersion,
      "PROFESSOR",
      "DETAILED",
      "GUIDED_QUESTIONING",
      "HIGH",
      "ADVANCED",
      null,
      "Other version only",
    ]);
    await as(1);
    expect(
      await value(
        "select public.get_agent_behaviour_for_enrolment($1,'PROFESSOR') as v",
        [f.enrolmentId],
      ),
    ).toMatchObject({ source: "DEFAULT" });
    await as(3);
    expect(
      await value(
        "select public.get_agent_behaviour_for_enrolment($1,'PROFESSOR') as v",
        [f.enrolmentId],
      ),
    ).toEqual({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
    // An explicit draft row, frozen by publication, then enrolled.
    const version = await newDraft("AC-2 learner explicit read");
    await as(2);
    await value(setSql, [
      version,
      "TUTOR",
      "DETAILED",
      "WORKED_EXAMPLE_FIRST",
      "HIGH",
      "FOUNDATION",
      "Use plain English",
      "Explicit learner read",
    ]);
    await publish(version);
    const enrolment = await enrolForeignLearner(version);
    await as(3);
    expect(
      await value(
        "select public.get_agent_behaviour_for_enrolment($1,'TUTOR') as v",
        [enrolment],
      ),
    ).toEqual({
      ok: true,
      source: "EXPLICIT",
      configVersion: "AGENT_BEHAVIOUR_CONFIG_V1",
      behaviourVersion: "TUTOR_BEHAVIOUR_V1",
      config: {
        responseDepth: "DETAILED",
        teachingApproach: "WORKED_EXAMPLE_FIRST",
        understandingCheckFrequency: "HIGH",
        challengeLevel: "FOUNDATION",
        courseContextNotes: "Use plain English",
      },
      institutionalBaselineVersion: "DUCELIO_INSTITUTIONAL_BASELINE_V1",
    });
  });

  it("projects behaviour configuration into the /admin/agents scope read without note text", async () => {
    await as(2);
    await value(setSql, [
      draftVersion,
      "TUTOR",
      "STANDARD",
      "CONCEPT_FIRST",
      "STANDARD",
      "STANDARD",
      "Projection SENTINEL",
      "Scope projection",
    ]);
    const page = await value<{
      versions: { programmeVersionId: string; behaviourConfigs: unknown[] }[];
    }>("select public.admin_list_agent_configuration_scopes(null,null) as v");
    const draft = page.versions.find(
      (v) => v.programmeVersionId === draftVersion,
    )!;
    expect(draft.behaviourConfigs).toEqual([
      {
        role: "TUTOR",
        responseDepth: "STANDARD",
        teachingApproach: "CONCEPT_FIRST",
        understandingCheckFrequency: "STANDARD",
        challengeLevel: "STANDARD",
        hasCourseContextNotes: true,
      },
    ]);
    expect(JSON.stringify(page)).not.toContain("Projection SENTINEL");
  });
});

describe("authoritative classroom timing", () => {
  it("derives LIVE mode and timing from the database clock for the owning learner only", async () => {
    await as(1);
    const result = await value<{
      ok: boolean;
      state: { mode: string; serverNow: string; scheduledEnd: string };
    }>("select public.get_my_professor_classroom_state($1) as v", [
      classSession,
    ]);
    expect(result).toMatchObject({
      ok: true,
      state: { mode: "LIVE", lessonId: lesson, enrolmentId: f.enrolmentId },
    });
    const remaining =
      Date.parse(result.state.scheduledEnd) -
      Date.parse(result.state.serverNow);
    expect(remaining).toBeGreaterThan(45 * 60_000);
    expect(remaining).toBeLessThanOrEqual(50 * 60_000);
    expect(
      await value("select public.get_my_professor_classroom_state($1) as v", [
        pastClassSession,
      ]),
    ).toMatchObject({ ok: true, state: { mode: "CATCH_UP" } });
    await as(3);
    expect(
      await value("select public.get_my_professor_classroom_state($1) as v", [
        classSession,
      ]),
    ).toEqual({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
  });
});

describe("attested Professor execution provenance", () => {
  it("records database-verified provenance for the learner's own authorized execution", async () => {
    const e = await professorExecution();
    expect(await recordProvenance(validProvenance(e))).toEqual({ ok: true });
    await owner();
    expect(
      (
        await f.db.query(
          "select execution_kind,role,programme_version_id,enrolment_id,runtime_profile_ref,behaviour_version,behaviour_config_source,behaviour_config_version from public.academic_agent_execution_provenance where professor_execution_id=$1",
          [e.executionId],
        )
      ).rows[0],
    ).toEqual({
      execution_kind: "PROFESSOR_PROVIDER_V2",
      role: "PROFESSOR",
      programme_version_id: seededVersion,
      enrolment_id: f.enrolmentId,
      runtime_profile_ref: "PROFESSOR_COMMERCIAL_V1",
      behaviour_version: "PROFESSOR_BEHAVIOUR_V1",
      behaviour_config_source: "DEFAULT",
      behaviour_config_version: "AGENT_BEHAVIOUR_DEFAULT_V1",
    });
    expect(
      await value(
        "select behaviour_fingerprint = agent_behaviour_private.behaviour_fingerprint($2) as v from public.academic_agent_execution_provenance where professor_execution_id=$1",
        [e.executionId, seededVersion],
      ),
    ).toBe(true);
    // Every contributing content release, identifiers and capability only.
    expect(
      (
        await f.db.query(
          "select release_id,capability_name,position from public.academic_agent_execution_context_releases where professor_execution_id=$1 order by position",
          [e.executionId],
        )
      ).rows,
    ).toEqual([
      {
        release_id: e.releaseId,
        capability_name: "get_lesson_context",
        position: 1,
      },
      {
        release_id: e.objectivesReleaseId,
        capability_name: "get_lesson_objectives",
        position: 2,
      },
    ]);
    expect(
      (
        await f.db.query<{ column_name: string }>(
          "select column_name from information_schema.columns where table_schema='public' and table_name='academic_agent_execution_context_releases' order by column_name",
        )
      ).rows.map((r) => r.column_name),
    ).toEqual([
      "capability_name",
      "position",
      "professor_execution_id",
      "release_id",
    ]);
    await refused(
      "update public.academic_agent_execution_context_releases set position=3 where professor_execution_id=$1",
      [e.executionId],
      "AGENT_BEHAVIOUR_HISTORY_IMMUTABLE",
    );
  });

  it("binds the complete context-release manifest into the attestation and verifies every release", async () => {
    const e = await professorExecution();
    const outer: [string, string] = ["get_lesson_context", e.releaseId];
    const objectives: [string, string] = [
      "get_lesson_objectives",
      e.objectivesReleaseId,
    ];
    // Substituting the manifest after signing.
    const second = (await openRelease("get_lesson_objectives")).release_id;
    expect(
      await recordProvenance({
        ...validProvenance(e),
        manifest: [outer, ["get_lesson_objectives", second]],
        signedManifest: [outer, objectives],
      }),
    ).toEqual({ ok: false, code: "ATTESTATION_INVALID" });
    // Omitted objectives release.
    expect(
      await recordProvenance({ ...validProvenance(e), manifest: [outer] }),
    ).toEqual({ ok: false, code: "INVALID_INPUT" });
    // Wrong order, an outer release that is not the execution's own, and a
    // capability the configuration does not authorise.
    for (const manifest of [
      [objectives, outer],
      [
        ["get_lesson_context", e.objectivesReleaseId],
        ["get_lesson_objectives", e.releaseId],
      ],
      [outer, objectives, ["get_learning_resources", second]],
    ] as [string, string][][])
      expect(
        await recordProvenance({ ...validProvenance(e), manifest }),
      ).toEqual({ ok: false, code: "CONTEXT_MANIFEST_MISMATCH" });
    // A release whose own capability does not match its manifest slot.
    const anotherContext = (await openRelease("get_lesson_context")).release_id;
    expect(
      await recordProvenance({
        ...validProvenance(e),
        manifest: [outer, ["get_lesson_objectives", anotherContext]],
      }),
    ).toEqual({ ok: false, code: "CONTEXT_RELEASE_INVALID" });
    // A release of another learner.
    await as(3);
    const foreignRelease = (await openRelease("get_lesson_objectives"))
      .release_id;
    await as(1);
    expect(
      await recordProvenance({
        ...validProvenance(e),
        manifest: [outer, ["get_lesson_objectives", foreignRelease]],
      }),
    ).toEqual({ ok: false, code: "CONTEXT_RELEASE_INVALID" });
    // A release that is no longer inside its lifecycle.
    await f.db.query("select public.close_academic_content_release($1,true)", [
      second,
    ]);
    expect(
      await recordProvenance({
        ...validProvenance(e),
        manifest: [outer, ["get_lesson_objectives", second]],
      }),
    ).toEqual({ ok: false, code: "CONTEXT_RELEASE_INVALID" });
    expect(await recordProvenance(validProvenance(e))).toEqual({ ok: true });
  });

  it("requires resources and mastery releases exactly when the stored configuration authorises them", async () => {
    await withoutGuard(
      "guard_agent_config_semantic_binding",
      "public.academic_agent_configs",
      "update public.academic_agent_configs set capabilities=array['get_lesson_context','get_lesson_objectives','get_learning_resources','get_current_mastery_state'] where programme_version_id=$1 and role='PROFESSOR'",
      [seededVersion],
    );
    const e = await professorExecution();
    const resources = (await openRelease("get_learning_resources")).release_id;
    const mastery = (await openRelease("get_current_mastery_state")).release_id;
    const base: [string, string][] = [
      ["get_lesson_context", e.releaseId],
      ["get_lesson_objectives", e.objectivesReleaseId],
    ];
    for (const manifest of [
      base,
      [...base, ["get_learning_resources", resources]],
      [...base, ["get_current_mastery_state", mastery]],
    ] as [string, string][][])
      expect(
        await recordProvenance({ ...validProvenance(e), manifest }),
      ).toEqual({ ok: false, code: "CONTEXT_MANIFEST_MISMATCH" });
    expect(
      await recordProvenance({
        ...validProvenance(e),
        manifest: [
          ...base,
          ["get_learning_resources", resources],
          ["get_current_mastery_state", mastery],
        ],
      }),
    ).toEqual({ ok: true });
  });

  it("refuses a forged attestation, any mismatch with authoritative state, replay and a non-AUTHORIZED execution", async () => {
    const e = await professorExecution();
    await as(1);
    expect(
      await recordProvenance({ ...validProvenance(e), tamper: true }),
    ).toEqual({ ok: false, code: "ATTESTATION_INVALID" });
    for (const mismatch of [
      { ref: "TUTOR_COMMERCIAL_V1" },
      { ref: null },
      { behaviourVersion: "TUTOR_BEHAVIOUR_V1" },
      { configVersion: "AGENT_BEHAVIOUR_CONFIG_V1" },
    ])
      expect(
        await recordProvenance({ ...validProvenance(e), ...mismatch }),
      ).toEqual({ ok: false, code: "PROVENANCE_MISMATCH" });
    expect(await recordProvenance(validProvenance(e))).toEqual({ ok: true });
    expect(await recordProvenance(validProvenance(e))).toEqual({
      ok: false,
      code: "ALREADY_RECORDED",
    });
    // Provenance is recorded strictly before START: a started or finished
    // execution can never acquire provenance afterwards.
    await startAndSucceed(e.executionId, e.releaseId, e.objectivesReleaseId);
    await as(1);
    expect(await recordProvenance(validProvenance(e))).toEqual({
      ok: false,
      code: "INVALID_STATE",
    });
  });

  it("never lets another learner record provenance for an execution that is not theirs", async () => {
    const e = await professorExecution();
    await as(3);
    expect(
      await recordProvenance({ ...validProvenance(e), actor: foreignLearner }),
    ).toEqual({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
  });
});

describe("Professor classroom memory", () => {
  async function succeededTurnExecution() {
    const e = await professorExecution();
    expect(await recordProvenance(validProvenance(e))).toEqual({ ok: true });
    await startAndSucceed(e.executionId, e.releaseId, e.objectivesReleaseId);
    await as(1);
    return e;
  }

  it("stores only learner-visible text for a SUCCEEDED, provenance-bound execution, numbered per classroom", async () => {
    const first = await succeededTurnExecution();
    expect(
      await recordTurn({
        executionId: first.executionId,
        classSessionId: classSession,
        kind: "BEGIN_LESSON",
        learnerMessage: null,
        professorMessage: "Welcome. Today: access control.",
      }),
    ).toEqual({ ok: true, duplicate: false });
    const second = await succeededTurnExecution();
    expect(
      await recordTurn({
        executionId: second.executionId,
        classSessionId: classSession,
        kind: "LEARNER_QUESTION",
        learnerMessage: "Please use examples.",
        professorMessage: "Here is an example of least privilege.",
      }),
    ).toEqual({ ok: true, duplicate: false });
    expect(
      await value(
        "select public.list_my_professor_classroom_turns($1,10) as v",
        [classSession],
      ),
    ).toMatchObject({
      ok: true,
      totalTurns: 2,
      turns: [
        {
          turnNumber: 1,
          interactionKind: "BEGIN_LESSON",
          learnerMessage: null,
          professorMessage: "Welcome. Today: access control.",
        },
        {
          turnNumber: 2,
          interactionKind: "LEARNER_QUESTION",
          learnerMessage: "Please use examples.",
        },
      ],
    });
    // Replaying the same execution never creates a second turn.
    expect(
      await recordTurn({
        executionId: second.executionId,
        classSessionId: classSession,
        kind: "LEARNER_QUESTION",
        learnerMessage: "Please use examples.",
        professorMessage: "Here is an example of least privilege.",
      }),
    ).toEqual({ ok: true, duplicate: true });
  });

  it("reports a shown-but-unrecorded exchange as degraded continuity instead of silently forgetting it", async () => {
    const recorded = await succeededTurnExecution();
    await recordTurn({
      executionId: recorded.executionId,
      classSessionId: classSession,
      kind: "BEGIN_LESSON",
      learnerMessage: null,
      professorMessage: "Welcome.",
    });
    const list = () =>
      value("select public.list_my_professor_classroom_turns($1,10) as v", [
        classSession,
      ]);
    expect(await list()).toMatchObject({
      ok: true,
      totalTurns: 1,
      unrecordedExchanges: 0,
      capacity: 200,
      capacityReached: false,
    });
    // SUCCEEDED (shown to the learner) but its turn was never written.
    await succeededTurnExecution();
    expect(await list()).toMatchObject({
      totalTurns: 1,
      unrecordedExchanges: 1,
    });
    // A failed or merely authorized execution was never shown: not a gap.
    const authorizedOnly = await professorExecution();
    await recordProvenance(validProvenance(authorizedOnly));
    expect(await list()).toMatchObject({ unrecordedExchanges: 1 });
  });

  it("reaches an explicit capacity state at 200 turns and refuses a 201st", async () => {
    const e = await succeededTurnExecution();
    // Fixture-owner seeding of a classroom already at the bound: one turn
    // numbered 200 (numbering is contiguous, so the highest number is the
    // count) bound to a real SUCCEEDED, provenance-bound execution.
    await owner();
    const classroomId = await value<string>(
      "select id as v from public.professor_classroom_sessions where student_id=$1 and class_session_id=$2",
      [learner, classSession],
    );
    await f.db.query(
      "insert into public.professor_classroom_turns(classroom_id,student_id,execution_id,turn_number,interaction_kind,learner_message,professor_message) values($1,$2,$3,200,'BEGIN_LESSON',null,'Seeded')",
      [classroomId, learner, e.executionId],
    );
    await as(1);
    expect(
      await value(
        "select public.list_my_professor_classroom_turns($1,10) as v",
        [classSession],
      ),
    ).toMatchObject({ capacity: 200, capacityReached: true });
    const next = await succeededTurnExecution();
    expect(
      await recordTurn({
        executionId: next.executionId,
        classSessionId: classSession,
        kind: "LEARNER_QUESTION",
        learnerMessage: "One more?",
        professorMessage: "Answer",
      }),
    ).toEqual({ ok: false, code: "TURN_LIMIT_REACHED" });
  });

  it("refuses browser-forged history: tampered text, a non-SUCCEEDED execution and an execution not bound to this classroom", async () => {
    const e = await succeededTurnExecution();
    expect(
      await recordTurn({
        executionId: e.executionId,
        classSessionId: classSession,
        kind: "LEARNER_QUESTION",
        learnerMessage: "Hi",
        professorMessage: "Forged professor answer",
        signedProfessorMessage: "Genuine professor answer",
      }),
    ).toEqual({ ok: false, code: "ATTESTATION_INVALID" });
    expect(
      await recordTurn({
        executionId: e.executionId,
        classSessionId: pastClassSession,
        kind: "LEARNER_QUESTION",
        learnerMessage: "Hi",
        professorMessage: "Answer",
      }),
    ).toEqual({ ok: false, code: "CONTEXT_CONFLICT" });
    const authorizedOnly = await professorExecution();
    await recordProvenance(validProvenance(authorizedOnly));
    expect(
      await recordTurn({
        executionId: authorizedOnly.executionId,
        classSessionId: classSession,
        kind: "LEARNER_QUESTION",
        learnerMessage: "Hi",
        professorMessage: "Answer",
      }),
    ).toEqual({ ok: false, code: "INVALID_STATE" });
  });

  it("is readable only by the owning learner and never during a controlled assessment", async () => {
    const e = await succeededTurnExecution();
    await recordTurn({
      executionId: e.executionId,
      classSessionId: classSession,
      kind: "BEGIN_LESSON",
      learnerMessage: null,
      professorMessage: "Welcome.",
    });
    await as(3);
    expect(
      await value(
        "select public.list_my_professor_classroom_turns($1,10) as v",
        [classSession],
      ),
    ).toEqual({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
    await as(1);
    await f.db.query("select public.start_assessment_attempt($1)", [
      f.assessmentId,
    ]);
    expect(
      await value(
        "select public.list_my_professor_classroom_turns($1,10) as v",
        [classSession],
      ),
    ).toEqual({ ok: false, code: "ACTIVITY_BLOCKED" });
  });

  it("is non-authoritative: no psychological or assessment columns, immutable, and writes no institutional record", async () => {
    await owner();
    const columns = (
      await f.db.query<{ column_name: string }>(
        "select column_name from information_schema.columns where table_schema='public' and table_name='professor_classroom_turns' order by column_name",
      )
    ).rows.map((r) => r.column_name);
    expect(columns).toEqual([
      "classroom_id",
      "execution_id",
      "id",
      "interaction_kind",
      "learner_message",
      "professor_message",
      "recorded_at",
      "student_id",
      "turn_number",
    ]);
    const institutional = async () =>
      value<number>(
        "select (select count(*) from public.learning_evidence)+(select count(*) from public.objective_mastery)+(select count(*) from public.attendance_records)+(select count(*) from public.lesson_progress) as v",
      );
    const before = await institutional();
    const e = await succeededTurnExecution();
    await recordTurn({
      executionId: e.executionId,
      classSessionId: classSession,
      kind: "BEGIN_LESSON",
      learnerMessage: null,
      professorMessage: "Welcome.",
    });
    await owner();
    expect(await institutional()).toBe(before);
    await refused(
      "update public.professor_classroom_turns set professor_message='Rewritten'",
      [],
      "AGENT_BEHAVIOUR_HISTORY_IMMUTABLE",
    );
  });
});

describe("access control", () => {
  it("keeps the new tables RPC-only and the private schema closed", async () => {
    await owner();
    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const table of [
        "public.academic_agent_behaviour_configs",
        "public.academic_agent_execution_provenance",
        "public.academic_agent_execution_context_releases",
        "public.professor_classroom_turns",
      ])
        expect(
          await value(
            "select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE') as v",
            [role, table],
          ),
        ).toBe(false);
      expect(
        await value(
          "select has_schema_privilege($1,'agent_behaviour_private','USAGE') as v",
          [role],
        ),
      ).toBe(false);
    }
    for (const fn of [
      "public.record_professor_execution_provenance(uuid,uuid,uuid,uuid,text[],uuid[],text,text,text,text,bigint,bigint,text)",
      "public.record_professor_classroom_turn(uuid,uuid,uuid,text,text,text,bigint,bigint,text)",
      "public.list_my_professor_classroom_turns(uuid,integer)",
    ])
      for (const role of ["anon", "service_role"])
        expect(
          await value("select has_function_privilege($1,$2,'EXECUTE') as v", [
            role,
            fn,
          ]),
        ).toBe(false);
  });
});

// Historical default drift: the effective Level-3 behaviour and the pinned
// Level-2 role behaviour version are frozen into an immutable binding when a
// version is published; already-published versions are backfilled; bound
// runtime reads only the binding and fails closed when it is missing or
// does not verify.
describe("publication-time behaviour bindings", () => {
  type Binding = {
    role: string;
    behaviour_version: string;
    config_source: string;
    config_version: string;
    config_id: string | null;
    response_depth: string;
    teaching_approach: string;
    understanding_check_frequency: string;
    challenge_level: string;
    course_context_notes: string | null;
    bound_event: string;
    digest_ok: boolean;
  };
  async function bindings(version: string) {
    await owner();
    return (
      await f.db.query<Binding>(
        "select role,behaviour_version,config_source,config_version,config_id,response_depth,teaching_approach,understanding_check_frequency,challenge_level,course_context_notes,bound_event,semantic_digest = agent_behaviour_private.binding_digest(b) as digest_ok from public.academic_agent_behaviour_bindings b where programme_version_id=$1 order by role",
        [version],
      )
    ).rows;
  }
  const effective = (version: string, role: string) =>
    value<{ ok: boolean; code?: string; state?: string }>(
      "select agent_behaviour_private.effective_behaviour($1,$2) as v",
      [version, role],
    );
  const fingerprint = (version: string) =>
    value<string | null>(
      "select agent_behaviour_private.behaviour_fingerprint($1) as v",
      [version],
    );
  const learnerRead = async (enrolment: string, role: string, n = 1) => {
    await as(n);
    const result = await value<{ ok: boolean; code?: string }>(
      "select public.get_agent_behaviour_for_enrolment($1,$2) as v",
      [enrolment, role],
    );
    await owner();
    return result;
  };
  const v1Values = {
    response_depth: "STANDARD",
    teaching_approach: "CONCEPT_FIRST",
    understanding_check_frequency: "STANDARD",
    challenge_level: "STANDARD",
    course_context_notes: null,
  };
  const backfill = () => {
    const migration = readFileSync(
      resolve("supabase/migrations/202610050051_agent_behaviour.sql"),
      "utf8",
    );
    const section = migration.slice(migration.indexOf("-- 6. Backfill"));
    const start = section.indexOf("do $$");
    return section.slice(start, section.indexOf("end $$;", start) + 7);
  };

  it("freezes every role's actual effective values and pinned role version at publication, and nothing before", async () => {
    const version = await newDraft("AC-2 binding at publication");
    await as(2);
    const professorRow = await value<string>(setSql, [
      version,
      "PROFESSOR",
      "DETAILED",
      "GUIDED_QUESTIONING",
      "HIGH",
      "ADVANCED",
      "Binding notes",
      "Before publication",
    ]);
    expect(await bindings(version)).toEqual([]);
    expect(await effective(version, "TUTOR")).toMatchObject({
      ok: true,
      state: "DRAFT",
    });
    await publish(version);
    expect(await bindings(version)).toEqual([
      {
        role: "LAB_INSTRUCTOR",
        behaviour_version: "LAB_INSTRUCTOR_BEHAVIOUR_V1",
        config_source: "DEFAULT",
        config_version: "AGENT_BEHAVIOUR_DEFAULT_V1",
        config_id: null,
        ...v1Values,
        bound_event: "PUBLICATION",
        digest_ok: true,
      },
      {
        role: "PROFESSOR",
        behaviour_version: "PROFESSOR_BEHAVIOUR_V1",
        config_source: "EXPLICIT",
        config_version: "AGENT_BEHAVIOUR_CONFIG_V1",
        config_id: professorRow,
        response_depth: "DETAILED",
        teaching_approach: "GUIDED_QUESTIONING",
        understanding_check_frequency: "HIGH",
        challenge_level: "ADVANCED",
        course_context_notes: "Binding notes",
        bound_event: "PUBLICATION",
        digest_ok: true,
      },
      {
        role: "TUTOR",
        behaviour_version: "TUTOR_BEHAVIOUR_V1",
        config_source: "DEFAULT",
        config_version: "AGENT_BEHAVIOUR_DEFAULT_V1",
        config_id: null,
        ...v1Values,
        bound_event: "PUBLICATION",
        digest_ok: true,
      },
    ]);
    // A first enrolment does not rebind (idempotent), and the seeded,
    // already-published demo version is bound too.
    await enrolForeignLearner(version);
    expect((await bindings(version)).map((b) => b.bound_event)).toEqual([
      "PUBLICATION",
      "PUBLICATION",
      "PUBLICATION",
    ]);
    expect(await bindings(seededVersion)).toHaveLength(3);
    expect(await bindings(draftVersion)).toEqual([]);
  });

  it("keeps a bound version on its frozen default and pinned role version when the code default and role version move", async () => {
    const draft = await newDraft("AC-2 drift draft");
    const boundBefore = await fingerprint(seededVersion);
    const draftBefore = await fingerprint(draft);
    const readBefore = await learnerRead(f.enrolmentId, "PROFESSOR");
    // Simulate a later release: a new current default with different
    // values, and a new current PROFESSOR role behaviour version.
    await f.db.exec(`
      create or replace function agent_behaviour_private.default_config(p_config_version text) returns jsonb
      language sql immutable set search_path='' as $f$
        select case p_config_version
          when 'AGENT_BEHAVIOUR_DEFAULT_V1' then jsonb_build_object(
            'responseDepth', 'STANDARD', 'teachingApproach', 'CONCEPT_FIRST',
            'understandingCheckFrequency', 'STANDARD', 'challengeLevel', 'STANDARD',
            'courseContextNotes', null)
          when 'AGENT_BEHAVIOUR_DEFAULT_V2' then jsonb_build_object(
            'responseDepth', 'DETAILED', 'teachingApproach', 'GUIDED_QUESTIONING',
            'understandingCheckFrequency', 'HIGH', 'challengeLevel', 'ADVANCED',
            'courseContextNotes', null)
        end $f$;
      create or replace function agent_behaviour_private.current_default_version() returns text
      language sql immutable set search_path='' as $f$ select 'AGENT_BEHAVIOUR_DEFAULT_V2'::text $f$;
      create or replace function agent_behaviour_private.role_behaviour_version(p_role text) returns text
      language sql immutable set search_path='' as $f$
        select case p_role when 'PROFESSOR' then 'PROFESSOR_BEHAVIOUR_V2'
          when 'TUTOR' then 'TUTOR_BEHAVIOUR_V1' when 'LAB_INSTRUCTOR' then 'LAB_INSTRUCTOR_BEHAVIOUR_V1' end $f$;
    `);
    // Bound: unchanged values, pinned version, unchanged fingerprint.
    expect(await learnerRead(f.enrolmentId, "PROFESSOR")).toEqual(readBefore);
    expect(readBefore).toMatchObject({
      behaviourVersion: "PROFESSOR_BEHAVIOUR_V1",
      config: { responseDepth: "STANDARD" },
    });
    expect(await fingerprint(seededVersion)).toBe(boundBefore);
    // A later enrolment into the bound version neither rebinds nor fails.
    const bindingsBefore = await bindings(seededVersion);
    await enrolForeignLearner(seededVersion);
    expect(await bindings(seededVersion)).toEqual(bindingsBefore);
    // Draft: the fingerprint covers actual values, so it moves with the
    // live default and role version that publication would freeze.
    expect(await fingerprint(draft)).not.toBe(draftBefore);
    expect(await effective(draft, "PROFESSOR")).toMatchObject({
      state: "DRAFT",
      behaviourVersion: "PROFESSOR_BEHAVIOUR_V2",
      configVersion: "AGENT_BEHAVIOUR_DEFAULT_V2",
      config: { responseDepth: "DETAILED" },
    });
  });

  it("detects an in-place edit of a versioned default instead of silently applying it", async () => {
    const draft = await newDraft("AC-2 in-place default edit");
    const draftBefore = await fingerprint(draft);
    await f.db.exec(`
      create or replace function agent_behaviour_private.default_config(p_config_version text) returns jsonb
      language sql immutable set search_path='' as $f$
        select case p_config_version when 'AGENT_BEHAVIOUR_DEFAULT_V1' then jsonb_build_object(
          'responseDepth', 'CONCISE', 'teachingApproach', 'CONCEPT_FIRST',
          'understandingCheckFrequency', 'STANDARD', 'challengeLevel', 'STANDARD',
          'courseContextNotes', null) end $f$;
    `);
    expect(await effective(seededVersion, "TUTOR")).toEqual({
      ok: false,
      code: "BEHAVIOUR_BINDING_INVALID",
    });
    expect(await learnerRead(f.enrolmentId, "TUTOR")).toEqual({
      ok: false,
      code: "BEHAVIOUR_BINDING_INVALID",
    });
    expect(await fingerprint(seededVersion)).toBeNull();
    // The fingerprint is over actual values, not just the version name.
    expect(await fingerprint(draft)).not.toBe(draftBefore);
  });

  it("fails closed everywhere when a bound version's binding is missing", async () => {
    await withoutGuard(
      "guard_agent_behaviour_binding",
      "public.academic_agent_behaviour_bindings",
      "delete from public.academic_agent_behaviour_bindings where programme_version_id=$1 and role='PROFESSOR'",
      [seededVersion],
    );
    expect(await learnerRead(f.enrolmentId, "PROFESSOR")).toEqual({
      ok: false,
      code: "BEHAVIOUR_BINDING_MISSING",
    });
    // Other roles of the same version still verify individually.
    expect(await learnerRead(f.enrolmentId, "TUTOR")).toMatchObject({
      ok: true,
    });
    expect(await fingerprint(seededVersion)).toBeNull();
    // Never a fallback to the current default.
    expect(await effective(seededVersion, "PROFESSOR")).toEqual({
      ok: false,
      code: "BEHAVIOUR_BINDING_MISSING",
    });
    await as(2);
    const listed = await value<{
      behaviourFingerprint: string | null;
      effective: { role: string; state: string }[];
    }>("select public.admin_list_agent_behaviour_configs($1) as v", [
      seededVersion,
    ]);
    expect(listed.behaviourFingerprint).toBeNull();
    expect(listed.effective.find((e) => e.role === "PROFESSOR")).toEqual({
      role: "PROFESSOR",
      state: "BEHAVIOUR_BINDING_MISSING",
    });
    // Professor provenance (and therefore START) is refused.
    const e = await professorExecution();
    expect(await recordProvenance(validProvenance(e))).toEqual({
      ok: false,
      code: "BEHAVIOUR_BINDING_INVALID",
    });
  });

  it("fails closed when a binding, its digest, or its frozen source is corrupted", async () => {
    const corruptions: [string, string, string, string][] = [
      // [trigger, table, sql, role]
      [
        "guard_agent_behaviour_binding",
        "public.academic_agent_behaviour_bindings",
        "update public.academic_agent_behaviour_bindings set response_depth='DETAILED' where programme_version_id=$1 and role='PROFESSOR'",
        "PROFESSOR",
      ],
      [
        "guard_agent_behaviour_binding",
        "public.academic_agent_behaviour_bindings",
        "update public.academic_agent_behaviour_bindings set semantic_digest=repeat('a',64) where programme_version_id=$1 and role='TUTOR'",
        "TUTOR",
      ],
      [
        "guard_agent_behaviour_config",
        "public.academic_agent_behaviour_configs",
        "insert into public.academic_agent_behaviour_configs(programme_version_id,role,response_depth,teaching_approach,understanding_check_frequency,challenge_level,created_by) values($1,'LAB_INSTRUCTOR','DETAILED','CONCEPT_FIRST','STANDARD','STANDARD','" +
          administrator +
          "')",
        "LAB_INSTRUCTOR",
      ],
    ];
    for (const [trigger, table, sql, role] of corruptions) {
      await f.db.exec("savepoint corruption");
      await withoutGuard(trigger, table, sql, [seededVersion]);
      expect(await learnerRead(f.enrolmentId, role)).toEqual({
        ok: false,
        code: "BEHAVIOUR_BINDING_INVALID",
      });
      expect(await fingerprint(seededVersion)).toBeNull();
      await f.db.exec("rollback to savepoint corruption");
    }
    // An explicit binding whose underlying frozen row was altered.
    const version = await newDraft("AC-2 corrupted explicit source");
    await as(2);
    const row = await value<string>(setSql, setArgs(version, "TUTOR"));
    await publish(version);
    const enrolment = await enrolForeignLearner(version);
    expect(await learnerRead(enrolment, "TUTOR", 3)).toMatchObject({
      ok: true,
      source: "EXPLICIT",
    });
    await withoutGuard(
      "guard_agent_behaviour_config",
      "public.academic_agent_behaviour_configs",
      "update public.academic_agent_behaviour_configs set challenge_level='ADVANCED' where id=$1",
      [row],
    );
    expect(await learnerRead(enrolment, "TUTOR", 3)).toEqual({
      ok: false,
      code: "BEHAVIOUR_BINDING_INVALID",
    });
  });

  it("makes bindings immutable, bound-only, exact, and unreadable to every client role", async () => {
    await owner();
    await refused(
      "update public.academic_agent_behaviour_bindings set response_depth='CONCISE' where programme_version_id=$1",
      [seededVersion],
      "AGENT_BEHAVIOUR_BINDING_IMMUTABLE",
    );
    await refused(
      "delete from public.academic_agent_behaviour_bindings where programme_version_id=$1",
      [seededVersion],
      "AGENT_BEHAVIOUR_BINDING_IMMUTABLE",
    );
    const insert =
      "insert into public.academic_agent_behaviour_bindings(programme_version_id,role,behaviour_version,config_source,config_version,response_depth,teaching_approach,understanding_check_frequency,challenge_level,bound_event,semantic_digest) values($1,'TUTOR','TUTOR_BEHAVIOUR_V1','DEFAULT','AGENT_BEHAVIOUR_DEFAULT_V1',$2,'CONCEPT_FIRST','STANDARD','STANDARD','PUBLICATION',repeat('0',64))";
    await refused(
      insert,
      [draftVersion, "STANDARD"],
      "AGENT_BEHAVIOUR_BINDING_NOT_BOUND",
    );
    // A bound version missing a binding can only be rebound with exactly
    // its effective values, never with chosen ones.
    await withoutGuard(
      "guard_agent_behaviour_binding",
      "public.academic_agent_behaviour_bindings",
      "delete from public.academic_agent_behaviour_bindings where programme_version_id=$1 and role='TUTOR'",
      [seededVersion],
    );
    await refused(
      insert,
      [seededVersion, "DETAILED"],
      "AGENT_BEHAVIOUR_BINDING_MISMATCH",
    );
    for (const role of ["anon", "authenticated", "service_role"])
      expect(
        await value(
          "select has_table_privilege($1,'public.academic_agent_behaviour_bindings','SELECT,INSERT,UPDATE,DELETE') as v",
          [role],
        ),
      ).toBe(false);
  });

  it("backfills every already-bound version exactly once, idempotently, and never a draft", async () => {
    await withoutGuard(
      "guard_agent_behaviour_binding",
      "public.academic_agent_behaviour_bindings",
      "delete from public.academic_agent_behaviour_bindings where programme_version_id=$1",
      [seededVersion],
    );
    expect(await learnerRead(f.enrolmentId, "PROFESSOR")).toEqual({
      ok: false,
      code: "BEHAVIOUR_BINDING_MISSING",
    });
    const fingerprintBefore = await fingerprint(seededVersion);
    expect(fingerprintBefore).toBeNull();
    const sql = backfill();
    expect(sql).toMatch(/version_bound\(pv\.id\) order by pv\.id for update/);
    await f.db.exec(sql);
    const after = await bindings(seededVersion);
    expect(after).toHaveLength(3);
    for (const b of after)
      expect(b).toMatchObject({
        behaviour_version: `${b.role}_BEHAVIOUR_V1`,
        config_source: "DEFAULT",
        config_version: "AGENT_BEHAVIOUR_DEFAULT_V1",
        ...v1Values,
        bound_event: "MIGRATION_BACKFILL",
        digest_ok: true,
      });
    expect(await learnerRead(f.enrolmentId, "PROFESSOR")).toMatchObject({
      ok: true,
      source: "DEFAULT",
      behaviourVersion: "PROFESSOR_BEHAVIOUR_V1",
    });
    const fingerprintAfter = await fingerprint(seededVersion);
    expect(fingerprintAfter).toMatch(/^[0-9a-f]{64}$/);
    // Idempotent: a second run changes nothing.
    await f.db.exec(sql);
    expect(await bindings(seededVersion)).toEqual(after);
    expect(await fingerprint(seededVersion)).toBe(fingerprintAfter);
    expect(await bindings(draftVersion)).toEqual([]);
  });

  it("fingerprints identical semantics identically across draft and bound, and covers the pinned role version", async () => {
    const version = await newDraft("AC-2 fingerprint across publication");
    await as(2);
    await value(setSql, setArgs(version, "LAB_INSTRUCTOR", "CONCISE"));
    await owner();
    const draft = await fingerprint(version);
    await publish(version);
    // Publication freezes exactly the live semantics: same fingerprint.
    expect(await fingerprint(version)).toBe(draft);
    // The canonical material includes the actual default values: a version
    // whose explicit row equals the default values still differs from a
    // DEFAULT-sourced one (source is semantic), and both are content-bound.
    const a = await newDraft("AC-2 fp default");
    const b = await newDraft("AC-2 fp explicit-equal");
    await as(2);
    await value(setSql, setArgs(b, "TUTOR"));
    await owner();
    const material = (v: string) =>
      value<string>(
        "select jsonb_agg(agent_behaviour_private.effective_behaviour($1, r) - 'ok' - 'state' - 'configId' order by r)::text as v from unnest(array['LAB_INSTRUCTOR','PROFESSOR','TUTOR']) r",
        [v],
      );
    expect(await material(a)).toContain('"responseDepth": "STANDARD"');
    expect(await material(a)).toContain(
      '"behaviourVersion": "TUTOR_BEHAVIOUR_V1"',
    );
    expect(await fingerprint(a)).not.toBe(await fingerprint(b));
  });

  it("records Professor provenance against the PINNED role version, refusing the moved current version", async () => {
    await f.db.exec(`
      create or replace function agent_behaviour_private.role_behaviour_version(p_role text) returns text
      language sql immutable set search_path='' as $f$
        select case p_role when 'PROFESSOR' then 'PROFESSOR_BEHAVIOUR_V2'
          when 'TUTOR' then 'TUTOR_BEHAVIOUR_V1' when 'LAB_INSTRUCTOR' then 'LAB_INSTRUCTOR_BEHAVIOUR_V1' end $f$;
    `);
    const pinned = await professorExecution();
    expect(
      await recordProvenance({
        ...validProvenance(pinned),
        behaviourVersion: "PROFESSOR_BEHAVIOUR_V2",
      }),
    ).toEqual({ ok: false, code: "PROVENANCE_MISMATCH" });
    expect(await recordProvenance(validProvenance(pinned))).toEqual({
      ok: true,
    });
    await owner();
    expect(
      (
        await f.db.query(
          "select behaviour_version, behaviour_config_version, behaviour_fingerprint = agent_behaviour_private.behaviour_fingerprint($2) as fp from public.academic_agent_execution_provenance where professor_execution_id=$1",
          [pinned.executionId, seededVersion],
        )
      ).rows[0],
    ).toEqual({
      behaviour_version: "PROFESSOR_BEHAVIOUR_V1",
      behaviour_config_version: "AGENT_BEHAVIOUR_DEFAULT_V1",
      fp: true,
    });
  });
});

// Publication is the only normal materialisation boundary; enrolment only
// VERIFIES frozen behaviour and never creates, recreates or repairs it.
describe("enrolment verifies frozen behaviour and never repairs it", () => {
  const roles = ["LAB_INSTRUCTOR", "PROFESSOR", "TUTOR"] as const;
  const enrolSql =
    "insert into public.enrolments(student_id,cohort_id,programme_version_id) values($1,$2,$3)";
  async function rows(version: string) {
    await owner();
    return (
      await f.db.query<{ v: Record<string, unknown> }>(
        "select to_jsonb(b) as v from public.academic_agent_behaviour_bindings b where programme_version_id=$1 order by role",
        [version],
      )
    ).rows.map((r) => r.v);
  }
  const totalBindings = () =>
    value<number>(
      "select count(*)::int as v from public.academic_agent_behaviour_bindings",
    );
  const fingerprint = (version: string) =>
    value<string | null>(
      "select agent_behaviour_private.behaviour_fingerprint($1) as v",
      [version],
    );
  async function publishedVersion(label: string) {
    const version = await newDraft(label);
    await publish(version);
    await owner();
    const cohortId = await value<string>(
      "insert into public.cohorts(programme_version_id,title,starts_on) values($1,'Verify cohort','2026-09-01') returning id as v",
      [version],
    );
    return { version, cohortId };
  }
  const enrolments = (version: string) =>
    value<number>(
      "select count(*)::int as v from public.enrolments where programme_version_id=$1",
      [version],
    );
  async function withoutBindingGuard(sql: string, args: unknown[]) {
    await withoutGuard(
      "guard_agent_behaviour_binding",
      "public.academic_agent_behaviour_bindings",
      sql,
      args,
    );
  }

  it("A: a valid published version enrols without touching any binding", async () => {
    const { version, cohortId } = await publishedVersion("AC-2 verify A");
    const before = await rows(version);
    expect(before).toHaveLength(3);
    const total = await totalBindings();
    const fp = await fingerprint(version);
    await f.db.query(enrolSql, [foreignLearner, cohortId, version]);
    // Byte-identical rows: digest, source, values, bound_event and bound_at.
    expect(await rows(version)).toEqual(before);
    expect(await totalBindings()).toBe(total);
    expect(await fingerprint(version)).toBe(fp);
    expect(await enrolments(version)).toBe(1);
  });

  for (const [label, role] of [
    ["B", "PROFESSOR"],
    ["C", "TUTOR"],
    ["D", "LAB_INSTRUCTOR"],
  ] as const)
    it(`${label}: a missing ${role} binding refuses enrolment and inserts nothing`, async () => {
      const { version, cohortId } = await publishedVersion(
        `AC-2 verify ${label}`,
      );
      await withoutBindingGuard(
        "delete from public.academic_agent_behaviour_bindings where programme_version_id=$1 and role=$2",
        [version, role],
      );
      const before = await rows(version);
      const total = await totalBindings();
      await refused(
        enrolSql,
        [foreignLearner, cohortId, version],
        `AGENT_BEHAVIOUR_BINDING_MISSING: ${role} behaviour binding`,
      );
      expect(await rows(version)).toEqual(before);
      expect(await totalBindings()).toBe(total);
      expect(before.map((b) => b.role)).not.toContain(role);
      expect(await enrolments(version)).toBe(0);
    });

  it("E: a corrupt digest refuses enrolment and the row is not repaired", async () => {
    const { version, cohortId } = await publishedVersion("AC-2 verify E");
    await withoutBindingGuard(
      "update public.academic_agent_behaviour_bindings set semantic_digest=repeat('c',64) where programme_version_id=$1 and role='TUTOR'",
      [version],
    );
    const before = await rows(version);
    await refused(
      enrolSql,
      [foreignLearner, cohortId, version],
      "AGENT_BEHAVIOUR_BINDING_INVALID: TUTOR behaviour binding",
    );
    expect(await rows(version)).toEqual(before);
    expect(
      await value(
        "select semantic_digest as v from public.academic_agent_behaviour_bindings where programme_version_id=$1 and role='TUTOR'",
        [version],
      ),
    ).toBe("c".repeat(64));
    expect(await enrolments(version)).toBe(0);
  });

  it("F: an unrecognised pinned role-baseline or config version refuses enrolment and is not rewritten", async () => {
    // Remove the CHECKs inside this rolled-back transaction so a row with a
    // well-formed digest but an unrecognised version can exist at all.
    await owner();
    await f.db.exec(`do $$ declare c text; begin
      for c in select conname from pg_constraint
        where conrelid = 'public.academic_agent_behaviour_bindings'::regclass and contype = 'c'
          and (pg_get_constraintdef(oid) like '%behaviour_version%' or pg_get_constraintdef(oid) like '%config_version%') loop
        execute format('alter table public.academic_agent_behaviour_bindings drop constraint %I', c);
      end loop; end $$`);
    for (const [role, column, unrecognised] of [
      ["PROFESSOR", "behaviour_version", "PROFESSOR_BEHAVIOUR_V9"],
      ["LAB_INSTRUCTOR", "config_version", "AGENT_BEHAVIOUR_DEFAULT_V9"],
    ] as const) {
      const { version, cohortId } = await publishedVersion(
        `AC-2 verify F ${role}`,
      );
      // Rewrite the version and give it a VALID digest over the new row, so
      // only recognition can refuse it.
      await withoutBindingGuard(
        `update public.academic_agent_behaviour_bindings set ${column}=$2 where programme_version_id=$1 and role='${role}'`,
        [version, unrecognised],
      );
      await withoutBindingGuard(
        `update public.academic_agent_behaviour_bindings b set semantic_digest=agent_behaviour_private.binding_digest(b) where programme_version_id=$1 and role='${role}'`,
        [version],
      );
      expect(
        await value(
          "select semantic_digest = agent_behaviour_private.binding_digest(b) as v from public.academic_agent_behaviour_bindings b where programme_version_id=$1 and role=$2",
          [version, role],
        ),
      ).toBe(true);
      const before = await rows(version);
      await refused(
        enrolSql,
        [foreignLearner, cohortId, version],
        `AGENT_BEHAVIOUR_BINDING_INVALID: ${role} behaviour binding`,
      );
      expect(await rows(version)).toEqual(before);
      expect(
        await value(
          `select ${column} as v from public.academic_agent_behaviour_bindings where programme_version_id=$1 and role=$2`,
          [version, role],
        ),
      ).toBe(unrecognised);
      expect(await enrolments(version)).toBe(0);
    }
  });

  it("G: after a simulated later default / V2 deployment, enrolment leaves an old V1 binding completely unchanged", async () => {
    const { version, cohortId } = await publishedVersion("AC-2 verify G");
    const before = await rows(version);
    const fp = await fingerprint(version);
    await f.db.exec(`
      create or replace function agent_behaviour_private.default_config(p_config_version text) returns jsonb
      language sql immutable set search_path='' as $f$
        select case p_config_version
          when 'AGENT_BEHAVIOUR_DEFAULT_V1' then jsonb_build_object(
            'responseDepth', 'STANDARD', 'teachingApproach', 'CONCEPT_FIRST',
            'understandingCheckFrequency', 'STANDARD', 'challengeLevel', 'STANDARD',
            'courseContextNotes', null)
          when 'AGENT_BEHAVIOUR_DEFAULT_V2' then jsonb_build_object(
            'responseDepth', 'DETAILED', 'teachingApproach', 'GUIDED_QUESTIONING',
            'understandingCheckFrequency', 'HIGH', 'challengeLevel', 'ADVANCED',
            'courseContextNotes', null)
        end $f$;
      create or replace function agent_behaviour_private.current_default_version() returns text
      language sql immutable set search_path='' as $f$ select 'AGENT_BEHAVIOUR_DEFAULT_V2'::text $f$;
      create or replace function agent_behaviour_private.role_behaviour_version(p_role text) returns text
      language sql immutable set search_path='' as $f$
        select case p_role when 'PROFESSOR' then 'PROFESSOR_BEHAVIOUR_V2'
          when 'TUTOR' then 'TUTOR_BEHAVIOUR_V2' when 'LAB_INSTRUCTOR' then 'LAB_INSTRUCTOR_BEHAVIOUR_V2' end $f$;
    `);
    await f.db.query(enrolSql, [foreignLearner, cohortId, version]);
    const after = await rows(version);
    expect(after).toEqual(before);
    for (const b of after)
      expect(b).toMatchObject({
        behaviour_version: `${String(b.role)}_BEHAVIOUR_V1`,
        config_version: "AGENT_BEHAVIOUR_DEFAULT_V1",
        response_depth: "STANDARD",
        bound_event: "PUBLICATION",
      });
    expect(await fingerprint(version)).toBe(fp);
  });

  it("H: publication of a draft with no explicit configuration creates every required binding before any enrolment can occur", async () => {
    const version = await newDraft("AC-2 verify H");
    await owner();
    expect(await rows(version)).toEqual([]);
    expect(await enrolments(version)).toBe(0);
    await publish(version);
    const bound = await rows(version);
    expect(bound.map((b) => b.role)).toEqual([...roles]);
    for (const b of bound)
      expect(b).toMatchObject({
        config_source: "DEFAULT",
        config_version: "AGENT_BEHAVIOUR_DEFAULT_V1",
        config_id: null,
        response_depth: "STANDARD",
        teaching_approach: "CONCEPT_FIRST",
        understanding_check_frequency: "STANDARD",
        challenge_level: "STANDARD",
        course_context_notes: null,
        bound_event: "PUBLICATION",
      });
    expect(await enrolments(version)).toBe(0);
    await expect(
      f.db.query("select agent_behaviour_private.require_frozen_bindings($1)", [
        version,
      ]),
    ).resolves.toBeDefined();
  });

  it("publication cannot commit unless all three bindings exist and verify", async () => {
    const version = await newDraft("AC-2 publication completeness");
    await owner();
    // Simulate a defective materialiser that freezes nothing.
    await f.db
      .exec(`create or replace function agent_behaviour_private.bind_version(p_programme_version_id uuid, p_event text) returns void
      language plpgsql security definer set search_path='' as $f$ begin return; end $f$`);
    await f.db.exec("savepoint unpublished");
    await expect(publish(version)).rejects.toThrow(
      "AGENT_BEHAVIOUR_BINDING_MISSING: PROFESSOR behaviour binding",
    );
    await f.db.exec("rollback to savepoint unpublished");
    expect(
      await value(
        "select status as v from public.programme_versions where id=$1",
        [version],
      ),
    ).toBe("DRAFT");
    expect(await rows(version)).toEqual([]);
  });

  it("no enrolment trigger materialises behaviour, and only publication and the migration backfill call the materialiser", async () => {
    await owner();
    const triggers = (
      await f.db.query<{ name: string; fn: string; timing: string }>(
        "select t.tgname as name, p.proname as fn, case when t.tgtype & 2 = 2 then 'BEFORE' else 'AFTER' end as timing from pg_trigger t join pg_proc p on p.oid = t.tgfoid where t.tgrelid = 'public.enrolments'::regclass and not t.tgisinternal and p.pronamespace = 'agent_behaviour_private'::regnamespace",
      )
    ).rows;
    expect(triggers).toEqual([
      {
        name: "verify_agent_behaviour_on_enrolment",
        fn: "verify_on_enrolment",
        timing: "BEFORE",
      },
    ]);
    const callers = (
      await f.db.query<{ name: string }>(
        "select p.proname as name from pg_proc p where p.prosrc like '%bind_version(%' and p.proname <> 'bind_version' order by 1",
      )
    ).rows.map((r) => r.name);
    expect(callers).toEqual(["bind_on_publication"]);
    expect(
      await value<string>(
        "select pg_get_functiondef('agent_behaviour_private.verify_on_enrolment()'::regprocedure) as v",
      ),
    ).not.toMatch(/insert|update|bind_version|binding_digest/i);
    expect(
      await value<boolean>(
        "select pg_get_constraintdef(oid) like '%ENROLMENT%' as v from pg_constraint where conrelid='public.academic_agent_behaviour_bindings'::regclass and pg_get_constraintdef(oid) like '%bound_event%'",
      ),
    ).toBe(false);
  });
});

describe("institutional baseline provenance", () => {
  it("records the applied Level-1 baseline on Professor provenance and refuses any other claim", async () => {
    const e = await professorExecution();
    expect(
      await recordProvenance({
        ...validProvenance(e),
        institutionalBaselineVersion: "DUCELIO_INSTITUTIONAL_BASELINE_V2",
      }),
    ).toEqual({ ok: false, code: "PROVENANCE_MISMATCH" });
    expect(await recordProvenance(validProvenance(e))).toEqual({ ok: true });
    await owner();
    const row = (
      await f.db.query<{ v: Record<string, unknown> }>(
        "select to_jsonb(p) as v from public.academic_agent_execution_provenance p where professor_execution_id=$1",
        [e.executionId],
      )
    ).rows[0].v;
    expect(row).toMatchObject({
      programme_version_id: seededVersion,
      runtime_profile_ref: "PROFESSOR_COMMERCIAL_V1",
      institutional_baseline_version: "DUCELIO_INSTITUTIONAL_BASELINE_V1",
      behaviour_version: "PROFESSOR_BEHAVIOUR_V1",
      behaviour_config_source: "DEFAULT",
      behaviour_config_version: "AGENT_BEHAVIOUR_DEFAULT_V1",
    });
    expect(row.behaviour_fingerprint).toBe(
      await value(
        "select agent_behaviour_private.behaviour_fingerprint($1) as v",
        [seededVersion],
      ),
    );
    // Versions only: no institutional rule text, prompt or payload.
    expect(JSON.stringify(row)).not.toMatch(
      /Ducelio's deterministic backend|LEVEL 1/,
    );
  });

  it("the attested baseline is part of the MAC: a signed claim cannot be swapped", async () => {
    const e = await professorExecution();
    // Sign V1 but submit nothing else changed except the claim: the MAC
    // over the canonical message no longer matches.
    const { issuedAt, expiresAt } = window();
    const canonical = [
      "DUCELIO_AGENT_PROVENANCE_HMAC_SHA256_V1",
      "PROFESSOR",
      f.keyId,
      learner,
      e.executionId,
      e.releaseId,
      classSession,
      `get_lesson_context:${e.releaseId},get_lesson_objectives:${e.objectivesReleaseId}`,
      "PROFESSOR_COMMERCIAL_V1",
      "DUCELIO_INSTITUTIONAL_BASELINE_V1",
      "PROFESSOR_BEHAVIOUR_V1",
      "AGENT_BEHAVIOUR_DEFAULT_V1",
      String(issuedAt),
      String(expiresAt),
    ].join("\n");
    expect(
      await value(
        "select public.record_professor_execution_provenance($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) as v",
        [
          f.keyId,
          e.executionId,
          e.releaseId,
          classSession,
          ["get_lesson_context", "get_lesson_objectives"],
          [e.releaseId, e.objectivesReleaseId],
          "PROFESSOR_COMMERCIAL_V1",
          "DUCELIO_INSTITUTIONAL_BASELINE_V2",
          "PROFESSOR_BEHAVIOUR_V1",
          "AGENT_BEHAVIOUR_DEFAULT_V1",
          issuedAt,
          expiresAt,
          mac(canonical),
        ],
      ),
    ).toEqual({ ok: false, code: "ATTESTATION_INVALID" });
  });

  it("gives the learner read the database's applied baseline so the server can refuse a mismatch", async () => {
    await as(1);
    expect(
      await value(
        "select public.get_agent_behaviour_for_enrolment($1,'TUTOR') as v",
        [f.enrolmentId],
      ),
    ).toMatchObject({
      ok: true,
      institutionalBaselineVersion: "DUCELIO_INSTITUTIONAL_BASELINE_V1",
    });
  });
});
