# AC-2: Governed Academic Agent Behaviour

AC-2 is the second checkpoint of the Agent / Model control and Governed Academic Agent Behaviour workstream (see [AC-1](43-agent-control-1.md)). Branch `feat/agent-behaviour`, base `3099e7206a30149650ca401abcc13d0ea345fecf` (AC-1 merged through PR #54). Migration `202610050051_agent_behaviour.sql`.

AC-2 is **not production-ready**. It is implemented and locally tested, and has passed independent review after the correction passes in sections 12–14. It was merged to `main` through PR #55 (merge `7a7d5b8842f9c8fb3c39df8aefb0df708a14dc5c`). Its successor is [AC-3](45-agent-behaviour-ac3.md). It does **not** implement Sarah, academic handoffs, Professor → Sarah weak-area delivery, teaching feedback, Tutor class notes, Lab session timing, or any use of an instructional estimate as mastery.

## 1. Architecture decision

Professor teaching context must come from the existing reviewed content-release boundary (migration 021, `PROFESSOR_READ_V2`). Each release is per invocation, per capability, firewall-checked and closed by its gateway. Three options were considered:

- **A. Widen the output of `get_lesson_context`.** Rejected: it changes a reviewed capability contract.
- **B. Add a composite capability.** Rejected: it needs changes to 021's CHECK/allowlist, and AC-1's published-configuration freeze cannot widen published capability sets.
- **C. Nested reviewed releases (chosen).** Each existing capability the Professor needs is opened through the existing gateway (`withValidatedProfessorContent`). The gateways are nested, so the provider runs while every release is ACTIVE:
  - `get_lesson_context` (outermost);
  - `get_lesson_objectives`;
  - `get_learning_resources` and `get_current_mastery_state`, only when the programme version's stored configuration authorises them.

  Every gateway performs its own final principal and activity recheck and closes its release. Output is discarded if any recheck fails. The V2 provider execution is attested against the outermost release exactly as before.

There is no new database read path, no service role and no unrestricted Supabase read in the provider runtime.

## 2. Behaviour contract (levels 1–5)

The instruction text a provider receives is composed only from code-owned sentences (`src/domain/agent-behaviour.ts`, `composeAgentInstructions`). It is keyed by **role**, never by model or provider.

| Level | Owner             | Content                                                                                                                                                                                                       |
| ----- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Code              | `DUCELIO_INSTITUTIONAL_BASELINE_V1`: ten institutional rules (data is not authority, no record changes, no hidden reasoning or secrets, protected-assessment firewall, no invented official exam content, …). |
| 2     | Code              | `PROFESSOR_BEHAVIOUR_V1`, `TUTOR_BEHAVIOUR_V1`, `LAB_INSTRUCTOR_BEHAVIOUR_V1`: mission and rules per role. The provider is told explicitly "You are executing as the Ducelio {ROLE}".                         |
| 3     | Programme version | `AGENT_BEHAVIOUR_CONFIG_V1`: `responseDepth`, `teachingApproach`, `understandingCheckFrequency`, `challengeLevel`. Each value maps to one fixed, reviewed sentence.                                           |
| 4     | Server            | Runtime facts (lesson, objectives, timing, mastery, resources, memory), supplied only as input data.                                                                                                          |
| 5     | Learner           | Learner message, supplied only as input data.                                                                                                                                                                 |

Precedence is 1 > 2 > 3 > 4 > 5 and is stated in the instructions. `courseContextNotes` (bounded, at most 2,000 characters) **never** enter the instructions. They are rendered in the input as `programmeContextNotes`, with authority `PROGRAMME_AUTHORED_SUBORDINATE_DATA`, and the instructions say they are subordinate data.

The Examiner's grading instructions are byte-for-byte unchanged (pinned in `tests/agent-behaviour-provider-instructions.test.ts`). The academic COUNSELLOR remains non-executable and receives no behaviour contract.

## 3. Level-3 configuration authority

- Table `academic_agent_behaviour_configs`. It is separate from `academic_agent_configs`, so COURSE_PACKAGE_V1, the 035 publication fingerprint, 027 activation matching and the AC-1 freeze rules are unchanged. There is at most one row per (programme version, role), for PROFESSOR, TUTOR and LAB_INSTRUCTOR only.
- **Authoring.** Rows are written only through `admin_set_agent_behaviour_config`, by ACADEMIC_ADMIN or PLATFORM_ADMIN, with a reason. Input is enum-checked and the notes are bounded.
  - Once the version is PUBLISHED or has any enrolment (`agent_config_governance_private.version_bound`), every insert and update is refused with `AGENT_BEHAVIOUR_CONFIG_FROZEN`. A **first** insert is refused exactly like an update, whether through the RPC or a direct owner write, so historical behaviour can never be changed by adding a row after publication.
  - The BEFORE INSERT/UPDATE/DELETE guard takes the `programme_versions` row lock (`FOR UPDATE`) before it evaluates "bound". Publication takes `FOR UPDATE` and enrolment `FOR SHARE` on the same row (migrations 035 and 007), so a configuration write cannot interleave with a publication or first enrolment of that version.
  - Rows can never be deleted (`AGENT_BEHAVIOUR_CONFIG_HISTORY`).
  - Identity columns are immutable.
- **Audit.** Every change is audited with the changed field names only. The note text is never written to the audit payload.
- **No row.** A **draft** with no row resolves to the versioned default `AGENT_BEHAVIOUR_DEFAULT_V1` (STANDARD / CONCEPT_FIRST / STANDARD / STANDARD, no notes). A bound version never resolves against the current default: it reads its frozen binding (section 3a).
  - `/admin/agents` and Course Engineering label it "Versioned default (…)" plus "frozen at publication" or "draft, not yet frozen".
  - Historical versions gain no new programme-authored text.
- **`instructionalNotes`.** The AC-1 field `instructionalNotes` stays stored but unused. It is not reinterpreted.
- **Course Engineering.** There is a typed form per role while the version is a draft, and a read-only view with a "fixed" notice once it is bound. There is no prompt editor and no model, provider, endpoint, key, tariff, budget or test-adapter field.
- **`/admin/agents`.** Read-only. It shows, from the database's effective resolution (`behaviourEffective`), the pinned role behaviour version, the configuration source and version, a summary of the actual values, whether notes are stored, and whether the behaviour is frozen. A missing or invalid binding is shown as "execution refused" with no fingerprint. It never shows note text.
- **Behaviour fingerprint.** `AGENT_BEHAVIOUR_FINGERPRINT_V1` is a separate, explicitly named SHA-256 over the version id and, for each role in fixed order, its **actual effective semantics**: pinned role behaviour version, source, config version, and the four values plus notes. For a default, the default's concrete values are hashed, not merely its name. Timestamps, actors and row ids are excluded.
  - Draft: computed from the live resolution, so a draft edit (or a change of the current default or role version) changes it. Bound: computed only from the frozen bindings, so it is stable and identical to the value immediately before publication.
  - Null when a bound version's binding is missing or does not verify.
  - It is shown on `/admin/agents` and in Course Engineering, and recorded on every execution-provenance row.
  - The migration-035 package publication fingerprint (`COURSE_PREPUBLICATION_TEST_V1`) does **not** cover behaviour and was not changed. Folding behaviour into it would reuse that tag over different material and silently invalidate existing readiness evidence.
- **Learner read.** `get_agent_behaviour_for_enrolment` is the learner-scoped read (STUDENT and enrolment owner only). It returns only the frozen binding (section 3a).

## 3a. Publication-time behaviour bindings (historical default drift)

Without a binding, a version with no Level-3 row would be resolved at **execution** time against whatever default and role baseline the code then had, so a later code change would silently rewrite the behaviour of published and enrolled versions.

- **Table** `academic_agent_behaviour_bindings`: one immutable row per (programme version, role) holding the effective semantics frozen when the version became bound:
  - `behaviour_version`, the pinned Level-2 role behaviour version;
  - `config_source` (EXPLICIT/DEFAULT), `config_version` and, for EXPLICIT, `config_id`;
  - the four values and the notes (copied for EXPLICIT, the default's concrete values for DEFAULT);
  - `bound_event` (PUBLICATION or MIGRATION_BACKFILL) and a database-computed `semantic_digest` (`AGENT_BEHAVIOUR_BINDING_V1`).
- **Materialisation: publication only.** An AFTER UPDATE OF status trigger on `programme_versions` binds all three roles when a version first becomes PUBLISHED, inside the publication transaction that holds the version row lock: an explicit draft row becomes an exact frozen binding, and a role without one freezes the concrete `AGENT_BEHAVIOUR_DEFAULT_V1` values. The same trigger then requires all three bindings to exist and verify (`require_frozen_bindings`), so publication cannot commit without them. Publication is the only normal place a binding is ever created.
- **One-time legacy backfill.** Migration 051 section 6 binds versions that were already published before AC-2 (see below). That is a reviewed migration action, not a runtime mechanism.
- **Enrolment only verifies.** A BEFORE INSERT trigger on `enrolments` (`verify_agent_behaviour_on_enrolment`, ordered after `guard_enrolment`, which locks the version and refuses an unpublished one) requires every Professor/Tutor/Lab binding to exist, carry a valid digest, name a recognised role behaviour version and a recognised config version, and agree with its frozen source. Otherwise the enrolment is refused with `AGENT_BEHAVIOUR_BINDING_MISSING: <ROLE> …` or `AGENT_BEHAVIOUR_BINDING_INVALID: <ROLE> …` and nothing is written. Enrolment never creates, recreates, repairs or replaces a binding, never rebuilds a digest and never switches to the current default.
- **No repair path.** Outside publication and the migration-051 backfill, nothing creates a binding. A missing or corrupt binding blocks enrolment and execution for that version until a separately reviewed repair procedure exists.
- **Guard.** Bindings are never updated or deleted (`AGENT_BEHAVIOUR_BINDING_IMMUTABLE`). An insert is accepted only for a bound version (`AGENT_BEHAVIOUR_BINDING_NOT_BOUND`) and only with exactly the live effective semantics at that moment (`AGENT_BEHAVIOUR_BINDING_MISMATCH`); the digest is computed by the database. No client role has any table privilege.
- **Backfill.** Migration 051 section 6 binds every version that is already bound when it runs, in `programme_versions.id` order under `FOR UPDATE`, as `MIGRATION_BACKFILL`. No such version can have a Level-3 row (the table is new and the freeze refuses first inserts), so each is bound to `AGENT_BEHAVIOUR_DEFAULT_V1`'s values and the V1 role baselines — what it would otherwise resolve to today. It is idempotent, and the publication trigger already exists when it runs.
- **Single verdict** `agent_behaviour_private.frozen_binding`, used by enrolment verification, publication completeness and the resolver `effective_behaviour`. A draft resolves live. A bound version resolves only from its binding, which must exist, carry a matching digest, name a recognised role behaviour version (`recognised_role_behaviour_version`) and config version, and agree with its frozen source: the explicit row it names (EXPLICIT), or the fixed values of the default version it names with no explicit row present (DEFAULT). Otherwise it returns `BEHAVIOUR_BINDING_MISSING` or `BEHAVIOUR_BINDING_INVALID`.
  - The learner read, the Professor provenance RPC, the Tutor/Lab provenance trigger, the fingerprint and both admin projections all use it.
- **Fail closed.** A missing or invalid binding refuses enrolment (above) and the learner read; the server then abstains (`POLICY_BLOCKED`) before any release or execution. The Professor provenance RPC returns `BEHAVIOUR_BINDING_INVALID`; the Tutor/Lab AUTHORIZE raises `AGENT_BEHAVIOUR_BINDING_INVALID`. An in-place edit of a versioned default's values is detected as `BEHAVIOUR_BINDING_INVALID`, never applied silently.
- **Versioned defaults.** `agent_behaviour_private.default_config(version)` and the code's `AGENT_BEHAVIOUR_DEFAULTS` map a default version to fixed values that are never edited. `current_default_version()` / `AGENT_BEHAVIOUR_DEFAULT_VERSION` name the default a **new** binding uses. A changed default is a new version (and needs a reviewed migration to widen the binding's CHECK).
- **Pinned Level 2.** The code keeps every reviewed role baseline keyed by version (`roleBaselineFor`). `composeAgentInstructions` uses the binding's pinned version, not `ROLE_BEHAVIOUR_VERSION`, and throws `UnreviewedBehaviourVersion` for an unknown or cross-role version. The server read, both runtimes and the provider harness refuse such a version before any provider call. The Professor provenance RPC compares the claim with the **pinned** version, and the provenance CHECK no longer depends on the current mirror function, so a later role version never invalidates historical provenance. The Professor and Tutor/Lab context `behaviourVersion` field carries the pinned version.
- **No code fallback.** `defaultEffectiveBehaviour(role)` remains for drafts, previews and tests only. The provider no longer substitutes it when behaviour is absent: a teaching role without behaviour is refused (`POLICY_BLOCKED` in the harness; `UnreviewedBehaviourVersion` in `providerInstructions`).
- **The server also verifies** that a frozen DEFAULT carries exactly its version's values and rejects the legacy pre-binding response shape.

## 4. Professor

- **Curriculum and objectives.** These come from the governed releases (section 1). The **complete** authoritative objective set is mandatory, with full descriptions in published order.
  - If the governed read reports more objectives than it returned (`nextAfterPosition` is not null; page size 50), the Professor refuses before any execution is authorized (`POLICY_BLOCKED`).
  - It does not paginate: the reviewed 16,000-byte input budget cannot hold more than a page of complete objectives, and the budget is not raised.
- **Teaching.** Explanation, understanding checks and adaptation to explicit learner requests are role-baseline rules. An "instructional understanding estimate" is permitted only as a teaching signal and must never be called mastery, a grade, evidence, completion or progress.
- **Mastery.** Authoritative mastery appears only when the `get_current_mastery_state` capability is authorised, and it is labelled as authoritative. Otherwise `authoritativeMastery.available` is false.
- **Time.** Timing comes from `get_my_professor_classroom_state`, which uses the database clock.
  - LIVE: remaining minutes, from the server, floored at 0.
  - CATCH_UP: `remainingMinutes: null`, with a "no class clock" note.

  The browser supplies no timing.

- **Progress.** Lesson progress is **not** part of the Professor boundary in AC-2 (`lessonProgress.available: false`). The Professor cannot write progress. Nothing parses provider prose into records.
- **Weak areas.** No Professor → Sarah delivery. Weak-area handoff is an AC-3 boundary.
- **Classroom identity.** A classroom interaction now requires its server-opened `classSessionId`. An interaction without it abstains (`NO_EXECUTION_PATH`) with zero provider calls.

### Context budgeting

`buildProfessorTeachingContext` measures the UTF-8 JSON size against the runtime profile's `maxInputContextBytes`, minus a 256-byte safety margin.

1. **Mandatory:** role, behaviour version, lesson identity, the complete objective set (with authoritative mastery state where authorised), authoritative timing, memory continuity state and the learner interaction. If these do not fit, the call is refused before any execution is authorized (`BUDGET_BLOCKED`, PRE_CALL). Objectives are never dropped or truncated.
2. **Optional, in order:**
   - course context notes (whole, or omitted and reported);
   - classroom memory, newest first, up to 12 turns of at most 1,200 characters each;
   - resources, first in full (excerpt up to 2,000 characters), then identity only.

A lesson with no objectives, or an incomplete objective set, is refused with `POLICY_BLOCKED`.

## 5. Professor classroom memory

- **Table.** `professor_classroom_turns`: one row per succeeded Professor classroom execution, at most 200 turns per classroom.
  - Learner message: at most 2,000 characters. It is null only for `BEGIN_LESSON`.
  - Professor message: at most 12,000 characters.
- **Writes.** The memory is server-owned. The trusted controller writes a turn only through `record_professor_classroom_turn`, which:
  - is attested under the new tag `DUCELIO_CLASSROOM_TURN_HMAC_SHA256_V1`, with SHA-256 digests of both message texts in the MAC;
  - requires the execution to be the learner's own and SUCCEEDED, with provenance naming the same classroom.

  The browser cannot submit or forge history. Duplicates are idempotent.

- **Visibility.** The memory is learner-bound and classroom-bound. `list_my_professor_classroom_turns` returns turns to the owning learner only, and returns `ACTIVITY_BLOCKED` while the controlled-assessment firewall forbids explanation.
  - There is no read path for admins, instructors, counsellors, Sarah, Tutor or Lab.
  - The learner's classroom page shows the transcript, with a note that it is kept for them and is not a record or shared with staff.
- **Authority.** The memory is **non-authoritative**: it is labelled `NON_AUTHORITATIVE_LEARNER_VISIBLE_TRANSCRIPT` in the context and never treated as evidence, mastery or progress.
- **What is not stored.** No hidden reasoning, provider payload, prompt or key is stored.
- **Retention.** There is no automated expiry or deletion in AC-2. Turns are retained, immutable, until a reviewed retention and deletion policy is implemented. That policy is a required follow-up before production use.
- **Continuity is derived, never assumed.** A turn is recorded after a confirmed SUCCEEDED finalisation. If recording fails (or the reply is over 12,000 characters), the confirmed answer is still shown, but it is never silent:
  - the result says `classroomMemory: "NOT_RECORDED"`, and the learner sees "This reply could not be saved to this classroom's conversation, so the Professor may not remember it later";
  - the database itself counts SUCCEEDED, provenance-bound exchanges of the classroom that have no turn (`unrecordedExchanges`), so every later turn gives the Professor `classroomMemory.continuity: "DEGRADED"` with an instruction not to assume it knows everything already discussed, and the classroom page shows a degraded-memory notice.
- **Capacity.** At 200 turns the classroom reaches an explicit capacity state (`capacityReached`).
  - The Professor refuses further turns in that classroom before any execution is authorized (`POLICY_BLOCKED` with `classroomMemory: "CAPACITY_REACHED"`, never persisted as a terminal reason).
  - The learner is told the conversation has reached its 200-exchange limit; the Begin, Ask and Send controls are disabled.
  - The database also refuses a 201st turn (`TURN_LIMIT_REACHED`). The transcript stays visible.

## 6. Tutor and Lab Instructor

- **Tutor.** Receives `professorTeachingRecord: {available: false, reason: "NO_GOVERNED_PROFESSOR_TEACHING_RECORD"}` and is told not to claim what the Professor taught (AC-3). It gives no protected-assessment help and produces no class notes (AC-4).
- **Lab Instructor.** Receives `sessionTiming: {available: false, reason: "NO_AUTHORITATIVE_LAB_SESSION", remainingMinutes: null}`, because no Lab execution is linked to an authoritative session. It is told never to claim that anything ran or produced output, and never to state a remaining time.
- **Both.** Programme notes are attached as subordinate data, and dropped if over budget. Behaviour is resolved server-side after the release recheck. Failure gives `POLICY_BLOCKED`.

## 7. Execution provenance

Table `academic_agent_execution_provenance`: one immutable row per execution. It records:

- role, learner, programme version and enrolment;
- classroom (Professor only);
- runtime profile ref;
- the applied Level-1 institutional baseline version (`institutional_baseline_version`, version only — never rule text);
- the pinned Level-2 behaviour version;
- behaviour-config source, version and row id;
- the `AGENT_BEHAVIOUR_FINGERPRINT_V1` value.

No prompt, response, key, MAC or provider payload is stored.

- **Tutor/Lab.** Derived entirely by the database (AFTER INSERT trigger on `tutor_lab_provider_executions`) from the execution's own governed release.
- **Professor.** The 025 execution row has no enrolment, so the controller records provenance through `record_professor_execution_provenance`, under the new tag `DUCELIO_AGENT_PROVENANCE_HMAC_SHA256_V1`. This happens after AUTHORIZE and before START. The attested message carries the applied institutional baseline version (after the runtime profile ref). The database re-derives the classroom, programme version, runtime profile ref, pinned behaviour version and configuration version, requires the institutional baseline to equal its mirror, and refuses any mismatch (`PROVENANCE_MISMATCH`); a missing or invalid binding gives `BEHAVIOUR_BINDING_INVALID`. A provenance failure aborts the execution before any provider call.
- **Context-release manifest (Professor).** `academic_agent_execution_context_releases` records, for each content release that contributed data to the call, only its release id, capability name and position. The manifest is part of the attested provenance message, so application code cannot substitute release ids. The database requires and verifies:
  - the exact capability list implied by the stored configuration: lesson context (the execution's own, outermost release) and objectives always, then resources and mastery exactly when authorised;
  - for every release: the same learner, the PROFESSOR profile, `PROFESSOR_READ_V2`, the matching capability, an ACTIVE and unexpired lease, a start no earlier than the outer release, and no reuse by another execution.

  Limitation: the legacy release row carries no lesson or enrolment selector, so lesson identity is not provable from the release itself. It is enforced instead by the runtime's classroom/lesson match and the gateway's own scoped reads.

- **Scope.** Only classroom Professor executions record provenance. The generic, non-classroom Professor path has no production caller and records none.
- **Existing HMAC protocols are unchanged** (022/025/028/031/032/040). The new protocols use the same controller key with distinct tags.

## 8. Local evidence

- New suites:
  - `agent-behaviour-contract` (12): levels, versions, role keying, enums, default, ordering, notes excluded.
  - `agent-behaviour-db`: 22 tests, all needing migration 051. They cover:
    - the draft/published/enrolled first-insert and update freeze matrix, delete refusal and the lock order;
    - the behaviour fingerprint;
    - audit without notes and the learner read;
    - provenance attestation, mismatch and the context-release manifest (substitution, omission, order, foreign learner, wrong capability, closed release, configuration-implied completeness);
    - memory attestation, continuity and capacity, owner-only and firewall-gated reads, bounds and ACLs.
  - `agent-behaviour-provider-instructions` (5): composed contract, default, no learner or notes text, Examiner byte-for-byte unchanged, COUNSELLOR.
  - `professor-teaching-context` (15) and `tutor-lab-provider-context` (3): timing, mandatory complete objectives, incomplete and overflowing objective refusal, optional-context order, continuity labelling.
  - `professor-classroom-teaching-runtime` (32): nested releases, the manifest, START and provider only while every release is ACTIVE, denial of each capability, finalization failure of each release, outer failure, provider exception, objective refusals with zero provider calls, memory continuity and capacity.
- Extended suites:
  - Real-database nested releases through the real gateway (`academic-capability-workflow`, 4 new):
    - all four releases ACTIVE together during consumption;
    - controlled-assessment start refused in that window;
    - all closed afterwards, none left ACTIVE after a consumer failure or a failed nested read;
    - a real multi-page objective set refused.
  - Course Engineering admin (54) and real-DB workflow (2); Tutor/Lab DB and runtime; classroom runtime, actions and domain; control-plane server and UI (including the memory-state panel and fingerprint display).
- After the correction pass: focused AC-2 set 19 files, all passing; `npm run check` 3,728/3,728 across 151 files, exit 0; `npm run build` passed; `npm audit --omit=dev` 0 vulnerabilities (one transient audit-endpoint error on the first attempt, then a clean retry); `git diff --check` clean.
- After the final historical-default-drift correction: focused set of 23 files, 580/580 passing; `npm run check` (lint, type check, tests) **3,763/3,763 across 152 files**, exit 0; `npm run build` passed; `npm run format:check` clean; `npm audit --omit=dev` 0 vulnerabilities; `git diff --check HEAD` clean (the new untracked test file was checked separately for trailing whitespace).

## 9. Not implemented (and not claimed)

- Sarah production execution, academic handoffs, Professor → Sarah weak areas, teaching feedback, Tutor class notes, Sarah recommendations and profile mutation.
- New Examiner behaviour.
- Agent-to-agent transcript sharing.
- Lab session timing.
- Lesson progress in Professor context.
- Any treatment of an instructional estimate as mastery.
- Persistent learner learning-style profiles.
- Live-provider evidence for the new behaviour. Deterministic tests prove contract shape, not teaching quality.

## 10. Known limitations

- No memory retention, expiry or deletion policy is implemented; turns are kept until one is approved.
- A lesson with more than 50 objectives cannot be taught by the Professor (fail closed) until a reviewed design covers it. Resources: only the first page (5 items) is used.
- The 035 package publication fingerprint does not cover behaviour. Behaviour has its own `AGENT_BEHAVIOUR_FINGERPRINT_V1`, which the pre-publication test does not gate on; behaviour is instead frozen by the database at publication (and verified at enrolment).
- Release rows carry no lesson selector, so the context-release manifest cannot prove lesson identity by itself.
- The lock-order proof is structural plus single-connection PGlite evidence, not a real concurrent race.
- Course context notes are learner-readable through the learner-scoped read, by design. Authors must not put private or assessment material in them.
- PGlite is single-connection. Hosted ACL/JWT/PostgREST and real multi-connection acceptance of migration 051 have not run, nor has live-provider and browser/accessibility acceptance.

## 11. AC-3 prerequisites

- Independent review and merge of AC-2. Hosted acceptance of 050–051.
- A reviewed retention and deletion policy for Professor classroom memory.
- A reviewed, minimum-data handoff projection: what the Professor may hand to the Tutor or Lab, and what the learner sees. This is the only route by which the Tutor may later learn what was taught.
- A reviewed decision on whether a Lab execution can be linked to an authoritative session (precondition for any Lab timing).
- Resolution of the "Sarah Mitchell" demo-data naming collision before AC-5. _(Resolved in [AC-5](47-agent-behaviour-ac5-sarah.md).)_
- An evaluation plan for instructional behaviour quality.

## 12. Independent-review correction pass

1. Complete objectives are mandatory Professor context. Overflow gives a pre-call `BUDGET_BLOCKED`, and an incomplete set gives a pre-call `POLICY_BLOCKED`, with zero provider calls in both cases.
2. Option B: an incomplete objective set fails closed (no pagination, no budget increase, no new read path).
3. The Level-3 first-insert freeze is proven for published and enrolled versions, with delete refusal and the shared row-lock order.
4. A separate `AGENT_BEHAVIOUR_FINGERPRINT_V1`, shown to admins and recorded in provenance. The package fingerprint is unchanged and documented as not covering behaviour.
5. An attested, database-verified context-release manifest for every Professor classroom execution (new AC-2 protocol only; the V2 HMAC format is unchanged).
6. Memory continuity is derived and surfaced (`NOT_RECORDED`, `DEGRADED`), and the 200-turn bound is an explicit capacity state with a pre-call refusal.
7. The migration was renamed to `202610050051_agent_behaviour.sql`.
8. Nested-release safety is covered by both the stand-in-gateway runtime suite and the real-database gateway suite.

## 13. Final correction: historical default drift

1. Effective Level-3 behaviour is frozen at publication into `academic_agent_behaviour_bindings` (section 3a), including a default's concrete values.
2. Already-bound versions are backfilled by migration 051 section 6 (idempotent, `MIGRATION_BACKFILL`).
3. Published/enrolled runtime reads only the binding and fails closed when it is missing, has a bad digest, disagrees with its frozen source, or names an unreviewed role version. There is no fallback to the current code default anywhere in the runtime.
4. `AGENT_BEHAVIOUR_FINGERPRINT_V1` now hashes actual effective semantic values. The tag is kept: its previous definition never left this unmerged branch, so no persisted value is reinterpreted.
5. Level-2 role behaviour versions are pinned per programme version and resolved through a versioned registry.
6. Tests: `agent-behaviour-db` gains 9 binding tests (31 total); new `agent-behaviour-config-server` (12); `agent-behaviour-contract` +4 (16); runtime refusal and frozen-value tests in the classroom teaching (+3) and Tutor/Lab runtime (+2) suites; a Tutor/Lab DB fail-closed AUTHORIZE test; control-plane UI (+2) and Course Engineering (+1) binding-state tests.
7. Limitation: a future default or role version requires a reviewed migration to widen the binding and provenance CHECK lists, by design. Bindings do not repair themselves: a corrupted binding blocks teaching executions for that version until a reviewed repair.

### Level 1 institutional baseline

Level 1 (`DUCELIO_INSTITUTIONAL_BASELINE_V1`) is the global, non-editable institutional safety baseline. Unlike programme academic semantics it is **not** frozen per programme and may evolve institutionally. Its applied version is auditable on every execution:

- **Professor:** the controller attests the version it applied (`INSTITUTIONAL_BASELINE_VERSION`) in the new AC-2 provenance message; the database refuses any value other than its mirror `agent_behaviour_private.institutional_baseline_version()` and records it.
- **Tutor/Lab:** the legacy Tutor/Lab AUTHORIZE format is unchanged, so the provenance trigger records the database mirror. The learner read returns the same mirror, and the server refuses to execute (`POLICY_BLOCKED`) unless it equals the code's applied baseline, so the recorded value is the applied one.
- A contract test pins the mirror to the code constant. A new baseline version needs a reviewed migration to update the mirror and widen the provenance CHECK.

## 14. Final correction: fail-closed historical semantics

1. The enrolment trigger that could create a missing binding was removed (and `ENROLMENT` removed from `bound_event`). Enrolment now only verifies, and refuses with a precise governed error.
2. Publication remains the only normal materialisation boundary and now also requires all three verified bindings before it can commit.
3. The migration-051 one-time legacy backfill is unchanged and is the only other caller of the materialiser.
4. Execution provenance records the applied institutional baseline version (new AC-2 schema and protocol only; legacy HMAC formats unchanged).
5. Tests: `agent-behaviour-db` gains 13 (44 total): enrolment A–H, publication completeness, a structural no-materialisation check, and three institutional-baseline provenance tests. New `professor-provenance-attestation` (1) checks the recorder's canonical order and MAC against the database's. `agent-behaviour-config-server` gains 2 (14), `agent-behaviour-contract` gains 1 (17), and the Tutor/Lab DB and classroom runtime suites assert the recorded/attested baseline. A mutation check (enrolment calling the materialiser before verifying) is caught by B, C, D and the structural test.
6. Gates on the final tree: focused set 17 files, 392/392; `npm run check` **3,780/3,780 across 153 files**, exit 0; `npm run build` passed; `npm audit --omit=dev` 0 vulnerabilities; `npm run format:check` clean; `git diff --check HEAD` clean (untracked new test files checked separately for trailing whitespace).
