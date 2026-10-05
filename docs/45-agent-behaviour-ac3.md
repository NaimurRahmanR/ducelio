# AC-3: Minimum-data governed academic handoffs

AC-3 is the third checkpoint of the Agent / Model control and Governed Academic Agent Behaviour workstream (see [AC-1](43-agent-control-1.md) and [AC-2](44-agent-behaviour-ac2.md)). Branch `feat/ac3-academic-handoffs`, base `7a7d5b8842f9c8fb3c39df8aefb0df708a14dc5c` (AC-2 merged through PR #55). Migration `202610050052_professor_academic_handoffs.sql`; migrations 001–051 are unchanged.

**Status:** implemented and locally tested, uncommitted, awaiting independent review. Hosted acceptance of migration 052 has **not** run. **Not production-ready.**

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
6. **Objective (Tutor).** The objective must belong to the classroom's lesson and version. It must also have been in the source's governed teaching context. This is proven without parsing any prose:
   - the manifest shows the objectives release;
   - the AC-2 runtime refuses any lesson whose objective set exceeds one governed page (50) and otherwise sends the complete set;
   - published curriculum is immutable.

   So the objective was in context exactly when the lesson has at most 50 objectives. Otherwise: `OBJECTIVE_SCOPE_UNPROVEN`.

7. **Practical (Lab).** The practical must be a `PRACTICAL_LAB` of the classroom's lesson and version, activated for the learner's cohort. The handoff claims only that the learner asked for Lab help with it after the lesson, not that the Professor taught it.
8. **Idempotency.**
   - `unique(classroom_id, reason_code, scope_key)`: a repeated request returns `{duplicate: true}` with the same handoff and creates nothing.
   - The composed delivery handoff uses a deterministic request id (`md5` of policy, classroom, reason and scope), so migration 023's own `(requested_by, request_id)` identity is idempotent too.
   - At most 20 Professor follow-ups per classroom (`LIMIT_EXCEEDED`), on top of migration 023's existing limits.
9. The composed delivery handoff is re-read and must match the derived learner, enrolment, lesson, destination, reason and objective (`CONTEXT_CONFLICT` otherwise). Known governed refusals inside the composition are returned as codes, and everything inside is rolled back.
10. An audit event records identifiers and fixed codes only.

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

So versions already published before migration 052 stay exactly as in AC-2: their Tutor and Lab Instructor never receive a Professor record. A refused or malformed record read fails closed (`POLICY_BLOCKED`, no provider call).

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

PGlite is single-connection: the tests prove **sequential** replay idempotency only, not real multi-connection behaviour. A real PostgreSQL concurrency acceptance for this RPC has **not** run.

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

**Mutation checks.** Removing the `SUCCEEDED` source requirement, or the consumption firewall, makes the corresponding DB tests fail.

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
- Tutor/Lab versions published before migration 052 (pinned V1) never receive a Professor record. This is deliberate, and needs a new programme version to change.
- The transcript retention policy is decided but not enforced (section 8).
- Hosted acceptance of migration 052 has not run: ACL, JWT/PostgREST, real multi-connection concurrency, browser and accessibility.

## 14. Hosted versus local

Everything above is local evidence: PGlite with the full migration chain, plus unit and UI tests. The dedicated hosted acceptance database is at migration 051; migration 052 has not been deployed or accepted there.

## 15. Next checkpoint

AC-4: Tutor class notes (supplementary, versioned, provenance-bound and firewall-respecting; never overwriting published curriculum). Not started.
