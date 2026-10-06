# AGENT-CONTROL-1: truthful agent control plane and configuration governance

Branch `feat/agent-model-control`, base `d6bf283cf30915aa8eea3248d5a1ec7d1267517d` (`main` after PR #53). Migration `202610050050_agent_configuration_governance.sql` follows unchanged migrations 001–049.

**Status:** implemented and locally validated, uncommitted, awaiting independent review. Hosted acceptance has not run. This checkpoint makes no production-readiness claim and marks no role production-proven.

AC-1 is the first checkpoint of the Agent / Model control and Governed Academic Agent Behaviour workstream. It is **foundation work only**: Agent / Model and Behaviour work is **not complete** after it. The approved following checkpoints, AC-2 to AC-7, are recorded at the end of this document. They are not dropped and none of them is implemented here.

## Scope

AC-1 does:

- bind academic-semantic agent configuration to its programme version;
- show agent and model state truthfully to operators;
- remove controls that implied authority or behaviour that does not exist;
- remove learner copy that claimed academic reviews that do not exist.

AC-1 does **not**:

- change any provider, model, tariff or budget assignment;
- add any AI prompt, role behaviour instruction, handoff, class note, classroom memory or Sarah runtime;
- call any provider;
- add any mutation surface to `/admin/agents`.

## 1. Configuration governance (migration 050)

`academic_agent_configs` is keyed by programme version. Before 050, it stayed fully mutable after the version was published and learners enrolled, unlike the curriculum it belongs to (`guard_curriculum_version`). An admin could therefore silently change the academic configuration bound to learners already enrolled on a published version.

The defect was proven first. `tests/agent-config-governance-db.test.ts` ran against migrations 001–049: 23 of 29 tests failed. Every "refuses …" case failed with `promise resolved instead of rejecting`, because `set_agent_config` and a direct owner `UPDATE` both accepted the semantic change.

**Bound** means the version is `PUBLISHED`, or has any enrolment. This is the same rule `guard_curriculum_version` uses (`agent_config_governance_private.version_bound`). Enrolment already requires a published version (`guard_enrolment_history`), so in practice bound means published.

| Change on a bound version                                                         | Result                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled` true ↔ false                                                            | **Allowed**: the audited operational kill switch                                                                                                                                                                                                                                                                                   |
| capabilities narrowed (new set ⊆ old set)                                         | **Allowed** (operational)                                                                                                                                                                                                                                                                                                          |
| capabilities widened (any capability not already configured, including a swap)    | Refused `AGENT_CONFIG_SEMANTIC_FROZEN`                                                                                                                                                                                                                                                                                             |
| `instructional_notes` changed or cleared                                          | Refused `AGENT_CONFIG_SEMANTIC_FROZEN`                                                                                                                                                                                                                                                                                             |
| `model_profile_ref` changed (including null ↔ the role's own ref)                 | Refused `AGENT_CONFIG_SEMANTIC_FROZEN`                                                                                                                                                                                                                                                                                             |
| `escalation_policy` changed: PROFESSOR, TUTOR, LAB_INSTRUCTOR, COUNSELLOR         | Refused `AGENT_CONFIG_SEMANTIC_FROZEN`                                                                                                                                                                                                                                                                                             |
| `escalation_policy` EXAMINER `NONE → ACADEMIC_REVIEW`                             | **Allowed** (see escalation analysis below)                                                                                                                                                                                                                                                                                        |
| `escalation_policy` EXAMINER `ACADEMIC_REVIEW → NONE`                             | Refused `AGENT_CONFIG_SEMANTIC_FROZEN`                                                                                                                                                                                                                                                                                             |
| identical re-save                                                                 | Allowed (no-op update, audited with `changed_fields: []`)                                                                                                                                                                                                                                                                          |
| first binding of a role with no row, on a DRAFT (unpublished, unenrolled) version | Allowed: ordinary authoring                                                                                                                                                                                                                                                                                                        |
| first binding of a role with no row, on a PUBLISHED, unenrolled version           | Allowed **only** when the row exactly matches the version's single immutable published package proposal for that role. Otherwise refused `AGENT_CONFIG_PACKAGE_MISMATCH`, or `AGENT_CONFIG_PACKAGE_AUTHORITY_UNAVAILABLE` when there is not exactly one bound import in status PUBLISHED. Course activation supplies exactly this. |
| first binding of a role with no row, once learners are enrolled                   | Refused `AGENT_CONFIG_BINDING_CLOSED`, even if it matches the package; activation cannot create it either                                                                                                                                                                                                                          |

Anything else needs a new programme version, exactly as for curriculum.

**Mechanism.** `guard_agent_config_semantic_binding` is a `BEFORE INSERT OR UPDATE` trigger.

- It binds every writer, including any future `SECURITY DEFINER` function and the database owner, not only `set_agent_config`. This is tested: a direct owner `UPDATE` is refused.
- `set_agent_config` upserts. A `BEFORE INSERT` trigger fires before conflict detection, so the insert branch treats an existing row as the update the statement will become, and lets the update branch govern it.
- Two existing tests deliberately seed corrupt `model_profile_ref` rows as the owner, to prove runtime fail-closed. They now disable only this trigger around that one write, mirroring the established `guard_agent_config_history` pattern.

**Serialisation.** The trigger explicitly takes the `programme_versions` row `FOR UPDATE`, the same lock 027's `activation_config_serialization` takes. Two other operations contend for that row:

- enrolment creation (`guard_enrolment_history` `FOR SHARE`, plus the enrolments foreign key's `FOR KEY SHARE`);
- publication (`UPDATE` of the row).

So a configuration write and a concurrent first enrolment or publication are serialised. PGlite cannot prove this under real concurrency; it is a hosted acceptance item.

**First binding on a published version (independent-review correction).** Course activation (027/037 `course_activation_private.configs()`) legitimately creates a missing role row after publication, but that must not open arbitrary post-publication authoring. So a first binding on a PUBLISHED, unenrolled version is allowed only when it exactly matches the immutable package. `agent_config_governance_private.package_first_binding` establishes the match inside the database:

- **Authority.** It derives the authority from `programme_version_id` alone. No caller-supplied package identity, flag, session variable, reason string or trigger-disable path is consulted.
- **Reference.** The reference is the stored `raw_package` of the course package import bound to the version. Migration 024 makes `raw_package`, the package identity and the version binding immutable, and refuses DELETE.
- **Ambiguity.** The schema has no unique constraint on `course_package_imports.programme_version_id`. The guard therefore requires exactly one bound import, in status `PUBLISHED`; anything else is `AGENT_CONFIG_PACKAGE_AUTHORITY_UNAVAILABLE`. It never picks a row. Since migration 035, a package-linked version can be published only through `publish_course_package`, which moves its import to `PUBLISHED`.
- **Exact match.** It checks role, `enabled`, `model_profile_ref`, `instructional_notes` (`nullif(trim(…),'')`), `escalation_policy` and `policy_version`, with capabilities compared as sorted sets. This is the same normalisation activation and the pre-publication readiness check use. Any difference is `AGENT_CONFIG_PACKAGE_MISMATCH`. A malformed proposal (non-object, non-boolean `enabled`, non-array or non-string capabilities) is `AGENT_CONFIG_PACKAGE_AUTHORITY_UNAVAILABLE`.
- **Rows that already exist** are unaffected; the reviewed UPDATE rules apply.

Enrolled versions remain fail-closed for first bindings even when the values match the package, so activation of an enrolled version with a missing role row now fails closed too (`AGENT_CONFIG_BINDING_CLOSED`).

In practice a package version published through the post-035 pipeline already has all five rows, because the pre-publication test requires them. A missing row therefore arises only from historical or exceptional state, and the tests construct it by test-owner deletion.

**Unchanged:**

- `set_agent_config`'s signature, its admin check and its role, capability and profile validation;
- no table grants;
- RLS enabled with no policies;
- the RPCs remain the only path.

The closing assertion block fails deployment if `anon`, `authenticated` or `service_role` holds any table or column privilege on `academic_agent_configs`, any usage of the private schema, or `EXECUTE` on anything other than the four reviewed public RPCs (`set_agent_config`, `list_agent_configs`, `get_agent_config_for_enrolment` and the new `admin_list_agent_configuration_scopes`).

### Escalation analysis

The review asked whether `escalation_policy` should stay mutable at all. Current behaviour by role:

| Role                   | What `ACADEMIC_REVIEW` does today                                                                                                                                                                                                                          | Truthful post-binding change? |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| PROFESSOR              | `executeRoleCapability` returns ESCALATED for every request with no provider call and **no review record**.                                                                                                                                                | No: refused                   |
| TUTOR / LAB_INSTRUCTOR | Never read by `executeTutorLabSupport`; no effect at all.                                                                                                                                                                                                  | No: refused                   |
| EXAMINER               | Initial grading (036) and recovery (040) AUTHORIZE create a durable ESCALATED claim with enrolment and activation. The human academic-review worklist (047) lists it as `INITIAL_ESCALATION` / `RECOVERY_ESCALATION`. Regrade (032) never reads the field. | `NONE → ACADEMIC_REVIEW` only |
| COUNSELLOR             | No runtime.                                                                                                                                                                                                                                                | No: refused                   |

`EXAMINER NONE → ACADEMIC_REVIEW` is the only transition with one well-defined, truthful meaning on every path that reads it. New automated grading and recovery stop calling a provider, and each target becomes a real human academic-review case. It is proven end to end on a published, activated, enrolled course: the flip is accepted, the next governed recovery becomes ESCALATED, and the case appears in `list_commercial_v1_academic_review_cases`. The reverse is refused. The initial-grading path's identical claim shape is proven by `commercial-v1-examiner-grading-db.test.ts` case E. Admin regrade remains a separate, fixed-profile authority and is unaffected; the control plane states this.

### Audit (review correction 1)

Migration 024 deliberately strips `instructional_notes` from audit payloads, and that is preserved. No note text, hash, digest, preview, prefix or suffix is recorded anywhere.

The replaced `audit_agent_config_change` is otherwise unchanged. On `UPDATE` it adds only `changed_fields`, the list of changed field categories, so a notes-only change is distinguishable from a no-op re-save without revealing content. Actor, reason, timestamps and configuration identity are recorded as before. Refused writes roll back and leave no audit row.

A publication-integrity fingerprint of notes, if ever needed, is a separate reviewed design. AC-1 does not add one.

## 2. Truthful operator control plane: `/admin/agents`

The page is read-only and restricted to `ACADEMIC_ADMIN` / `PLATFORM_ADMIN`:

- `requireAnyRole` at the server;
- the database read refuses everyone else with `FORBIDDEN`;
- navigation lists it only for those roles.

It has no form, button, input or Server Action.

Four concepts are shown separately and never combined into a "healthy" flag:

- **CONFIGURED:** from the stored programme-version row: `NOT_CONFIGURED` (fails closed as disabled), `DISABLED`, `ENABLED` or `INVALID` (cross-role reference, Professor enabled with a null reference, or capabilities outside the code catalogue). The page also shows:
  - effective capabilities (configured ∩ code catalogue);
  - required capabilities the role's execution path reads but the row lacks ("enabled but cannot run");
  - executable vs not executable.
- **READY:** whether the credential the profile's adapter needs is present.
- **TESTED:** reviewed evidence per profile at three levels: local/deterministic, hosted, live provider.
- **PRODUCTION-PROVEN:** "not proven" for every profile. `productionProven` is the literal `false`.

Each reviewed profile shows:

- ref, roles, adapter, model;
- reasoning effort (OpenAI only; the Anthropic adapter sends none);
- reviewed budget, the role's database ceiling, the reviewed tariff;
- readiness, evidence and fingerprint.

All of it comes from the unchanged server-owned registry via a read-only `listProductionRuntimeProfiles()`. Platform roles are shown as **not executable**:

- **Sarah** (the platform Counsellor) has no production execution plane and does not exist in production. _(Superseded by [AC-5](47-agent-behaviour-ac5-sarah.md): Sarah Mitchell, Ducelio's AI learner-success counsellor, now runs on the platform COUNSELLOR plane, `SARAH_EXECUTION_V1`, and is shown as executable. Hosted and live evidence remain none.)_
- **Operations Engineer** has no production tool-execution plane.

The academic COUNSELLOR row is shown as historical vocabulary that is not executable and does not launch Sarah. Per role, the page states the exact escalation semantics from the table above.

Programme-version scopes come from `admin_list_agent_configuration_scopes(p_cursor_created_at, p_cursor_id)`:

- keyset pages of 50, newest first, with `hasMore` and `nextCursor`;
- a half-specified cursor is `INVALID_INPUT`;
- it reports version status, `hasEnrolments`, `semanticConfigFrozen` and each role's configuration;
- it returns `hasInstructionalNotes` (a boolean), **never note text**.

### Provider readiness

Readiness reports only `PRESENT`, `ABSENT` or `NOT_USED`:

- `OPENAI_API_KEY` gates the `OPENAI_RESPONSES` profiles (Professor, Tutor, Examiner, platform Counsellor).
- `ANTHROPIC_API_KEY` gates the `ANTHROPIC_MESSAGES` profiles (Lab Instructor, Operations Engineer).
- `ACADEMIC_PROVIDER_*` is reported as `NOT_USED`, the legacy generic `HTTP_JSON` gateway, because no production profile routes through it. It would report presence only if a reviewed profile ever did.

Presence uses the same truthiness the adapters use to construct. No value, prefix, suffix, length, hash, name/value dump or environment content is ever returned or rendered, and no provider call is made to populate readiness (tested with a fetch spy). The UI states that presence is not validity.

### Evidence keyed to the exact profile (`AGENT_PROFILE_EVIDENCE`)

Evidence is never inferred from configuration or credentials. Each entry is reviewed, code-owned data bound to the SHA-256 fingerprint of the canonical (key-sorted) runtime profile:

- `runtimeProfileFingerprint`, in `src/server/agent-control-plane.ts`;
- `canonicalJson`, in `src/domain/agent-control-plane.ts`.

Any change to a profile's model, adapter, reasoning, tariff or budget changes its fingerprint, and every evidence level for it then shows **NOT CURRENT** until it is re-reviewed and re-recorded. A test fails until that happens, so the change cannot pass silently.

| Profile                           | Local / deterministic                                        | Hosted                                                                                                                         | Live provider                                                                                                                                    | Production-proven |
| --------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| `PROFESSOR_COMMERCIAL_V1`         | Recorded                                                     | Partial: FULL_JOURNEY:CLASSROOM stage only, stubbed provider (run `1790635594309-jz55ep`); the full journey has no hosted pass | None                                                                                                                                             | No                |
| `TUTOR_COMMERCIAL_V1`             | Recorded                                                     | Partial: FULL_JOURNEY:TUTOR_LAB stage only, stubbed provider                                                                   | None (the Examiner smoke shares the model id; not evidence for this profile or path)                                                             | No                |
| `LAB_INSTRUCTOR_COMMERCIAL_V1`    | Recorded                                                     | Partial: TUTOR_LAB stage through the governed handoff path, stubbed provider                                                   | Partial: one synthetic request through the production adapter and runtime; the governed handoff/release/attestation workflow was not live-tested | No                |
| `EXAMINER_COMMERCIAL_V1`          | Recorded                                                     | Recorded: EXAMINER_APP GRADING / INITIAL_RECOVERY / REGRADE with a stubbed provider, not a live model                          | Partial: one synthetic request plus strict marks validation; the governed grading workflow was not live-tested                                   | No                |
| `COUNSELLOR_PLATFORM_V1` (Sarah)  | Recorded (AC-5 deterministic tests; was routing/schema only) | None                                                                                                                           | None                                                                                                                                             | No                |
| `OPERATIONS_ENGINEER_PLATFORM_V1` | Partial: routing/schema/driver only                          | None                                                                                                                           | Partial: one synthetic request (model accessibility only)                                                                                        | No                |

## 3. Misleading controls removed (Course Engineering)

**Model profile reference.**

- It is now a read-only display of the role's exact code-owned profile.
- The Server Action no longer reads `modelProfileRef` from the browser. It takes the value from the package's own validated proposal, which can only be null or the role's single profile under migration 036, so saved rows still match the proposal for activation.
- A forged form value is ignored (tested).

**Instructional notes.**

- Labelled "stored but not used by the current runtime", with explicit text that changing them does not change agent behaviour.
- Read-only on a published version.
- The field is not deleted; its successor belongs to AC-2.

**Academic COUNSELLOR.**

- No enabled/capability/notes/escalation inputs.
- It is presented as "not executable" with a single "Record COUNSELLOR package proposal (not executable)" action. That action saves exactly the package proposal, so publication matching still works, and states that it does not launch Sarah.
- The historical schema vocabulary is not deleted.

**Escalation select.** Each role's escalation select now shows that role's truthful semantics.

**Database refusals.** Each of the four closed refusal codes maps to a truthful message: published/enrolled (what can still change); enrolled first binding (use a new version); package mismatch (a missing role can only be recorded exactly as the published package proposes); and no single package authority. All other errors stay generic.

## 4. Escalation truth (learner copy)

Re-audited before changing anything:

- **Professor ESCALATED** arises only from the Professor `ACADEMIC_REVIEW` configuration, which creates no review record. The classroom said "routed to academic review/support", which was false. It now says the Professor is not available for this class and that no academic review has been opened.
- **Tutor/Lab support ESCALATED** is unreachable today because the field is not read. Its copy still claimed "passed to academic review", which was false. It now says no academic review has been opened.
- **Examiner ESCALATED** copy (assessment and lab-work grading) is unchanged, because a real academic-review case exists.

No runtime outcome changed, no review queue was invented, and academic-review authority was not expanded.

## 5. Tests

New:

- `tests/agent-config-governance-db.test.ts` (38, real migrations on PGlite). The first-binding correction added 9 tests, and changed the old "published unenrolled first binding allowed" case into a refusal. Seven of the new cases failed against the uncorrected migration 050 (every mismatch, ambiguity and no-package case was accepted). On a real published package version built through import → validate → apply → configure → pre-publication test → publish, they now cover:
  - notes mismatch, profile-reference mismatch, capability mismatch (narrower and wider), escalation mismatch and `enabled` mismatch, each refused `AGENT_CONFIG_PACKAGE_MISMATCH`;
  - the exact package configuration allowed (reordered capabilities and untrimmed notes normalise exactly as activation does);
  - real `activate_course_package` recreating a missing role row exactly as packaged;
  - an enrolled missing role refused even when it matches, with activation refused too (`AGENT_CONFIG_BINDING_CLOSED`);
  - two imports bound to one version refused `AGENT_CONFIG_PACKAGE_AUTHORITY_UNAVAILABLE`;
  - a published version with no package refused `AGENT_CONFIG_PACKAGE_AUTHORITY_UNAVAILABLE`.

  The original 29 tests cover:
  - draft control;
  - published and enrolled refusals for notes, clearing notes, profile reference, widening, swaps and escalation;
  - owner-level refusal;
  - kill switch both ways with audit actor, reason, before/after and `changed_fields`;
  - narrowing then refused re-widening;
  - identical re-save;
  - EXAMINER transition and its reverse;
  - first binding refused after enrolment;
  - audit with no note text, no SHA-256 (or its prefix) and no note key;
  - table, column, function and private-schema ACLs;
  - non-admin denial;
  - scope read projection and note-free output;
  - keyset paging with no repeats and complete coverage;
  - cursor validation;
  - the live-course EXAMINER escalation proof through the 047 worklist.

- `tests/agent-control-plane-server.test.ts` (22):
  - exact production registry key set;
  - no `HTTP_JSON` / `TEST_DETERMINISTIC` production profile;
  - frozen listing;
  - crossover, unknown-ref and null-semantics regressions;
  - `TEST_DETERMINISTIC` unresolvable under `NODE_ENV=production`;
  - readiness `PRESENT`/`ABSENT`/`NOT_USED` with no secret material (value, prefix, suffix, metadata keys);
  - legacy reported truthfully;
  - no fetch;
  - credential mapping;
  - exact profile metadata and ceilings;
  - evidence covers exactly the registry at current fingerprints;
  - fingerprint key-order independence and value sensitivity;
  - model change invalidates every level;
  - exact per-role evidence statuses, with synthetic smoke never presented as governed-workflow evidence;
  - configuration state derivation;
  - COUNSELLOR non-executable;
  - authorisation before any read;
  - database `FORBIDDEN` mapping;
  - exact RPC call with typed cursor;
  - fail-closed on unexpected payload, including injected note text;
  - cursor parsing.
- `tests/agent-control-plane-ui.test.ts` (14):
  - page gating;
  - navigation by role;
  - read-only markup;
  - the four separate concepts and no health flag;
  - credential presence only, no material, presence-is-not-validity, no fetch;
  - exact profile facts and non-inflated evidence;
  - Sarah and academic COUNSELLOR not executable;
  - notes "stored but not used" and escalation semantics;
  - keyset navigation;
  - no editable `modelProfileRef`;
  - notes label and read-only when published;
  - escalation help;
  - COUNSELLOR form without behaviour fields;
  - learner escalation copy.

Updated (direct, honest consequences of this checkpoint):

- `course-engineering-admin.test.ts`:
  - the forged ref is ignored and the proposal ref is used;
  - the allowlist case now uses TUTOR, because COUNSELLOR is no longer field-editable;
  - new tests for COUNSELLOR proposal recording and both refusal messages;
  - the mock carries the typed refusal class.
- `course-engineering-workflow.test.ts`:
  - the learner-read test now follows configure → publish → enrol, which is the real lifecycle;
  - a new test asserts the first-binding refusal on the seeded enrolled version.
- `commercial-v1-examiner-grading-db.test.ts` (case D) and `commercial-v1-examiner-recovery-db.test.ts` (cross-role ref): the owner-level corruption seed disables only the new guard.
- `admin-control-plane-ui.test.ts`: navigation list.

### Validation (Node 24.19.0, local)

**Focused suites** (after the first-binding correction; 15 files, 497/497 passed)

| Suite                                               | Result |
| --------------------------------------------------- | ------ |
| Governance DB (`agent-config-governance-db`)        | 38/38  |
| Control-plane server (`agent-control-plane-server`) | 22/22  |
| Control-plane UI (`agent-control-plane-ui`)         | 14/14  |
| `course-activation-workflow`                        | 61/61  |
| `course-activation-server`                          | 7/7    |
| `course-engineering-admin`                          | 45/45  |
| `course-engineering-admin-workflow`                 | 2/2    |
| `course-engineering-workflow`                       | 52/52  |
| `course-prepublication-test-gate`                   | 38/38  |
| `pr16a-migration-036-staged-upgrade`                | 8/8    |
| `course-cumulative-assessment-db`                   | 12/12  |
| `tutor-lab-execution-db`                            | 44/44  |
| `commercial-v1-examiner-grading-db`                 | 40/40  |
| `commercial-v1-examiner-recovery-db`                | 50/50  |
| `session-operations-db`                             | 64/64  |

Failing-before evidence:

- The original governance file failed 23 of 29 against migrations 001–049.
- The first-binding correction's new and changed cases failed 7 of 38 against the uncorrected migration 050, and pass after the correction.

**`npm run check`, exactly as defined in `package.json`** (`npm run lint && npm run typecheck && npm test`; `vitest.config.ts`, test timeouts and worker settings unchanged)

| Run   | Tree              | Result             | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----- | ----------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 14:06 | before correction | **FAILED**, exit 1 | Lint and types passed. Vitest default worker count: 12 failed and 116 skipped of 3,603 across 145 files. All were 30-second test or `beforeAll` hook wall-clock timeouts and their consequences ("PGlite is closed"); zero assertion failures. Those 12 files then passed 662/662 alone (`--maxWorkers=4`). An earlier version of this document wrongly stated "15 workers on 16 cores": the count was Vitest's unconfigured default, not verified. |
| 14:31 | before correction | **Passed**, exit 0 | 3,603/3,603 across 145 files.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 15:04 | after correction  | **Passed**, exit 0 | 3,614/3,614 across 145 files (+11: 9 governance, 2 refusal-message cases).                                                                                                                                                                                                                                                                                                                                                                          |

Three full runs with the `--maxWorkers=8` CLI option (14:18, 14:37, 14:41, before the correction) each passed 3,603/3,603. The default-parallelism gate was load-sensitive on this workstation once. CI on Linux remains the authoritative gate.

**Other gates (after the correction)**

- `npm run build` passed with no `.env.local`; `/admin/agents` compiles as a dynamic route.
- `git diff --check` passed. The new files have no trailing whitespace or CR line endings.
- Every changed or new file passes Prettier. `npm run format:check` exits 1 only on the seven unchanged baseline CRLF-checkout files (`.github/workflows/ci.yml`, `package.json`, `tsconfig.json` and four `content/courses/security-plus-sy0-701/*.json`).

**Dependencies**

- `npm audit --omit=dev`: 0 vulnerabilities.
- Full `npm audit` (before the correction): 5 high, all in the dev-only lint chain (`braces` GHSA-vfj7-8cjw-p6xm via micromatch → fast-glob → `@next/eslint-plugin-next` → `eslint-config-next`). Not fixed here; `npm audit fix --force` was not run, and `package.json` / `package-lock.json` are unchanged.

Migrations 001–049 are unchanged. No live provider was called.

## 6. Known limitations

- PGlite is single-connection. The configuration-write vs first-enrolment/publication serialisation relies on real PostgreSQL row-lock conflicts (`FOR UPDATE` against `FOR SHARE` / `FOR KEY SHARE`) and needs hosted multi-connection acceptance. Hosted ACL/JWT/PostgREST acceptance of 050 has not run.
- EXAMINER `NONE → ACADEMIC_REVIEW` is one-way on a bound version. Returning to automated grading needs a new programme version.
- Capability narrowing is one-way on a bound version. Restoring a removed capability needs a new programme version. The `enabled` kill switch is fully reversible.
- Evidence entries are reviewed code data. Recording new hosted or live evidence is a deliberate code change and review, not an automatic feed.
- Credential readiness is presence only and cannot detect an invalid, revoked or unfunded key. No probe call is made by design.
- The control plane does not show which model served a past Professor or Tutor/Lab execution: those execution rows do not persist a runtime profile ref (planned for AC-2). The Examiner already does.
- The Professor `ACADEMIC_REVIEW` setting still turns the Professor off for that version with no review case. AC-1 makes this truthful but does not redesign it. The seeded demo data contains a fictional human counsellor named "Sarah Mitchell", a naming collision to resolve before AC-5. _(Resolved in AC-5: Sarah Mitchell is the AI learner-success counsellor persona; the fictional human staff user is renamed.)_

## 7. Approved following checkpoints (not implemented in AC-1)

**AC-2: Governed Agent Behaviour Contract, levels 1–3.**

- Code-owned institutional and role baselines (levels 1–2), keyed by role, not by profile, so a model change never redefines a role.
- Structured, immutable-after-publication programme-version behaviour configuration (level 3). This is the successor of `instructionalNotes`, rendered subordinate and as data.
- Professor, Lab and Tutor role instructions.
- Professor curriculum, objective, resource, time and progress context from backend-owned state.
- Bounded classroom memory / teaching-state design.
- Execution provenance: runtime profile ref and behaviour version on Professor and Tutor/Lab executions.

**AC-3: Structured academic handoffs.** Professor, Tutor and Lab handoffs to the learner, Tutor, Lab and Sarah, with strict minimum-data projections.

**AC-4: Tutor class notes.** Supplementary, versioned class notes with provenance and the protected-content firewall. They never overwrite published curriculum and are never stored in `learning_resources`. (Status: independently reviewed and merged through PR #58, merge `6845a59`; migration 053 not yet deployed to hosted acceptance; see [AC-4](46-agent-behaviour-ac4.md).)

**AC-5: Sarah production execution plane.** Onboarding, learner guide, confirmed profile proposals, learner-success context. (Status: implemented and locally validated, uncommitted, awaiting independent review; migration 054 not deployed; see [AC-5](47-agent-behaviour-ac5-sarah.md). Sarah Mitchell is the AI persona of the platform COUNSELLOR role.)

**AC-6: Sarah post-session feedback.** Feedback collection and an admin teaching-quality surface.

**AC-7: Sarah course guidance.** Commercial recommendation with a hard data firewall between learner-support context and commercial context.

### Design-record amendments from the independent review

1. **Handoff learner visibility (AC-3).** Learners see their handoffs only through a learner-safe projection, never the raw row. Execution and provenance identifiers, internal IDs and other internal fields are excluded.
2. **Professor multi-turn memory is a required prerequisite (AC-2).** Today every Professor classroom turn is stateless (migration 026 stores no learner prose and no provider output). Until a bounded, learner-visible classroom conversation / teaching-state mechanism with explicit retention and privacy rules is implemented, Professor **cannot** be claimed to satisfy:
   - understanding checks across turns;
   - adaptive teaching across turns;
   - remembering a preferred teaching approach.

   Sarah and admins must not automatically receive Professor transcripts. Any later access needs its own reviewed, minimum-data design.

3. **Lab time awareness is conditional (AC-2).** Lab support is handoff-driven and has no session entity with a start or end. Backend-owned timing may be supplied only when a Lab execution is linked to an authoritative class or lab session. Otherwise the Lab uses progress and task state without claiming a class clock. No model-generated or synthetic countdown is designed or allowed.

## AC-2 prerequisites

- AC-1 independently reviewed and merged; hosted acceptance of migration 050 (effective ACL, JWT/PostgREST, multi-connection serialisation).
- A reviewed decision on classroom memory retention and privacy (learner-visible, bounded, deletion and retention period) before any Professor turn history is stored.
- A reviewed provenance design for adding `runtime_profile_ref` / `behaviour_version` to the Professor (025) and Tutor/Lab (028) execution records without changing their HMAC message semantics unreviewed.
- A reviewed level-3 behaviour-field set (minimum: response depth, teaching approach, understanding-check frequency, challenge level, subordinate course-context notes) and its immutability and fingerprint rules.
- An evaluation plan for instructional behaviour quality. Deterministic tests prove contract shape, not teaching quality.
