# AC-3: Minimum-data governed academic handoffs

AC-3 is the third checkpoint of the Agent / Model control and Governed Academic Agent Behaviour workstream (see [AC-1](43-agent-control-1.md) and [AC-2](44-agent-behaviour-ac2.md)). Branch `feat/ac3-academic-handoffs`, base `7a7d5b8842f9c8fb3c39df8aefb0df708a14dc5c` (AC-2 merged through PR #55). Migration `202610050052_professor_academic_handoffs.sql`; migrations 001–051 are unchanged.

**Status:** the AC-3 implementation and its independent-review correction (section 16) passed independent review and were merged through PR #56 (merge `0d52fa6`). Migration 052 is deployed to the dedicated hosted acceptance database (section 14). The AC-3 hosted concurrency scenario is implemented but **not yet run** (section 10). **Not production-ready.**

AC-3 adds exactly one thing: the smallest safe route by which a learner's successful Professor classroom interaction can produce a reviewed, minimum-data academic handoff to the Tutor or Lab Instructor. It is the **only** governed route by which the Tutor or Lab Instructor can learn that a Professor lesson happened, and what bounded academic scope the learner asked them to follow up. The classroom transcript is never shared.

## 1. Threat and authority model

| Actor                                           | May                                                                                                                                                   | May not                                                                                                                                                       |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Learner (authenticated STUDENT)                 | Ask for a follow-up from their own classroom, choosing one of two reviewed reasons and one objective or lab practical of that lesson. See the result. | Choose the destination, summary, source execution, provenance, lesson, enrolment or version. Write free text. Act on another learner's classroom.             |
| Professor model/provider                        | Nothing. It is never involved in creating a handoff.                                                                                                  | Insert, choose or word a handoff. Its output never enters a handoff.                                                                                          |
| Browser                                         | Submit the closed form (`classSessionId`, `reasonCode`, `objectiveId` or `practicalId`).                                                              | Forge Professor provenance, substitute IDs across learners or enrolments, or supply any other field (extra form fields are ignored).                          |
| Database (`request_professor_academic_handoff`) | Derive learner, classroom, enrolment, version, lesson and the source Professor execution; verify scope; compose the existing learner handoff RPC.     | —                                                                                                                                                             |
| Tutor / Lab runtime                             | Read the projection for its **own ACTIVE** content release of that exact delivery handoff, while the firewall allows explanation.                     | Read any other learner's, release's or destination's projection; read the transcript; treat the record as mastery, evidence, a grade, progress or completion. |
| Admin / staff / Sarah / Counsellor              | Nothing new. The projection table has no client privileges; no admin editor exists.                                                                   | Read the Professor transcript (unchanged since AC-2).                                                                                                         |

No AI actor receives database credentials, and there is no service-role path.

## 2. Architecture decision

The learner delivery handoff contract (migrations 023, 028 and 043) has fixed semantics: learner-requested, `status = 'OPEN'`, immutable, and consumed by the Tutor/Lab execution authority (migration 028). AC-3 does **not** alter it, and does not turn it into an agent-to-agent message bus.

Instead it repeats the exact pattern migration 028 already uses for practicals:

1. `public.request_professor_academic_handoff` **composes** the unmodified `request_delivery_handoff` (Tutor, `OBJECTIVE_REINFORCEMENT`) or `request_practical_support` (Lab Instructor, `PRACTICAL_HELP`).
   - Every existing ownership, firewall, limit, idempotency and Tutor/Lab execution rule therefore applies unchanged.
   - The resulting delivery handoff is an ordinary learner handoff (`provenance = 'LEARNER_REQUEST'`, its own fixed summary). The learner does request it, from their own classroom.
2. An additive, immutable link row in `public.professor_academic_handoffs` records the minimum Professor projection for that delivery handoff (1:1).
3. A release-scoped read gives the Tutor/Lab runtime the projection.

Alternatives rejected:

- **Extending `delivery_handoffs`.** Its CHECKs and immutability trigger would have to change, and historical learner-handoff semantics would blur.
- **A generic handoff bus.** Out of scope, and anticipates Sarah (AC-5+).

## 3. Minimum projection (`professor_academic_handoffs`)

| Column                                                  | Meaning                                                                     |
| ------------------------------------------------------- | --------------------------------------------------------------------------- |
| `id`                                                    | Immutable projection id.                                                    |
| `handoff_policy`                                        | `PROFESSOR_ACADEMIC_HANDOFF_V1`.                                            |
| `handoff_id`                                            | The ordinary learner delivery handoff (unique, 1:1).                        |
| `student_id`, `enrolment_id`, `programme_version_id`    | Derived from the learner's classroom.                                       |
| `classroom_id`, `class_session_id`, `lesson_id`         | Derived from the learner's classroom.                                       |
| `objective_id` / `practical_id`                         | Exactly one, verified to belong to that lesson and version (see section 4). |
| `source_role`                                           | `PROFESSOR`.                                                                |
| `destination_role`                                      | `TUTOR` or `LAB_INSTRUCTOR`, fixed by the reason (CHECK).                   |
| `reason_code`                                           | `OBJECTIVE_REINFORCEMENT` (Tutor) or `PRACTICAL_HELP` (Lab Instructor).     |
| `source_professor_execution_id`, `source_provenance_id` | The verified source execution and its AC-2 provenance row.                  |
| `summary`                                               | One of two fixed, code-owned sentences, pinned by a CHECK.                  |
| `scope_key`                                             | `OBJECTIVE:<id>` or `PRACTICAL:<id>` (CHECK), for idempotency.              |
| `created_at`                                            | Database clock.                                                             |

There is no transcript, learner question, Professor answer, provider output, prompt, hidden reasoning, provider payload, support or counsellor prose, protected-assessment content, psychological inference, model-generated summary, mastery claim, grade, or progress/completion claim. A test proves the column list, and proves that classroom-turn sentinels never reach the projection, the delivery handoff or the audit row.

**Reason vocabulary.** Two codes only, both already consumable by the existing Tutor/Lab authority. `MISSED_LESSON_PRACTICE` does not fit an attended lesson, and `PRACTICAL_PREREQUISITE` (exercises) is left to the existing practical flow.

## 4. Creation path

`request_professor_academic_handoff(p_class_session_id, p_reason_code, p_objective_id, p_practical_id)`, SECURITY DEFINER with `search_path = ''`:

1. STUDENT only. The input shape is exactly one reviewed reason with its one matching scope, otherwise `INVALID_INPUT`. There is no summary, destination, execution or provenance parameter.
2. The learner's own classroom row is locked `FOR UPDATE`. This serialises concurrent requests for that classroom. If the classroom is not the learner's: `NOT_FOUND_OR_FORBIDDEN`.
3. Controlled-assessment firewall: `ACTIVITY_BLOCKED` when explanation is not allowed.
4. The enrolment must be the learner's own and match the classroom's enrolment and version.
5. **Source.** The learner's most recent `SUCCEEDED` Professor execution whose AC-2 provenance (database-derived) names this classroom, enrolment and version, and whose attested context-release manifest includes `get_lesson_objectives`. Otherwise `NO_SOURCE_EXECUTION`. A FAILED, ABSTAINED, other-role or non-classroom execution can never be a source, and the caller cannot name one.
6. **Objective (Tutor).** The objective must belong to the classroom's lesson and version. It must also have been in the source's governed teaching context. This rests on existing authoritative facts, not on parsing any prose:
   - the AC-2 attested manifest proves that `get_lesson_objectives` participated in the source execution;
   - the source execution's provenance is attested to the learner's own governed classroom, whose lesson the database derived;
   - the trusted Professor runtime uses that classroom's server-derived lesson for its governed reads, refuses any lesson whose objective set exceeds one governed page (50), and otherwise sends the complete set;
   - published curriculum is immutable.

   So, given that trusted-runtime invariant, the objective was in context exactly when the lesson has at most 50 objectives. Otherwise: `OBJECTIVE_SCOPE_UNPROVEN`.

   This is **not** proven by `academic_content_releases` alone. Legacy content-release rows carry no lesson selector, which remains an AC-2 limitation. The lesson identity of the objectives read rests on the attested classroom provenance plus the trusted runtime's server-derived lesson.

7. **Practical (Lab).** The practical must be a `PRACTICAL_LAB` of the classroom's lesson and version, activated for the learner's cohort. The handoff claims only that the learner asked for Lab help with it after the lesson, not that the Professor taught it.
8. **Destination behaviour gate.** The destination role's role behaviour version is read from the programme version's **frozen** AC-2 binding, through AC-2's own resolver (`agent_behaviour_private.effective_behaviour`, which for a bound version reads only the verified binding, never the live or current version). It must be exactly the AC-3-aware version: `TUTOR_BEHAVIOUR_V2` for the Tutor, or `LAB_INSTRUCTOR_BEHAVIOUR_V2` for the Lab Instructor.
   - A missing, invalid or V1 binding is refused with `DESTINATION_BEHAVIOUR_UNSUPPORTED` before any delivery handoff is composed. Neither a delivery handoff nor a projection is written, and there is no fallback to an ordinary handoff.
   - The learner sees "Professor follow-up is not available for this course version." No behaviour version is named.
9. **Idempotency.**
   - `unique(classroom_id, reason_code, scope_key)`: a repeated request returns `{duplicate: true}` with the same handoff and creates nothing.
   - The composed delivery handoff uses a deterministic request id (`md5` of policy, classroom, reason and scope), so migration 023's own `(requested_by, request_id)` identity is idempotent too.
   - At most 20 Professor follow-ups per classroom (`LIMIT_EXCEEDED`), on top of migration 023's existing limits.
10. The composed delivery handoff is re-read and must match the derived learner, enrolment, lesson, destination, reason and objective (`CONTEXT_CONFLICT` otherwise). Known governed refusals inside the composition are returned as codes, and everything inside is rolled back.
11. An audit event records identifiers and fixed codes only.

The projection is immutable: `PROFESSOR_HANDOFF_IMMUTABLE` on any update or delete.

## 5. Tutor and Lab consumption

`get_professor_academic_handoff_for_release(p_release_id)` returns the projection only when:

- the release is the caller's own, `ACTIVE` and unexpired;
- the firewall allows explanation;
- the projection belongs to that release's delivery handoff;
- its destination, enrolment, lesson, objective and (for Lab) practical agree with the release.

It returns `{available: false}` for an ordinary learner handoff and `CONTEXT_CONFLICT` on any disagreement (an owner-forged cross-destination row is tested). The provider receives no identifiers; the Tutor/Lab context already names the lesson, objective or practical from the same release.

**Level 2 versioning.** AC-2 pins each programme version's role behaviour version at publication. `TUTOR_BEHAVIOUR_V1` literally states that no Professor record exists, so its text is never edited (a test pins the V1 hashes to the AC-2 merge). Migration 052 and `src/domain/agent-behaviour.ts` add:

- `TUTOR_BEHAVIOUR_V2`: V1 with that one rule replaced;
- `LAB_INSTRUCTOR_BEHAVIOUR_V2`: V1 plus one rule.

The new rule says:

> professorTeachingRecord is Ducelio's only governed record of Professor teaching … it is not a transcript, not mastery, not evidence, not a grade, not completion and not proof that the learner understood anything. Never claim to know what the Professor explained, said or concluded beyond those fields.

New publications freeze V2 for the Tutor and Lab Instructor (the Professor stays V1). The record is read and supplied **only** when the pinned version is V2-aware:

| Pinned version | Professor handoff exists | Provider context                                                                                                                        |
| -------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Tutor V1       | any                      | `professorTeachingRecord: {available: false, reason: NO_GOVERNED_PROFESSOR_TEACHING_RECORD}` (AC-2, unchanged; not even read)           |
| Tutor V2       | no                       | the same unavailable shape                                                                                                              |
| Tutor V2       | yes                      | `{available: true, authority: NON_AUTHORITATIVE_TEACHING_CONTINUITY, policy, sourceRole, reasonCode, scope, summary, recordedAt, note}` |
| Lab V1         | any                      | no `professorTeachingRecord` field (AC-2, unchanged)                                                                                    |
| Lab V2         | no / yes                 | unavailable shape / the same bounded record                                                                                             |

So versions already published before migration 052 stay exactly as in AC-2: their Tutor and Lab Instructor never receive a Professor record.

**AC-3 Professor-specific handoff creation is available only when the destination role's frozen programme-version binding is the AC-3-aware V2** (section 4, step 8). Older V1 programme versions remain fully AC-2-compatible: their learners can still use the ordinary learner Tutor/Lab handoff flows, but cannot create an AC-3 Professor-specific continuity handoff. **A new programme version is required to gain AC-3 Professor continuity.**

A refused or malformed record read fails closed (`POLICY_BLOCKED`, no provider call).

## 6. Learner visibility

The classroom page adds one card, "Follow up with Tutor or Lab".

- It contains a disclosure: "Only this is shared: that you asked for this follow-up after a Professor lesson, the lesson, and the objective or practical you choose. Your conversation with the Professor is not shared, and this is not a mark, progress or mastery record."
- There are two closed forms: an objective select (Tutor) and a lesson lab-practical select (Lab Instructor). There is no free text, role, summary or provenance field.
- It lists the learner's follow-ups from this classroom through `list_my_professor_academic_handoffs`, which is owner-only and firewall-gated. The list shows destination, objective or practical, the fixed summary, lesson title and request time, with the existing Tutor/Lab support panel to continue.

Execution IDs, provenance hashes, HMAC details and provider internals are not shown. The learner's own delivery handoff id is used only as a hidden form value; migration 023's own learner list already returns it. The existing note under the transcript now also says it is not shared with the Tutor or Lab Instructor.

## 7. Transcript non-sharing rule

`professor_classroom_turns` remains readable only by the owning learner (`list_my_professor_classroom_turns`, AC-2), firewall-gated. AC-3 adds no read path to the transcript for any role. The projection references the source execution, never a turn, and copies no turn text.

## 8. Professor classroom memory: retention and deletion policy (decision)

**Reviewed policy:**

1. **Status.** `professor_classroom_turns` is non-authoritative, learner-visible continuity memory. It is never a record of teaching, evidence, mastery, progress, attendance or completion. No role other than the owning learner gains access, and AC-3 does not change that.
2. **Retention.** Transcript text must not be kept indefinitely in production. It is retained only while it serves the learning relationship, and is deleted at the **earlier** of:
   - 12 months after the classroom's class session was scheduled to end;
   - 90 days after the enrolment leaves `ACTIVE`.
3. **What deletion removes.** Only the turn rows (learner message and Professor message text).
4. **What deletion never removes.** The immutable institutional metadata:
   - Professor execution rows and usage;
   - AC-2 execution provenance and the context-release manifest;
   - AC-3 `professor_academic_handoffs` and their delivery handoffs (which contain no prose);
   - audit events.

   Deleting non-authoritative text never weakens institutional audit history.

5. **After deletion.** AC-2 continuity derivation reports the missing exchanges as unrecorded, so a later Professor turn in that classroom is told its memory is `DEGRADED`. It is never silently treated as complete.
6. **Who may delete.** No browser, learner, instructor or admin RPC may delete turns. Purging must be a dedicated, narrowly scoped and audited server/operator mechanism that removes only eligible rows under the table's immutability guard.

**Deferred.** The purge scheduler or operator mechanism is **not implemented** in AC-3. It needs a governed operations lifecycle (scheduling, operator identity, audit and backup interaction) wider than this checkpoint. AC-3 therefore adds **no** delete RPC. Until the mechanism exists, transcripts are retained, which is a **production blocker** recorded in the progress file.

## 9. Lab timing decision

AC-3 does **not** invent Lab timing. No Professor or learner handoff is linked to an authoritative Academy OS lab session, so the Lab Instructor context keeps `sessionTiming: {available: false, reason: NO_AUTHORITATIVE_LAB_SESSION, remainingMinutes: null}` for V1 and V2. Real Lab timing remains a later, explicitly governed capability. No countdown is shown or implied.

## 10. Concurrency and idempotency

- The classroom row lock (`FOR UPDATE`) serialises concurrent requests for one classroom before the idempotency check and insert.
- The unique `(classroom_id, reason_code, scope_key)` and the unique `handoff_id` are the database backstops.
- Migration 023's `(requested_by, request_id)` identity, with the deterministic request id, prevents a duplicate delivery handoff.

PGlite is single-connection: the tests prove **sequential** replay idempotency only, not real multi-connection behaviour.

### Hosted concurrency acceptance scenario (implemented; not yet run)

`POSTGRES_CONCURRENCY:AC3_PROFESSOR_HANDOFF_DUPLICATE` (`scripts/acceptance/ac3-handoff-race.mjs`). It is run by `npm run acceptance:concurrency` after, and reported separately from, the Commercial V1 scenarios, or alone with `node --env-file-if-exists=.env.local scripts/acceptance/ac3-handoff-race.mjs`. It is separate from the Commercial V1 scenarios, which prove nothing about AC-3.

- **Race.** Two genuinely independent PostgreSQL connections (`connectMany(2)`), whose distinct `pg_backend_pid()` values are part of the PASS evidence. Each is write-gated (`assertAllAcceptanceDatabaseWriteAuthorized`) and fully prepared. Both are then released from one start gate to call the real `public.request_professor_academic_handoff` for the same learner, classroom, `OBJECTIVE_REINFORCEMENT` and objective.
- **PASS requires all of:**
  - one `{ok:true, duplicate:false}` and one `{ok:true, duplicate:true}` with the same `handoffId`;
  - exactly one `professor_academic_handoffs` row for the classroom/reason/scope, with the expected destination, reason, scope and source execution;
  - exactly one matching `delivery_handoffs` row, with the same id, created since the race started.
- **Verdicts.** Anything else, including an unexpected RPC result or a database/network error, is FAIL. Missing write authorization, or an authenticated learner context that cannot be established, is BLOCKED, never bypassed.
- **Authentication.** There is no service-role path. On each connection, inside its own transaction:
  - set Supabase's standard request-JWT GUCs locally (`request.jwt.claims` with `sub/role/aud`, plus `request.jwt.claim.sub/role`), which hosted `auth.uid()` reads;
  - `SET LOCAL ROLE authenticated`;
  - verify `current_user = 'authenticated'` and that `current_app_user()` equals the learner's `app_users` id, resolved from their real hosted Supabase Auth identity (never hardcoded).

  The RPC therefore runs under `authenticated`'s own grants and its SECURITY DEFINER boundary. If the acceptance database role is not a member of `authenticated`, the role switch is refused, or the identity does not resolve, the scenario is BLOCKED.

  This proves two independent hosted PostgreSQL sessions acting under the database's `authenticated`-role semantics for the real acceptance learner subject, calling the real governed RPC, and real PostgreSQL locking and idempotency. It does **not** prove Supabase JWT signature or expiry validation, or PostgREST token enforcement; that remains separate acceptance evidence (JWT_POSTGREST, currently BLOCKED).

- **Fixture (setup, not evidence).**
  - The post-052 course, cohort and enrolment come from the existing governed `seedAcceptanceCourse` pipeline. The scenario verifies that the frozen Tutor binding is `TUTOR_BEHAVIOUR_V2`, and is BLOCKED otherwise.
  - The class session is created through the governed `create_class_session` RPC (a unique past window), and the classroom through the learner's own `open_professor_classroom`.
  - The SUCCEEDED Professor execution, its two COMPLETED content releases, its AC-2 provenance and its context manifest are **seeded directly** in one write-gated transaction, because the attested V2 path needs the controller HMAC key. Every derivable value is derived by the database's own AC-2 functions in that insert. This is **not** evidence that any Professor HMAC execution was accepted.
  - Those tables' AFTER INSERT audit triggers record the seeded rows with their fixed source labels. The rows are identifiable through this run's unique cohort and class session, and nothing is deleted.
- **Local evidence (not concurrency).**
  - `tests/acceptance-ac3-handoff-race.test.ts` (25) covers orchestration and verdicts against in-memory stand-in connections.
  - `tests/acceptance-ac3-handoff-race-db.test.ts` (2) runs the scenario's **real** seed SQL, authenticated-context SQL, RPC call and verification reads against the real migration chain in PGlite, **sequentially** on one connection.
- **Status.** The hosted result is **not yet available**, and this document will record it only after a real hosted run.

## 11. Local evidence

New suites:

- **`professor-academic-handoff-db` (19, real migration chain).**
  - Creation: owner Tutor and Lab creation; exercise and unknown practical refused; sequential idempotency; foreign learner refused; no source, or only a FAILED source, refused; foreign or unknown objective refused; reason and scope shape plus the exact RPC signature (no summary parameter).
  - Storage: no free text (column list, transcript sentinels absent, a non-fixed summary refused by CHECK).
  - Firewall: creation and listing refused during a controlled assessment.
  - Visibility: exact learner projection keys; a foreign learner sees nothing.
  - Consumption: Tutor and Lab release records; ordinary handoffs report unavailable; foreign learner, closed release and a forged cross-destination row refused; firewall refusal on an open release.
  - Authority: immutability and ACL; no mastery, evidence, progress or attendance rows created; ordinary learner handoffs still work and list Professor ones as `LEARNER_REQUEST`; a version published after 052 freezes Tutor and Lab V2.
- **`professor-academic-handoff` (20).**
  - Server input: strict server input (free-text summary, chosen destination, source execution, unreviewed reason and both/missing scope refused before any database call).
  - Server results: refusal and malformed-result mapping; record and list schema strictness (non-fixed summary, extra transcript field, mismatched destination).
  - Server Action: forwards only the allowed fields and gives bounded learner copy.
  - Learner UI: disclosure, only four form field names, no textarea, approved list fields, hidden handoff id.

Extended suites:

- **`agent-behaviour-contract`:** V1 hashes pinned to the AC-2 merge; V2 differs only by the record rule; the 052 database mirrors equal the code.
- **`tutor-lab-provider-context`:** the V1/V2 × record matrix and cross-destination.
- **`tutor-lab-execution-runtime`:** V2 receives the record; V1 never reads it; a refused read fails closed.
- **`agent-behaviour-db` and `tutor-lab-execution-db`:** assertions for versions published after 052 now expect the V2 Tutor/Lab version (no assertion weakened); test G's simulated "later" deployment moved to V3.

**Mutation checks.** Removing the `SUCCEEDED` source requirement, the consumption firewall, or (correction) the destination behaviour gate makes the corresponding DB tests fail.

**Gates (local).**

- Focused AC-3 set: 10 files, 261/261.
- `npm run check`: 3,830/3,830 across 155 files, exit 0.
- `npm run build` passed.
- `npm run format:check` is clean.
- `npm audit --omit=dev` reports 0 vulnerabilities.
- `git diff --check HEAD` is clean; the untracked new files were checked separately for trailing whitespace.

## 12. Not implemented (and not claimed)

- Sarah, Professor → Sarah weak areas, Counsellor handoffs and any generic handoff bus.
- Tutor class notes (AC-4).
- Lab session timing.
- A transcript purge mechanism.
- Admin handoff editors.
- Any use of a handoff as mastery, evidence, a grade, progress or completion.
- Learner-to-Professor handoffs, or Tutor/Lab → Professor handoffs.
- Live-provider evaluation of the V2 Tutor/Lab behaviour.

## 13. Known limitations

- Objective follow-ups for lessons with more than 50 objectives are refused (`OBJECTIVE_SCOPE_UNPROVEN`), consistent with AC-2's Professor refusal.
- The classroom page finds lab practicals by paging the learner's governed practical list up to 10 pages (200 practicals); a lab beyond that cannot be chosen there. The database still re-verifies any chosen practical.
- The source is the classroom's most recent qualifying execution. The record states only that a Professor lesson took place and what the learner asked for, not which exchange.
- Tutor/Lab versions published before migration 052 (pinned V1) never receive a Professor record and cannot create a Professor follow-up (`DESTINATION_BEHAVIOUR_UNSUPPORTED`). This is deliberate, and needs a new programme version to change.
- The transcript retention policy is decided but not enforced (section 8).
- Hosted acceptance of migration 052 has not run: ACL, JWT/PostgREST, real multi-connection concurrency, browser and accessibility.

## 14. Hosted versus local

Everything above is local evidence: PGlite with the full migration chain, plus unit and UI tests. After the merge (PR #56), migration 052 was deployed to the dedicated hosted acceptance database. The operator-reported acceptance after deployment:

- HOSTED_DATABASE PASS (PostgreSQL 17.6);
- MIGRATIONS PASS through 052;
- RLS_ACL PASS (existing sample);
- 0 FAIL;
- JWT_POSTGREST BLOCKED (no expired learner JWT).

The AC-3 hosted concurrency scenario (section 10) has not yet been run.

## 15. Next checkpoint

AC-4: Tutor class notes (supplementary, versioned, provenance-bound and firewall-respecting; never overwriting published curriculum). Not started.

## 16. Independent-review correction: destination behaviour gate

**Blocker.** A Professor follow-up could be created for a programme version whose destination role is pinned to `TUTOR_BEHAVIOUR_V1` or `LAB_INSTRUCTOR_BEHAVIOUR_V1`, whose runtime deliberately never reads the Professor record. That contradicted the learner disclosure.

**Fix (smallest, no redesign).**

- **Database (authoritative).** `request_professor_academic_handoff` derives the destination from the reviewed reason, then requires that destination's frozen AC-2 binding to be the exact AC-3-aware V2 (section 4, step 8). Otherwise it returns `DESTINATION_BEHAVIOUR_UNSUPPORTED` before composing any delivery handoff.
- **Domain and server.** The new refusal code is in the strict TypeScript contract and maps to "Professor follow-up is not available for this course version."
- **UI (presentation only).** The classroom page uses the existing learner-scoped `get_agent_behaviour_for_enrolment` read: the frozen binding's pinned version for the learner's own enrolment. It offers a follow-up form only for a destination that can receive the record, and otherwise shows the unsupported message. The database gate applies regardless.
- **Docs.** The objective-scope wording now states precisely what proves what (section 4, step 6).

**Tests.**

- New **`professor-academic-handoff-v1-db` (5, real migration chain).**
  - The version is published through the real publication trigger while the database runs migration 051's own role-version definition (read from that file), then restored. It is genuinely frozen on Tutor/Lab V1, with a verified binding and a real SUCCEEDED provenance-bound Professor execution.
  - `OBJECTIVE_REINFORCEMENT` and `PRACTICAL_HELP` are both refused with `DESTINATION_BEHAVIOUR_UNSUPPORTED`. No `delivery_handoffs` or `professor_academic_handoffs` row is created.
  - The ordinary learner `request_delivery_handoff` and `request_practical_support` still work for that version, and the Tutor/Lab authority still opens releases for them.
  - The learner-scoped read reports V1, which the page uses to hide the form.
- `professor-academic-handoff-db` gains 1 (20): a missing Tutor binding and a corrupt Lab binding digest are both refused before any write, while the verified destination still works. The existing post-052 tests (V2 pins, valid handoffs) are unchanged.
- `professor-academic-handoff` gains 2 (22): the learner-safe refusal mapping (no version internals, no revalidation), and the UI hiding unsupported destinations and showing the unsupported message.
- **Mutation check.** Removing the gate makes both V1 refusal tests fail.

**Gates after the correction (local).**

- Focused set: 11 files, 269/269.
- `npm run check`: 3,838/3,838 across 156 files, exit 0.
- `npm run build` passed.
- `npm run format:check` is clean.
- `npm audit --omit=dev` reports 0 vulnerabilities.
- `git diff --check HEAD` is clean.
