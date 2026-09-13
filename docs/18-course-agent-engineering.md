# Commercial V1 — Course & Agent Engineering and B2 runtime foundation

Starting branch `commercial-v1-course-agent-runtime` was clean at exact SHA
`ccfb8c8ae0a2ab172286b5f97c8305e9386d9eb7`, merged main through the commercial
V1 contract checkpoint. This checkpoint introduces no provider/model call, no
learner-facing AI surface, no change to migrations 001-023, and no change to
the existing `PROFESSOR_READ_V2` / `PROFESSOR_EXECUTION_V1` contracts.

Two rounds of independent review found nineteen security/architecture
findings in total (sixteen, then three more after those sixteen were fixed).
Every section below describes the **corrected** implementation actually in
the repository, not either original draft; the "Review corrections" section
at the end maps each finding to its fix and is the authoritative record of
what changed and why.

## Course & Agent Engineering

### Package contract and deterministic validation

`src/domain/course-package.ts` defines `COURSE_PACKAGE_V1`: a versioned,
zod-typed manifest covering programme/examination-body metadata, one
curriculum-version label, modules → lessons → fixed objectives → learning
resources → practical/lab activities, assignment and controlled-assessment
templates (with rubric/marking configuration and objective mappings),
scheduling defaults, and all five role agent configurations.
`validateCoursePackage` is a pure function: structural zod parsing plus
cross-reference checks — duplicate module/lesson/objective/resource/
practical-activity keys, duplicate module/lesson/objective/resource/
practical-activity/question positions, duplicate entries within any single
`objectiveRefs` array, objective references that escape their lesson,
assignment/assessment templates that reference an unknown lesson or an
objective outside it, and an IANA-recognised scheduling timezone. It returns
a discriminated `{valid:true,report,package}|{valid:false,errors}` result and
produces no side effect; the returned `package` (branded
`ValidatedCoursePackage`) is reachable **only** through this successful
branch — there is no separate exported cast/escape-hatch function.
`canonicalizeJson`/`canonicalizeCoursePackage` give a deterministic,
key-order-independent string for the TypeScript side's own use (e.g.
diffing); it is not how the database derives its content-integrity hash (see
below). Every role's `agentConfiguration.capabilities` is checked against the
same single code-owned catalogue the agent-configuration and runtime layers
use (`src/domain/academic-capability-policy.ts`) — a package proposing a
role/capability combination outside that catalogue fails package validation
outright, rather than surviving until a later `set_agent_config` call.

### Staging, publication boundary and reuse of existing authority

Migration `202609120024_commercial_v1_course_agent_engineering.sql` is
additive only. It adds:

- `course_package_imports`: one staged package per row, lifecycle
  `IMPORTED → VALIDATED → APPLIED → PUBLISHED`, or `→ REJECTED` from either of
  the first two states. A CHECK constraint ties every status to its required
  columns; a BEFORE trigger makes identity/content/validation-report/version
  binding immutable and enforces exactly that transition graph; deletion is
  forbidden. `unique(package_key, package_revision)` plus a
  **database-derived** content hash (see below) makes import idempotent for
  a repeat upload and explicitly rejects a conflicting revision. No direct
  table grant exists for `public`/`anon`/`authenticated`/**`service_role`**
  — raw package content can carry controlled-assessment answer keys, so
  every access goes through an RPC, mirroring the existing
  `assessment_answer_keys` precedent. `service_role` has `BYPASSRLS` in this
  project's Supabase-like setup, so this is an explicit ACL revoke, not
  reliance on RLS (see "Database ACL hardening" below).
- `import_course_package`, `mark_course_package_validated`,
  `reject_course_package`: narrow, ACADEMIC_ADMIN/PLATFORM_ADMIN-only RPCs
  for the first three lifecycle stages. REGISTRAR is deliberately excluded
  — correction authority is not teaching/authoring authority.
  `import_course_package` independently binds the caller's declared
  `package_key`/`package_revision`/`schema_version` against the matching
  fields embedded in the raw JSON itself (a mismatch is rejected before
  anything is stored), and derives `content_hash` itself with
  `extensions.digest(p_raw_package::text, 'sha256')` — the caller never
  supplies a hash. Because Postgres's `jsonb` type normalises key order
  internally, two uploads with the same semantic content always hash
  identically regardless of the order keys appeared in the uploaded JSON.
  `mark_course_package_validated` independently re-verifies the package
  through `course_engineering_private.assert_materializable` before
  recording `VALIDATED` — a caller-supplied validation report can describe
  richer TypeScript-only checks, but it can never by itself force this
  transition (see "Database-side validation" below).
- `apply_course_package`: one `SECURITY DEFINER` function that, in a single
  statement/transaction, re-runs `assert_materializable` as a second line of
  defense, then finds-or-creates the `programmes` row by slug
  (`package_key`), inserts a brand-new DRAFT `programme_versions` row, and
  walks the validated JSON to insert `modules` → `lessons` →
  `lesson_objectives` → `learning_resources` — the exact same tables
  migrations 001/006/012 already made authoritative. It reuses every
  existing constraint and `freeze_content` trigger; nothing new is
  duplicated. A unique-label collision aborts the whole statement (tested:
  no orphan version/module is left behind). Re-applying an
  already-applied/published import is idempotent and returns the existing
  version id rather than re-inserting. Assignment/assessment templates and
  practical activities are **not** materialised here: they have no
  cohort/instructor yet (existing `assignments`/`assessments` require one),
  so they stay inside the immutable, already-validated `raw_package` for a
  later, separately governed per-cohort materialisation step through the
  existing `create_assignment`/`create_assessment`/`add_assessment_question`
  RPCs. That later step is explicitly **not implemented** by this
  checkpoint, and neither is auto-populating `academic_agent_configs` from a
  package's `agentConfiguration` field — see "Course & Agent Engineering
  actual status" below for why "configure agents" stays PARTIAL.
- `publish_course_package`: calls the existing `publish_programme_version`
  (migration 006) rather than re-implementing its completeness checks,
  snapshot or audit. Publishing one revision never touches a previously
  published version's rows (tested explicitly: two revisions of one package
  key produce two distinct `programme_versions`, and the first stays
  `PUBLISHED`/unchanged after the second is applied — including when the
  second revision changes the programme's own title/examination-body/
  qualification-name; see "Historical programme metadata" below).
- `get_course_package_content` (full, unredacted, admin-authoring use only)
  and `get_course_package_preview` (redacts every assessment template's
  `expectedAnswer`/`markingGuidance` through a private
  `course_engineering_private.redact_answer_keys` helper before it can leave
  the function) and `list_course_packages` (metadata only).
- A dedicated audit trigger writes to the existing `audit_events` with fixed
  `reason`, stripping `raw_package`/`validation_report` from both before/after
  state — never assessment content, lecture text or answer keys.

The upload→validate→preview→publish boundary is explicit:
`importCoursePackage` (`src/server/course-engineering.ts`) performs only
minimal identity checks before staging and never computes a hash itself; the
separate `validateStagedCoursePackage` re-reads exactly what was staged and
runs the pure domain validator, then records a content-free pass/fail
outcome; `applyCoursePackage`/`publishCoursePackage` are the two remaining
explicit, idempotent steps. No function — including a direct authenticated
RPC call that skips the TypeScript layer entirely — can make an invalid or
incomplete package reach `APPLIED`/`PUBLISHED`.

### Database-side validation: the trust boundary

The database never trusts a caller's claim that a package is valid, and
`VALIDATED` means the **entire** stored `COURSE_PACKAGE_V1` has independently
passed the database's own validator — not only the subset that gets written
to institutional tables.

`course_engineering_private.assert_full_package_valid(package_key,
package_revision, schema_version, raw_package)` is the gate into `VALIDATED`,
called from `mark_course_package_validated`. It independently re-verifies the
complete package contract: identity (schema version and the declared
key/revision/schema-version bound a second time against the stored content,
defense in depth alongside `import_course_package`'s own binding);
programme/curriculum-version metadata; every module/lesson/objective/resource
(shape, required text, positions **and** key uniqueness at every level, and
the same kind-specific resource body/url shape the `learning_resources`
table's own CHECK constraint enforces); every practical activity (shape, key/
position uniqueness, non-empty deduplicated `objectiveRefs` that each
resolve inside the activity's own lesson); every assignment template (key
uniqueness, a `lessonRef` that resolves to a real lesson, deduplicated
`objectiveRefs` resolving inside that lesson, at least one rubric criterion);
every assessment template and its questions (duration/attempts bounds, key
uniqueness, question positions, the controlled-answer shape the package
schema requires, deduplicated `objectiveRefs` resolving inside the template's
lesson); scheduling defaults (one to seven distinct weekdays, an `HH:mm`
start time, and a timezone checked against PostgreSQL's own
`pg_catalog.pg_timezone_names` — not merely a non-empty string); and all
five agent-configuration roles (exactly `PROFESSOR`/`TUTOR`/`LAB_INSTRUCTOR`/
`EXAMINER`/`COUNSELLOR`, no more, no fewer, each with a valid shape and a
deduplicated capability list in which **every** capability is in the
SQL-side reviewed allowlist for that specific role — a package can never
invent a capability). A caller-supplied `validation_report` is recorded
purely informationally; it can never substitute for this independent check,
including when an authenticated ACADEMIC_ADMIN calls the RPC directly and
skips the TypeScript validator entirely (proven by
`tests/course-engineering-workflow.test.ts`'s "full COURSE_PACKAGE_V1
validation cannot be bypassed" suite: seven adversarial direct-RPC attempts —
broken assignment `lessonRef`, broken assessment `objectiveRef`, an invalid
agent role/capability combination, a duplicate `objectiveRef` inside one
array, malformed `studyDays`, an unrecognised timezone, and an explicit proof
that the narrower materialisation-only check alone would **not** have caught
the capability defect — each fails before `VALIDATED`, leaving the row at
`IMPORTED`).

`apply_course_package` retains its own independent call to the narrower
`course_engineering_private.assert_materializable` (schema version and
exactly the modules/lessons/objectives/resources subset it is about to
write) immediately before any institutional insert, as defense in depth at
the actual mutation point — so a forged or tampered `VALIDATED` status is
never sufficient on its own to reach institutional tables either. The two
checks are not merged into one function because they run at different times
for different purposes (validate-the-whole-package vs. a cheap recheck
immediately before a specific write); the one piece of logic genuinely
shared between them — and with `set_agent_config` — is the per-role
capability allowlist, factored into
`course_engineering_private.role_capability_allowlist`, so that allowlist
itself has exactly one definition in SQL. `publish_course_package` requires
`APPLIED` (which requires `VALIDATED`), so a package that bypassed complete
validation can never reach `PUBLISHED` either.

### Database ACL hardening

`service_role` has `BYPASSRLS` in this project's Supabase-like test setup
(`tests/db-helper.ts`), mirroring hosted Supabase — so RLS alone never
protects any object in this migration from it, exactly as migrations
022/023 already documented for their own tables. Migration 024 now mirrors
that exact pattern throughout: every table (`course_package_imports`,
`academic_agent_configs`) and the private schema
(`course_engineering_private`) is explicitly revoked from
`public`/`anon`/`authenticated`/`service_role` at creation (plus a follow-up
column-level revoke, since a table-level `REVOKE` alone does not clear
Supabase-style default column grants); every function this migration
defines — the private helpers and all eleven public RPCs — is explicitly
revoked from all four roles and then `EXECUTE` is granted back to
`authenticated` only on the eleven public RPCs. A closing effective-ACL
assertion block (`has_table_privilege`/`has_any_column_privilege`/
`has_schema_privilege`/`has_function_privilege`) fails this migration's own
deployment if `anon`, `authenticated` or `service_role` retains any
unexpected inherited privilege — it never removes a grant the reviewed
flows need. `tests/course-engineering-workflow.test.ts`'s "service_role ACL
hardening" suite proves `service_role` gets `permission denied` for direct
table SELECT/INSERT/UPDATE on both tables, for every public RPC, and for the
private schema's functions.

### Historical programme metadata

`apply_course_package` updates the live `programmes.title`/
`examination_body`/`qualification_name` row whenever a later revision is
applied under the same `package_key`. This is safe because
`programmes` is documented (migration 006) as the programme's _current_
description, not a per-version record: `publish_programme_version` snapshots
those fields into `programme_versions.title_snapshot`/etc. at the moment a
version is published, and the existing `freeze_content`/`guard_
curriculum_version` triggers make that snapshot immutable afterward (already
proven by `tests/programme-publication.test.ts`, "keeps published curriculum
content immutable"). `tests/course-engineering-workflow.test.ts`'s
"historical programme metadata" test proves this explicitly for the
course-package path: publishing revision 1, then applying (but not yet
publishing) revision 2 with a renamed programme title, leaves revision 1's
`title_snapshot` completely unchanged even though the live `programmes.title`
row now reflects revision 2. No additional versioning of `programmes` itself
was introduced; this is the existing architecture's own intended design,
exercised and proven rather than assumed.

### Reusable academic-agent configuration

`src/domain/academic-capability-policy.ts` is now the single source of truth
for agent-role vocabulary and the per-role capability allowlist — extracted
into its own module specifically so `course-package.ts` and
`academic-agent-config.ts` can both depend on it without a circular import.
PROFESSOR reuses the exact nine-name `PROFESSOR_READ_V2` catalogue; TUTOR,
LAB_INSTRUCTOR, EXAMINER and COUNSELLOR have no independent server-enforced
execution capability today (only the existing availability/
`COUNSELLOR_SCOPE_V1` gating in `src/domain/delivery.ts`), so their
allowlists here are a reviewed placeholder boundary, not a new execution
path. `src/domain/academic-agent-config.ts` re-exports from that shared
module and defines the stored-configuration schema (enabled flag,
model-profile reference, instructional notes, requested capabilities,
escalation policy). Migration 024's `academic_agent_configs` table stores
this per `(programme_version_id, role)`, with the identical allowlist
re-checked in SQL (`set_agent_config`) so the database never trusts the
TypeScript validation alone. `get_agent_config_for_enrolment` is the
learner-scoped read: ownership-checked against the caller's own enrolment,
and **fails closed to a disabled, empty-capability default when no row
exists** — absence is never treated as an implicit grant. A stored row only
ever narrows what a future role runtime may request; execution time
independently re-checks both that the capability is in the code-owned
catalogue **and** that the stored configuration actually requested it
(`isCapabilityAuthorized`) — neither source alone is ever sufficient, so a
stale or over-broad configuration row can never widen authorization beyond
the current reviewed catalogue.

### What this buys for "no bespoke core architecture per course", and what remains manual

A second, third or Nth cybersecurity course can be authored, validated,
applied and published through exactly the RPCs above with zero new
migration, zero new React route and zero new core server endpoint. What is
**not** yet generic: per-cohort materialisation of a package's assignment/
assessment templates still goes through the existing cohort/instructor-bound
authoring RPCs by hand, and a package's proposed `agentConfiguration` is not
auto-applied into `academic_agent_configs` — an admin must call
`set_agent_config` separately. Both were deliberate scope decisions in this
checkpoint (see "Course & Agent Engineering actual status" below), not
oversights.

## B2 provider-neutral AI runtime

### Scope decision — why real generation is not wired into migration 022

`docs/15-academic-execution-governance.md` already documents that B1's
`govern_professor_execution` admits **exactly zero provider calls, zero
tokens, zero cost** as its reviewed ceiling, and says in so many words: _"B2
must introduce a reviewed nonzero envelope... Policy changes require review
and a database migration."_ Splicing a real provider call into that
`CONTROL_PLANE_ONLY` execution kind without first raising that DB-owned
ceiling through its own dedicated, equally rigorous review would mean the
server silently exceeding the governance layer's own admitted budget. This
checkpoint therefore builds the complete provider-neutral runtime as a
standalone, fully tested layer that is not yet called from
`executeProfessorRead`/`govern_professor_execution`. Composing the two,
together with the dedicated budget-raising migration that must come first,
remains the concrete next checkpoint.

### Capability/context construction: provider execution stays inside the active content release

`executeRoleCapability` (`src/server/academic-runtime/index.ts`) fails closed
with `ABSTAINED/NO_EXECUTION_PATH` for every role except PROFESSOR, before
touching delivery access, agent configuration or any capability call. TUTOR,
LAB_INSTRUCTOR, EXAMINER and COUNSELLOR have no bounded, server-owned
context-builder with correct provenance today — a placeholder entry in the
capability catalogue is never treated as a live execution path. For
PROFESSOR, the composition order is:

1. `requireStudentPrincipal()` — authenticated identity.
2. `getDeliveryAgentAccess({enrolmentId})` (the existing 2A institutional
   delivery lifecycle, `src/server/delivery.ts`) — the same check
   `getProfessorDeliveryContext` already performs. `CLOSED` (paused/
   withdrawn/completed enrolment) and `ACTIVITY_BLOCKED` (the controlled-
   assessment firewall) both abstain before config/capability/provider are
   ever touched.
3. `getAgentConfigForEnrolment` — the stored configuration; disabled
   aborts.
4. `isCapabilityAuthorized(role, capability, config.capabilities)` — **both**
   the code-owned catalogue **and** the stored configuration must
   independently permit the exact capability.
5. Escalation check (`ESCALATED` short-circuits before any capability call).
6. Runtime/model profile resolution (see below) — a missing/unknown profile
   aborts before any capability or provider call.
7. **`withValidatedProfessorContent({capability, input}, consume)`** — the
   existing `PROFESSOR_READ_V2` gateway's release-aware composition point
   (`src/server/academic-capabilities`), reused rather than duplicated, and
   rather than the simpler `invokeProfessorCapability` wrapper that returns
   only after the release has already closed. The gateway independently
   re-validates capability/input against that capability's own real schema,
   begins its own (and only) content-release lease, performs the actual
   Academy OS read, and — **only once that validated data exists and the
   release is still open** — invokes `consume({release, data})`. Provider
   execution (`runGovernedProviderExecution`) happens **inside that
   `consume` callback**: never after the release closes, and never through
   a second release. The caller's request may only supply the bounded
   selector fields (`enrolmentId`, and — only for the lesson-scoped
   capabilities — `lessonId`, or `objectiveId` for history) a named
   capability's own input schema actually defines; the composition boundary
   is a `z.strictObject` that rejects any other field outright, and a test
   proves an injected extra field is rejected rather than silently dropped.
8. After `consume` returns, the gateway (not this module) reruns its own
   final principal/activity recheck and then finalizes the release — exactly
   as it already does for every other composition point built on it. **Only
   after both of those succeed** does this module trust the `RuntimeResult`
   the callback captured; a `RuntimeProviderRequest` constructed on the
   PROFESSOR path is always built from the capability's own validated
   output (the callback's `data` parameter) — never the caller's raw input,
   never browser or course-package JSON. Concretely:
   - If `outcome.releaseFinalizationFailed` is true, or the gateway's final
     `outcome.result.ok` is false, **any already-captured provider output is
     discarded** and this module returns `ABSTAINED` (mapped to
     `ACTIVITY_BLOCKED` or `POLICY_BLOCKED` from the gateway's denial code) —
     regardless of whether the provider call inside `consume` had already
     succeeded.
   - If the gateway never called `consume` at all (capability/release denied
     before reaching it), the provider was never called — zero provider
     calls, by construction rather than by a separate check.
   - Timeout/cancellation during the provider call still uses
     `runGovernedProviderExecution`'s own total execution deadline
     (≤20s, see below), which fits inside the existing 30-second
     content-release lease (migration 021); this checkpoint does not change
     that lease's duration.

   `tests/academic-runtime-composition.test.ts`'s "finding #1" suite proves
   all of this against a mock of `withValidatedProfessorContent` that
   faithfully reproduces the real function's release-open → consume →
   release-close → final-result contract: the provider call happens strictly
   between the mocked release-open and release-close markers; a successful
   provider call is discarded (outcome is never `SUCCEEDED`) when the final
   result is `ok:false` even though the call happened; the same is true when
   `releaseFinalizationFailed` is true; a denial before `consume` leaves the
   adapter's call count at zero; and the context sent to the adapter
   contains only the mocked gateway's own `data`, never an injected field
   from the original request.

### Runtime/model profile resolution

`src/domain/academic-runtime-profile.ts` defines a `RuntimeProfile`: a
bounded `ref`, a provider-neutral `adapterKind` (`HTTP_JSON` or
`TEST_DETERMINISTIC`), and a `RuntimeBudgetPolicy`.
`src/server/academic-runtime/profile-registry.ts` is a **code-only**
registry — not a database table, not reachable from any course-package or
agent-configuration content. It ships **empty**: Commercial V1 has not made
a provider choice, so every `modelProfileRef` fails closed today regardless
of what is stored. A course/agent configuration's `modelProfileRef` is only
ever a lookup key; even a URL- or credential-shaped string stored there can
never itself become a provider endpoint, because the resolver only ever
checks registry membership (tested explicitly).

### Production dependency-injection lockdown is structural, not conventional

`executeRoleCapability(request)` — the production entrypoint — takes
**exactly one parameter**. There is no second "options"/"overrides" argument
through which any caller, production or otherwise, could pass a custom
adapter or profile resolver; it always wires `resolveRuntimeProfile` and
`resolveAdapterForProfile` (the real, code-owned registry) into an internal,
unexported `executeRoleCapabilityCore`. A separate, explicitly-named
`executeRoleCapabilityWithTestOverrides(request, overrides)` is the **only**
place dependency injection exists, and it refuses to run at all under
`NODE_ENV=production` — it throws before touching identity, delivery access,
the injected resolvers, or anything else — mirroring exactly how
`DeterministicFakeProviderAdapter` (`./test-fake-provider.ts`) already
refuses to construct in production. A test therefore cannot reach a
production-mode execution with an injected dependency even by calling the
test-only entrypoint directly; `tests/academic-runtime-production-safety.test.ts`
proves this by asserting the injected `resolveProfile`/`resolveAdapter`
functions are never invoked once `NODE_ENV=production` is set, that
`executeRoleCapability`'s declared arity is `1` (so no override parameter
exists to exploit), that normal production execution
(`executeRoleCapability`) consults only the real empty registry, and that
`DeterministicFakeProviderAdapter` itself still refuses to construct under
`NODE_ENV=production`.

### Provider adapter and endpoint hardening

`src/server/academic-runtime/provider.ts`'s `resolveConfiguredProvider()`
returns `null` (fail closed) unless both `ACADEMIC_PROVIDER_BASE_URL` and
`ACADEMIC_PROVIDER_API_KEY` are set server-side, the URL parses, uses
`https:`, and has no embedded userinfo credentials. No vendor SDK is
installed — a deliberate provider-neutral choice, not an oversight. The
adapter's own `fetch` call uses `redirect: "error"` so a 3xx response is
treated as a failure rather than silently replaying the bearer credential to
a second, unreviewed host; the credential is never logged or included in any
thrown error message (tested). It is not exercised against a live provider
by any test in this checkpoint.

### Runtime harness: admission, hard pre-call ceilings, and post-call reconciliation

`src/server/academic-runtime/runtime.ts`'s `runGovernedProviderExecution` is
explicit about which budget fields are **pre-call hard ceilings** (enforced
before any network call, because the server controls the request it is
about to send) and which are **post-call usage reconciliation** (knowable
only after a call returns, so a call may still happen even though it is
ultimately rejected):

- Pre-call: `maxProviderCalls`/`maxAttempts` admission, a byte-length ceiling
  on the serialised server-derived context (`maxInputContextBytes`, a
  measurable proxy for input size — no tokenizer is wired in), and a single
  **shared `totalDeadlineMs`** across every retry attempt — a retry only
  ever gets the time remaining in the original window, never a fresh one, so
  attempts can never multiply a nominal execution window (tested explicitly
  with a scenario that would exceed the deadline under a naive per-attempt
  timeout).
- Communicated-but-not-guaranteed: `maxOutputTokens` is sent to the adapter
  as the provider's requested generation ceiling (tested), and re-checked
  after the call as a safety net, because a provider is not guaranteed to
  honour it.
- Post-call reconciliation only: `maxEstimatedCostMicrousd` and the
  post-call output-token recheck above. Usage is always recorded even for a
  discarded, over-budget response — a `BUDGET_BLOCKED` result's `stage`
  field (`PRE_CALL`/`POST_CALL`) distinguishes "no call happened" from "a
  call happened and its usage is reconciled, not prevented." This layer has
  no durable database ledger; all accounting is in-memory, per-execution
  reconciliation, not a durable usage record.

`src/server/academic-runtime/test-fake-provider.ts` is a deterministic,
scripted adapter used **only** by tests. It refuses to construct when
`NODE_ENV==="production"`, and nothing in `resolveConfiguredProvider`,
`resolveAdapterForProfile` or any production path can return it.

### Test coverage

`tests/academic-runtime.test.ts` (pure, deterministic-adapter, no DB):
provider missing, success + usage accounting, the requested output-token
ceiling reaching the adapter, timeout, cancellation, retry-then-succeed,
non-retryable failure (no retry), retry exhaustion, pre-call zero-budget and
oversized-context admission blocks, post-call output-token and cost
reconciliation (with usage preserved), usage accumulation across a retried
attempt, and one shared deadline across retries.
`tests/academic-runtime-composition.test.ts` (mocked identity/delivery/
config/capability modules, via `executeRoleCapabilityWithTestOverrides`):
authentication-first ordering, rejection of an extra unreviewed request
field, `NO_EXECUTION_PATH` for every non-PROFESSOR role, `ACTIVITY_BLOCKED`/
`CLOSED` delivery-access abstention before config is ever read, disabled-role
and unrequested-capability abstention, a stored configuration's
out-of-catalogue capability never reaching the gateway, escalation
short-circuiting before the gateway, null/unknown/URL-shaped model-profile
fail-closed, and its dedicated "finding #1" suite proving provider execution
happens strictly between a mocked gateway's release-open and release-close
markers, that a successful provider call is discarded when the gateway's
final result is `ok:false` or `releaseFinalizationFailed` is true, that a
denial before the consumer callback leaves the provider call count at zero,
and that only the gateway's own validated data (never an injected request
field) reaches the provider. `tests/academic-runtime-production-safety.test.ts`
proves the dependency-injection lockdown: the test-only entrypoint works
normally outside production, refuses outright under `NODE_ENV=production`
before touching any injected dependency or even identity/delivery checks,
`executeRoleCapability`'s single-parameter arity leaves no override to
exploit, normal production execution still consults only the real empty
registry, and `DeterministicFakeProviderAdapter` itself refuses to construct
under `NODE_ENV=production`. `tests/academic-runtime-provider.test.ts` and
`tests/academic-runtime-profile-registry.test.ts` cover endpoint hardening
and profile resolution directly. `tests/course-package.test.ts`,
`tests/academic-agent-config.test.ts`, `tests/course-engineering-server.test.ts`
and `tests/course-engineering-workflow.test.ts` cover the package/agent-config
domain and the real migration 024 RPCs against PGlite, including the
service_role ACL-hardening suite, direct-RPC validation-forgery attempts
(including the dedicated "full COURSE_PACKAGE_V1 validation cannot be
bypassed" suite), package identity/content mismatch, and historical-metadata
preservation.

## Review corrections

Two rounds of independent review found nineteen findings in total across the
first two uncommitted passes of this checkpoint. All nineteen are resolved
in the repository as described throughout this document. The first sixteen
(round one) are listed below for the historical record; three further
findings from a second round are listed immediately after, since the round-one
fixes for findings 4 and 8 were themselves superseded by the round-two work
(arbitrary-input context construction was replaced again by the release-scoped
design below, and the narrower `assert_materializable` was joined by the
full-package `assert_full_package_valid` as the actual `VALIDATED` gate).

| #   | Finding                                                                                       | Fix                                                                                                                                                                                           |
| --- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `service_role` not explicitly hardened                                                        | Full migration rewrite: every table/schema/function revoked from `public,anon,authenticated,service_role`, column-level revokes, effective-ACL assertion block, new service_role-denial tests |
| 2   | Capability check only consulted stored config                                                 | `executeRoleCapability` now calls `isCapabilityAuthorized` (catalogue **and** config)                                                                                                         |
| 3   | No 2A lifecycle integration                                                                   | Replaced ad hoc activity check with `getDeliveryAgentAccess`; non-PROFESSOR roles fail closed with `NO_EXECUTION_PATH`                                                                        |
| 4   | Arbitrary caller JSON sent as provider context                                                | (Round 1) Context built from `invokeProfessorCapability`'s output; (Round 2, below) superseded by the release-scoped `withValidatedProfessorContent` design, context still never caller JSON  |
| 5   | `modelProfileRef` ignored                                                                     | New `academic-runtime-profile.ts` + code-only `profile-registry.ts`; null/unknown ref fails closed                                                                                            |
| 6   | Provider endpoint not hardened                                                                | HTTPS-only, userinfo rejection, `redirect:"error"`, no credential logging, all tested                                                                                                         |
| 7   | Post-call budget treated as a hard ceiling                                                    | `RuntimeBudgetPolicy` split into pre-call hard ceilings vs post-call reconciliation; `BUDGET_BLOCKED.stage`; one shared `totalDeadlineMs`                                                     |
| 8   | DB trusted a caller-supplied validation report                                                | (Round 1) `assert_materializable` called from both validate and apply; (Round 2, below) `mark_course_package_validated` now gated by the full-package `assert_full_package_valid` instead     |
| 9   | Content hash/identity were caller assertions                                                  | Hash is now `extensions.digest(raw_package::text,'sha256')`; key/revision/schemaVersion independently bound to embedded content                                                               |
| 10  | Two divergent capability-catalogue sources                                                    | Extracted `academic-capability-policy.ts`; both course-package and agent-config validation use it                                                                                             |
| 11  | Package `agentConfiguration` silently implied live authorization                              | Explicitly **not** auto-materialised; documented and reported as PARTIAL                                                                                                                      |
| 12  | `asValidatedCoursePackage` cast escape hatch                                                  | Removed; the validated package is reachable only via `validateCoursePackage`'s own success branch                                                                                             |
| 13  | Validation gaps (duplicate module/resource/activity keys/positions, duplicate refs, timezone) | Added; see "Package contract" above                                                                                                                                                           |
| 14  | Programme metadata mutated on re-apply                                                        | Reviewed against existing snapshot/freeze design; proven safe with an explicit test, documented                                                                                               |
| 15  | Retry/timeout correctness (shared deadline, accounting precision)                             | Rewritten `runGovernedProviderExecution`; explicit shared-deadline test                                                                                                                       |
| 16  | Documentation overstated what was implemented                                                 | This document rewritten throughout                                                                                                                                                            |

Round two:

| # (V2) | Finding                                                                                  | Fix                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------ | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1      | Provider execution happened only after the content release had already closed            | `executeRoleCapability` rebuilt on `withValidatedProfessorContent`: provider execution now runs **inside** the consumer callback while the release is open; a successful output is discarded if the gateway's final principal/activity recheck or release finalization fails                                                                                                                             |
| 2      | `assert_materializable` alone was insufficient for a truthful `VALIDATED` state          | New `course_engineering_private.assert_full_package_valid` independently re-verifies the **entire** stored `COURSE_PACKAGE_V1` (practical activities, assignment/assessment templates, scheduling defaults with real tzdata, all five agent roles); it is now the gate `mark_course_package_validated` calls; `assert_materializable` remains `apply_course_package`'s narrower defense-in-depth recheck |
| 3      | Test dependency overrides (`adapter`/`resolveProfile`) were reachable by convention only | Split into a production entrypoint (`executeRoleCapability`, no override parameter — structurally unreachable) and a separate test-only entrypoint (`executeRoleCapabilityWithTestOverrides`) that throws under `NODE_ENV=production` before touching any injected dependency                                                                                                                            |

## Known limitations and next exact action

- The DB-enforced zero-budget ceiling in migration 022 is unchanged. Real
  provider execution is therefore still architecturally blocked in
  production until a dedicated, separately reviewed migration raises that
  ceiling (a new `execution_kind`/policy version, with its own HMAC-protocol
  and admission review) and `executeRoleCapability`/`runGovernedProviderExecution`
  are composed into that RPC's RUNNING window. That composition — **not**
  started in this checkpoint — is the concrete next action.
- No provider was exercised against a live endpoint.
- Per-cohort materialisation of a package's assignment/assessment templates,
  and auto-materialisation of a package's `agentConfiguration` into
  `academic_agent_configs`, are not automated; both remain manual follow-ups
  through existing/separate RPCs.
- TUTOR/LAB_INSTRUCTOR/EXAMINER/COUNSELLOR have no independent server-owned
  execution path at all (not just "no capability enforcement") — every
  request for those roles fails closed with `NO_EXECUTION_PATH`.
- No durable usage-accounting ledger exists; runtime budget accounting is
  in-memory, per-execution reconciliation only.
- No React admin UI was added for course-package upload/preview/agent
  configuration; this checkpoint is the domain/server/persistence foundation,
  not the authoring UI.
- Hosted Supabase/JWT/PostgREST/RPC acceptance and true concurrent
  PostgreSQL acceptance for migration 024 remain outstanding, as for every
  prior migration in this repository.
