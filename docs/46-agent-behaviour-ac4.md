# AC-4: Supplementary, versioned Tutor class notes

AC-4 is the fourth checkpoint of the Agent / Model control and Governed Academic Agent Behaviour workstream (see [AC-1](43-agent-control-1.md), [AC-2](44-agent-behaviour-ac2.md) and [AC-3](45-agent-behaviour-ac3.md)). Branch `feat/ac4-tutor-class-notes`, base `1e8237353ee5b961764875952b41088c658c3468` (AC-3 and its hosted concurrency acceptance merged through PR #57). Migration `202610060053_tutor_class_notes.sql`; migrations 001–052 are unchanged.

**Status:** independently reviewed twice (corrections in section 20), CI green, and merged through PR #58 (merge `6845a59a8f6f951d55162e0f834d912b4743cfa9`). Migration 053 has **not** been deployed to hosted acceptance, and its hosted and concurrency work is tracked separately (section 17). **Not production-ready.**

The approved definition (AC-1 section 7): _Tutor class notes. Supplementary, versioned class notes with provenance and the protected-content firewall. They never overwrite published curriculum and are never stored in `learning_resources`._

## 1. Creation semantic (decision)

A Tutor class note is **a Tutor support answer the learner chose, before sending the request, to keep**.

The existing Tutor experience (migration 028) never persists Tutor or Lab output: the learner sees the answer once, and only identifiers, states and usage are stored. Three options were considered:

| Option                                                                           | Verdict                                                                                                                                                                                        |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every SUCCEEDED Tutor answer automatically becomes a permanent note              | Rejected. It would silently start persisting all Tutor output, which 028 deliberately does not do.                                                                                             |
| "Save as note" after seeing the answer                                           | Rejected. The server no longer holds the answer, so the browser would have to send the text back. That text cannot be trusted as Tutor output.                                                 |
| **Opt-in on the request; the server keeps its own copy of the confirmed output** | **Chosen.** The learner's intent is explicit, and the body comes only from the trusted server's copy of the provider output. No second provider call is made, and no browser text is accepted. |

The opt-in is one checkbox on the existing Tutor support panel: "Keep this Tutor answer as a supplementary Tutor note (not course material)". It is a boolean (`saveAsClassNote`) on the strict request schema. It is shown only for the Tutor, never for the Lab Instructor.

## 2. Authority chain

No authoritative Tutor class session exists in the repository, and none is invented. The narrowest real authority is used:

learner → TUTOR delivery handoff (023/028/043) → COMPLETED Tutor content release → SUCCEEDED Tutor provider execution → AC-2 execution provenance → the programme version's frozen AC-2 behaviour binding.

The series (the note's logical identity) is the **Tutor delivery handoff**: the learner's own support topic, which fixes enrolment, programme version, lesson, reason and (for objective reinforcement) the objective.

## 3. Creation point and trust boundary

The **only** creation point is the end of `executeTutorLabSupport` (`src/server/tutor-lab-execution/index.ts`). It is reached only when all of these hold:

1. the content release closed `COMPLETED` (the release-close firewall recheck passed);
2. `FINALIZE` was confirmed `SUCCEEDED` by the database;
3. the release role is `TUTOR`;
4. the learner asked beforehand.

The body is exactly the learner-visible answer returned in the same result. The execution id is the server's own (it never leaves the server). A note that cannot be kept never changes the confirmed answer; the learner is told why.

`recordTutorClassNote` (`src/server/tutor-class-notes.ts`) is the trusted controller write. It calls `public.record_tutor_class_note`, attested under a **new** protocol tag with the **existing** controller key store (migration 022, via AC-2's `agent_behaviour_private.verify_mac`, same 10-second freshness window and constant-time comparison):

```
DUCELIO_TUTOR_CLASS_NOTE_HMAC_SHA256_V1
TUTOR
key_id / actor / execution_id
sha256_hex(body)
issued_at_epoch_seconds / expires_at_epoch_seconds
```

No existing canonical message (022/025/028/031/032/040/051) changed. A Professor, Tutor/Lab execution, provenance or classroom-turn attestation cannot authorize a note, and a note attestation cannot authorize anything else (tested: a classroom-turn tag is refused).

The browser cannot choose the source execution, provenance, learner, enrolment, programme version, lesson, role, behaviour version, runtime profile, provider, model or body. Extra form fields are ignored (tested).

## 4. Database verification (`record_tutor_class_note`)

SECURITY DEFINER, `search_path = ''`. In order:

1. STUDENT only. Body 1–8,000 characters with a non-space character, else `INVALID_INPUT`.
2. MAC over the body's SHA-256 (`ATTESTATION_INVALID`).
3. **Learner-profile row lock** (`student_profiles … FOR UPDATE`; `FORBIDDEN` if the profile is missing), before any firewall- or enrolment-dependent decision. This is migration 021's firewall locking contract (section 7).
4. The execution must be the caller's own (`NOT_FOUND_OR_FORBIDDEN`), `agent_profile = 'TUTOR'`, `state = 'SUCCEEDED'` and `reason_code = 'PROVIDER_COMPLETE'` (`SOURCE_NOT_ELIGIBLE`). A Lab Instructor, FAILED, ABSTAINED, ESCALATED, BUDGET_BLOCKED, TIMEOUT/`EXECUTION_TIMEOUT`, CANCELLED, BLOCKED or still-running execution is refused. A Professor execution lives in a different table and is never found.
5. Its release must be the caller's own, TUTOR, and `COMPLETED` (`SOURCE_NOT_ELIGIBLE`).
6. The handoff must be the caller's own TUTOR handoff with a Tutor reason. The enrolment row is loaded **`FOR UPDATE`** (after the profile lock), so a concurrent status transition cannot race the check. Release and handoff must agree on enrolment, lesson and objective. The lesson and objective must belong to the enrolment's programme version (`CONTEXT_CONFLICT`). The enrolment must be `ACTIVE` (`ENROLMENT_NOT_ACTIVE`).
7. The AC-2 provenance row must exist (`PROVENANCE_INVALID`). It must name `TUTOR_LAB_PROVIDER_V1`, TUTOR, the same learner, enrolment and version, and no classroom. It must equal the version's **frozen** binding through AC-2's own resolver: pinned behaviour version, config source/version/id, behaviour fingerprint, runtime profile ref and the Level-1 baseline mirror (`PROVENANCE_MISMATCH`). The existing provenance universe is reused; no second provenance system exists.
8. **Final firewall recheck** at the write boundary (`ACTIVITY_BLOCKED`). Nothing is written: no body, no series, no denial receipt and no audit row (tested).
9. The series is created (`insert … on conflict (handoff_id) do nothing`) and then locked `FOR UPDATE`. Series identity must agree with the derived scope (`CONTEXT_CONFLICT`).
10. Idempotency: a revision for this execution with the same body digest replays `{duplicate: true, revisionNumber}`. A different digest is `SOURCE_CONFLICT`.
11. At most 10 revisions (`REVISION_LIMIT_REACHED`). Then one revision is inserted. Its number is allocated by the database.

Refusal codes map to bounded learner outcomes: `LIMIT_REACHED`, `ACTIVITY_BLOCKED`, `TOO_LONG` (checked before any call) or `UNAVAILABLE`.

## 5. Schema (migration 053)

`public.tutor_class_note_series`: one immutable row per Tutor delivery handoff.

| Column                                                                            | Meaning                                                                          |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `id`                                                                              | Logical note identity (internal; never returned to the learner).                 |
| `note_policy`                                                                     | `TUTOR_CLASS_NOTE_V1`.                                                           |
| `author_role`                                                                     | `TUTOR` (CHECK).                                                                 |
| `handoff_id`                                                                      | The Tutor delivery handoff (unique).                                             |
| `student_id`, `enrolment_id`, `programme_version_id`, `lesson_id`, `objective_id` | Derived scope; the lesson FK is `(lesson_id, programme_version_id)`.             |
| `reason_code`                                                                     | `MISSED_LESSON_PRACTICE`, `OBJECTIVE_REINFORCEMENT` or `PRACTICAL_PREREQUISITE`. |
| `created_at`                                                                      | Database clock.                                                                  |

`public.tutor_class_note_revisions`: append-only, one row per SUCCEEDED Tutor execution.

| Column                          | Meaning                                                                     |
| ------------------------------- | --------------------------------------------------------------------------- |
| `id`, `series_id`, `student_id` | Identity.                                                                   |
| `author_role`                   | `TUTOR` (CHECK).                                                            |
| `revision_number`               | 1–10, `unique(series_id, revision_number)`, allocated by the guard trigger. |
| `source_tutor_execution_id`     | Unique FK to `tutor_lab_provider_executions`.                               |
| `source_provenance_id`          | Unique FK to `academic_agent_execution_provenance`.                         |
| `body`                          | The learner-visible answer only: 1–8,000 characters.                        |
| `body_sha256`                   | Computed by the database (guard trigger), never caller-supplied.            |
| `created_at`                    | Database clock.                                                             |

No prompt, learner message, hidden reasoning, raw provider response or payload, model metadata, credential or MAC is stored.

**Structural separation from curriculum.** No row of `programme_versions`, `modules`, `lessons`, `lesson_objectives`, `course_practicals`, `course_package_imports` or `learning_resources` is written. `learning_resources` gains no `CLASS_NOTE` kind. Tested by a curriculum snapshot before and after, plus a static check of the migration.

## 6. Series and revision model

- One series per Tutor support topic (handoff). Each revision is one complete Tutor answer the learner kept for that topic. A later revision **does not edit** an earlier one, and the Tutor is not given earlier notes. "Revision" means a newer kept answer for the same topic.
- **Current** is the highest revision number. It is derived at read time; there is no mutable pointer.
- Earlier revisions remain immutable and visible as history.
- Two layers, with deliberately different strength:
  - **Triggers: the structural and immutability backstop for every table writer**, including the database owner. They are not an application path.
    - `guard_series`: insert only, matching the learner's own TUTOR handoff and enrolment (`TUTOR_CLASS_NOTE_SCOPE_INVALID`).
    - `guard_revision` (strengthened in the review correction): locks the series and requires the source execution to be SUCCEEDED, TUTOR and of the series' learner. Its release must be TUTOR and **`COMPLETED`**, of the same learner, handoff, enrolment and lesson, with a null-safe equal objective. The provenance row must belong to that execution and role. Otherwise `TUTOR_CLASS_NOTE_SOURCE_INVALID`. It **replaces** any caller-supplied revision number with `max + 1`, enforces the 10-revision limit, and computes the digest.
    - UPDATE and DELETE are refused on both tables (`TUTOR_CLASS_NOTE_IMMUTABLE`).
  - **The attested public RPC `record_tutor_class_note`: the full application authority** and the only supported write path (section 4). On top of the structural rules it checks the controller attestation, the current provenance binding (frozen behaviour, fingerprint, runtime profile, baseline), the ACTIVE enrolment under lock, and the firewall under the learner lock. The triggers do not re-check these.
- There is no delete surface of any kind.

## 7. Controlled-assessment firewall

- **Locking contract.** Migration 021 requires callers of `academic_content_release_explain_allowed()` to lock the current learner profile first, as every reviewed flow does (content-release begin/close, Tutor/Lab release begin/close, `start_assessment_attempt`).
  - Both AC-4 RPCs take `student_profiles … FOR UPDATE` before the firewall check: right after attestation in `record_tutor_class_note`; after input validation and before any note text in `list_my_tutor_class_notes`. Both fail closed (`FORBIDDEN`) without a profile.
  - `start_assessment_attempt` locks the same row first, then the assessment (`FOR SHARE`), then the enrolment (`FOR UPDATE`). AC-4 takes profile, then enrolment: the same order. A search of migrations 001–052 found no function that locks an enrolment before the learner profile, so no new order is introduced.
  - Serial semantics on real PostgreSQL: if note creation holds the profile lock first and passes its final checks, the note commits before the assessment attempt can start. If the assessment start (or an enrolment status transition, through the enrolment lock) wins first, note creation waits and then observes the active attempt (or new status) and refuses. A read likewise either completes and returns before the attempt starts, or waits and returns `ACTIVITY_BLOCKED`.
  - `list_my_tutor_class_notes` is therefore VOLATILE, not STABLE, because it takes a row lock. No fake content release is created for reading.
- **Creation:** rechecked inside `record_tutor_class_note` immediately before the durable write, independent of the earlier release/AUTHORIZE/START/close checks. While closed, nothing is persisted.
- **Read:** `list_my_tutor_class_notes` returns `ACTIVITY_BLOCKED` while explanation is blocked. A note created before an assessment cannot be read during it (tested).

## 8. Learner visibility

`public.list_my_tutor_class_notes(p_enrolment_id, p_page)`:

- STUDENT only, for the caller's own enrolment (`NOT_FOUND_OR_FORBIDDEN` otherwise), firewall-gated;
- pages of 5 notes, newest first (`p_page` 0–49, `hasMore`);
- per note: lesson title, objective description (or null), reason code, created time, revision count, and every revision (number, `current`, body, kept time), newest first.

No execution, provenance, handoff, series, release, enrolment, runtime-profile, behaviour, fingerprint, HMAC or audit field is returned. The server schema is strict and refuses any extra field or inconsistent history.

There is **no** admin, instructor, registrar, Counsellor, Sarah, Professor or Lab read path.

**UI.**

- The existing Tutor support panel carries the opt-in checkbox (Tutor only) and, after a SUCCEEDED answer, says whether it was kept. On success it shows the revision number and "It is not published course material", with a link to the notes.
- `/student/tutor-notes` lists notes per enrolment under the heading "Supplementary Tutor notes", with a "NOT COURSE MATERIAL" badge and a "SUPPLEMENTARY TUTOR NOTE" label per note. Its disclosure reads: "These are Tutor answers you chose to keep. They are supplementary support, not published course material, and they never change your curriculum. A Tutor note is not a mark, attendance, progress, completion or mastery record."
- The current revision is marked "(current)"; earlier revisions sit in a disclosure "(earlier) … kept unchanged".
- "Notes & resources" links to it from a separate card, below the published-curriculum card.
- Note text is rendered as React text, never as HTML (tested with a `<script>` body).

## 9. Bounds

| Bound                         | Value              | Enforcement                                                                                                                                   |
| ----------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Body length                   | 1–8,000 characters | Table CHECK, RPC, server (code-point count, as PostgreSQL counts). An over-long answer is **not kept**, never truncated; the learner is told. |
| Revisions per note            | 10                 | Guard trigger, RPC (`REVISION_LIMIT_REACHED`), CHECK on `revision_number`.                                                                    |
| Notes per page                | 5 (pages 0–49)     | RPC and strict server schema.                                                                                                                 |
| Notes per enrolment (implied) | ≤ 250              | One series per Tutor handoff; migration 023 caps handoffs at 250 per enrolment.                                                               |

8,000 characters covers the Tutor/Lab database output ceiling of 2,000 tokens in typical text; the production Tutor profile requests at most 700.

## 10. Idempotency and concurrency

- **Reservation fingerprint (review correction).** The note choice changes a durable side effect, so it is part of the migration-028 interaction reservation fingerprint (`tutorLabInteractionFingerprintMaterial`):
  - omitted or false: exactly the pre-AC-4 material `handoffId + "\n" + message`, so historical reservations still replay;
  - true: `"AC4_SAVE_AS_CLASS_NOTE\n" + handoffId + "\n" + message`. It is a **prefix**, not a suffix, because no-note material always begins with the validated handoff UUID, which can never begin with the tag. A suffix could be reproduced by a learner message ending in the same text.
  - The same idempotency key with a different note choice is therefore `DUPLICATE_KEY_CONFLICT` (safe `UNAVAILABLE`, no release, no provider call, no note). Migration 028 and its table are unchanged.
- **Lock order:** learner profile, then enrolment, then the series row (section 7).
- At most one revision per source execution: `unique(source_tutor_execution_id)` plus the replay check under the series lock.
- A retry with the same body replays `{duplicate: true}` with the same revision number. A different body is `SOURCE_CONFLICT`.
- Revision allocation:
  - the series row is created with `on conflict (handoff_id) do nothing`, then locked `FOR UPDATE`;
  - the guard trigger computes `max + 1` under that lock;
  - `unique(series_id, revision_number)` is the backstop.

  Under real PostgreSQL READ COMMITTED, a concurrent first insert waits on the unique index and then does nothing; the second transaction's `SELECT … FOR UPDATE` then sees and locks the committed series.

**PGlite is single-connection.** The local tests prove the invariants, **sequential** idempotency, and that the learner-profile lock is actually taken (section 16). True independent-connection concurrency is **not proven**: two simultaneous materialisations of one execution, two executions of one series, and assessment start racing note creation or read. These are outstanding hosted acceptance items (section 17).

## 11. ACL and RLS

- Both tables have RLS enabled with no policies. All privileges are revoked from `public`, `anon`, `authenticated` and `service_role`. The private schema `tutor_class_note_private` is revoked.
- Only `record_tutor_class_note(uuid,uuid,text,bigint,bigint,text)` and `list_my_tutor_class_notes(uuid,integer)` are executable, by `authenticated` only.
- A closing self-verification block fails deployment on any table, column, schema or function privilege outside that set (migration 051/052 pattern).
- Tested: effective privileges, and that an authenticated learner cannot select, insert, update or delete either table directly.

## 12. Audit privacy

AFTER INSERT triggers write `TUTOR_CLASS_NOTE_SERIES_CREATED` and `TUTOR_CLASS_NOTE_REVISION_CREATED` events containing identifiers, role, revision number, reason/scope ids and timestamps only.

They never contain the body, its digest, the learner message, provider output, a prompt, reasoning or a payload (tested with a sentinel). `audit_events` is PLATFORM_ADMIN-readable, which is exactly why no content enters it.

## 13. No institutional side effects

Note creation and reading write nothing to `learning_evidence`, `objective_mastery`, `objective_mastery_history`, `lesson_progress`, `attendance_records`, `assessment_attempts`, assessment or lab result revisions, completion receipts, or enrolment status (tested with a before/after snapshot).

A note's existence never implies learned, mastered, passed, verified, completed or attended. The UI makes no such claim (tested).

## 14. Behaviour-version decision: `TUTOR_BEHAVIOUR_V2` is kept

`TUTOR_BEHAVIOUR_V2` governs what the Tutor says and does: curriculum-based support, no protected-assessment help, and no claims about Professor teaching beyond the AC-3 record. Keeping a note changes neither the Tutor's instructions nor its input nor its output. The note is the identical learner-visible answer, persisted by the learner's choice and the server's data handling. Nothing in V1 or V2 refers to class notes.

So no `TUTOR_BEHAVIOUR_V3` is created. V1 and V2 text, hashes and fingerprints are unchanged, and no version list is widened.

Notes are **not** gated on a behaviour version. A V1-pinned programme version keeps notes exactly like a V2 one, and its provenance must still equal its own frozen binding (tested on a genuine pre-052 V1 publication).

AC-2's statement that the Tutor "produces no class notes (AC-4)" remains true of the Tutor itself: the Tutor still produces only an answer, and the server keeps it when the learner asks.

## 15. Retention and privacy (decision)

- Tutor notes are **deliberate, learner-visible, learner-chosen supplementary artifacts**. They are not hidden conversation memory. The AC-3 Professor transcript rule (delete at the earlier of 12 months after the class or 90 days after the enrolment leaves ACTIVE) is therefore **not** applied automatically, because its rationale (incidental continuity memory) differs.
- They contain only Tutor-authored answer text. No learner message is stored.
- **Status:** retained, immutable, until a reviewed retention and deletion policy for learner-kept notes is approved. There is no automated expiry, and no learner, admin or generic delete RPC.
- **Production item:** a reviewed retention period (for example tied to enrolment end), a governed operator purge mechanism that removes only eligible note text and never audit or provenance, and a learner-facing deletion or export decision are required **before production use**. AC-4 does not claim the lifecycle is complete.

## 16. Local evidence

**New suites:**

- **`tutor-class-notes-db` (54, real migration chain on PGlite).**
  - Creation:
    - revision 1 bound to its source and provenance, for all three Tutor reasons;
    - Lab, Professor, FAILED, ABSTAINED, ESCALATED, BUDGET_BLOCKED, CANCELLED, timeout, RUNNING and release-not-completed sources refused;
    - foreign learner and unknown execution refused;
    - body substitution, another protocol tag and another actor refused (`ATTESTATION_INVALID`).
  - Provenance: missing provenance refused; corrupt provenance refused (behaviour version, fingerprint, runtime profile, baseline mirror).
  - Scope:
    - cross-enrolment and cross-version provenance;
    - cross-lesson (other version and same version), cross-objective (same lesson) and cross-enrolment release;
    - invalid input and the non-STUDENT role; an exact 8,000-character body is accepted.
  - Firewall: blocked creation leaves no series, revision or audit row; blocked read.
  - Idempotency and versioning:
    - replay; `SOURCE_CONFLICT`;
    - contiguous allocation with current/earlier history across two topics;
    - the 11th revision refused;
    - database-owned allocation against a direct owner insert; guard refusals of a Lab source and a mismatched series;
    - UPDATE/DELETE refused for every writer.
  - Read: exact learner projection with no internal identifier; owner-only; enrolment-scoped; paging and its bounds.
  - Authority:
    - effective ACLs and no direct authenticated table access;
    - curriculum unchanged and nothing in `learning_resources`;
    - no institutional side effects;
    - content-free audit.
  - Review corrections (9):
    - the read and the write each take the learner-profile row lock (a fresh transaction gains an xid and the profile row's `xmax` equals it; the write locks even when the source is then not found);
    - a STUDENT caller without a profile is refused `FORBIDDEN` on both RPCs;
    - the live definitions place profile lock, then enrolment lock, then the ACTIVE check, then the firewall, then the insert; the read locks before the firewall and before note text; both RPCs are VOLATILE;
    - creation and reading are still refused during an already-active assessment, and creation is refused once the enrolment is no longer ACTIVE;
    - direct owner inserts are refused for a SUCCEEDED Tutor execution whose release never closed COMPLETED, and for a release whose objective scope does not match the series;
    - through the real migration-028 reservation RPC, the same key cannot switch the note choice in either direction, and true duplicates still replay.
  - End to end: the **real TypeScript recorder** is accepted by the real database through an RPC shim, including replay and conflict, and the strict server read parses the real projection.
- **`tutor-class-notes-v1-db` (1):** a genuine `TUTOR_BEHAVIOUR_V1`-pinned version records and lists a note, and its provenance names V1.
- **`tutor-class-notes` (19):**
  - strict request schema (only a boolean; no note text, source, provenance, role, learner, enrolment, profile or behaviour field);
  - code-point body bound;
  - strict learner projection (internal ids and inconsistent history refused);
  - refusal mapping;
  - the recorder's exact RPC arguments and canonical MAC; STUDENT, body and key checks before any call; malformed results fail closed;
  - read mapping and input refusal;
  - Server Action forwarding only the checkbox (forged note, source, provenance and role fields ignored);
  - review corrections: fingerprint material (historical no-note form, domain-separated note form, no message collision); malformed series and revision timestamps fail closed (existing `academicTimestampSchema`) and the read becomes UNAVAILABLE; the real `timestamptz` JSON form is accepted;
  - static checks: Tutor stays V2 with no V3; 053 writes no curriculum or `learning_resources`; the note modules reference no protected content, service role or `dangerouslySetInnerHTML`.
- **`tutor-class-notes-ui` (11):**
  - the Tutor-only opt-in with exactly four form fields; no Lab opt-in;
  - saved and four not-saved outcomes, with the answer still shown;
  - notes page labelling, current/earlier revisions, text-only rendering, no internal identifiers or positive academic claims;
  - firewall, unavailable and empty states.

**Extended:** `tutor-lab-execution-runtime` gains 21 (41 → 62):

- the note is recorded only after a confirmed FINALIZE (call order asserted), with exactly the confirmed output and the finalized execution id;
- nothing is recorded without opt-in, for the Lab Instructor, for five non-success outcomes, or when FINALIZE or the release close fails;
- an over-long answer is not kept;
- refusal mapping never changes the answer, and an unexpected error stays safe;
- review correction: omitted and false send the historical request hash, true sends the domain-separated hash, a reservation conflict fails closed with no release/provider/note, and a duplicate stays DUPLICATE.

**Mutation checks** (temporary edits of migration 053, then restored byte-identical):

- **Killed:**
  - removing the SUCCEEDED requirement (RPC and guard): 7 tests fail;
  - release `COMPLETED`: 1;
  - the write firewall: 1;
  - the read firewall: 1;
  - the provenance behaviour-version check: 1;
  - the provenance enrolment/version check: 2;
  - provenance existence: 1;
  - idempotent replay: 2;
  - the revision limit: 1;
  - the release-vs-handoff lesson check: 1;
  - the objective check: 1;
  - the read's enrolment/owner filter: 1;
  - every RPC role/reason check together (guards remaining): 1.
- **Killed (review corrections):**
  - write learner-profile lock removed: 3 tests fail;
  - read learner-profile lock removed: 3;
  - read declared STABLE again: 12 (PostgreSQL refuses the row lock in a STABLE function, and the volatility assertion fails);
  - write enrolment lock removed: 1 (structural);
  - guard `COMPLETED` requirement removed: 1;
  - guard objective scope removed: 1.
- **Survived (layered checks):**
  - Removing only the RPC's execution-role check, or the RPC and guard execution-role checks: Tutor-only is still enforced independently by the release role, the handoff destination, the provenance role and the series guard.
  - Removing only the release-vs-handoff enrolment check: a cross-enrolment release is still refused by the lesson-in-version check, the provenance enrolment check and the series guard. A same-version, different-enrolment forgery for one learner cannot be constructed.

**Gates:** recorded in `docs/implementation-progress.md`.

## 17. Hosted evidence still required

- Deployment of migration 053, the hosted migration ledger through 053, and the RLS/ACL smoke for the two tables and RPCs.
- Dedicated true-PostgreSQL concurrency scenarios (independent sessions, start gate, authenticated-role context, as in AC-3's harness):
  - **same-source materialisation race:** two sessions record the same SUCCEEDED execution: exactly one revision, one `duplicate: true` with the same revision number;
  - **same-series revision race:** two sessions record two different SUCCEEDED executions of one handoff: revisions 1 and 2, no duplicate number, no error;
  - **assessment start vs note creation:** one session records a note while another starts a controlled assessment for the same learner. PASS iff exactly one serial order is observed: either the note committed and the attempt started after it, or the attempt is ACTIVE and creation returned `ACTIVITY_BLOCKED` with no series, revision or audit row. Never both a committed note and a creation that began after the attempt was visible;
  - **assessment start vs note read** (property to verify): a read either completes before the attempt is visible (its transaction acquired the learner lock first), or returns `ACTIVITY_BLOCKED`; no read that acquires the lock after the attempt has started returns note text;
  - optionally, an enrolment status transition vs note creation: either the note commits while ACTIVE, or creation returns `ENROLMENT_NOT_ACTIVE`.
- JWT/PostgREST enforcement (still BLOCKED independently).
- Browser and accessibility acceptance of the panel and the notes page.
- Live-provider evidence. Tutor answer quality is not evaluated by deterministic tests.

## 18. Known limitations

- The learner must choose before seeing the answer, because Tutor output is not otherwise persisted.
- Each revision is an independent kept answer, not a Tutor-authored edit of earlier notes. The Tutor does not see earlier notes.
- Series are per Tutor handoff. Notes from the practicals page create a new handoff per request, so each becomes its own note.
- Paging is offset-based over immutable rows; a note created between page loads can shift a page by one.
- Retention and deletion are not enforced (section 15). Hosted concurrency is unproven (section 10).
- Notes on an enrolment that is no longer ACTIVE remain readable by the learner but cannot gain new revisions.

- Note reads take a short learner-profile row lock, so a read briefly serialises with that learner's other firewall-locked operations (content-release open/close, assessment start). This is the reviewed cost of the firewall contract.

## 19. Not implemented (and not claimed)

Lab, Professor or admin notes; a generic learner notes feature; curriculum editing; any new provider call or execution plane; Sarah; Counsellor; Examiner; note deletion or export; any use of a note as evidence, mastery, progress, attendance, a grade or completion; AC-5.

## 20. Independent-review corrections

The first independent review approved the architecture and found two blockers and two corrections. Only these were changed; the architecture, migration number, schema, HMAC protocol, bounds, page size, behaviour decision and retention status are unchanged.

1. **Blocker 1: firewall TOCTOU / missing learner lock.**
   - `record_tutor_class_note` now locks `student_profiles … FOR UPDATE` after attestation, failing closed without a profile. It loads the enrolment `FOR UPDATE` (profile first, then enrolment, matching `start_assessment_attempt`) before the ACTIVE check and the firewall.
   - `list_my_tutor_class_notes` takes the same profile lock before the firewall and before any note text, and is no longer STABLE.
   - Local tests pin the lock (xid/`xmax` probe, missing-profile refusal, ordering in the live definitions, volatility). They do **not** prove the race; hosted serialisation scenarios are listed in section 17.
2. **Blocker 2: `saveAsClassNote` in idempotency.** The note choice is in the reservation fingerprint (section 10). Omitted and false keep the exact historical hash; true is domain-separated by a prefix. A suffix such as `"\nAC4_SAVE_AS_CLASS_NOTE"` would let a learner message containing that text collide with a note request, so the prefix form is used instead. Migration 028 is unchanged.
3. **Correction 3: structural revision guard.** `guard_revision` now also requires the source release to be COMPLETED, TUTOR, and of the series' learner, handoff, enrolment, lesson and objective (null-safe). The docs now distinguish the trigger (structural backstop) from the attested RPC (full authority) (section 6).
4. **Correction 4: timestamps.** The learner projection's series and revision `createdAt` use the existing `academicTimestampSchema`, so malformed database timestamps fail closed before rendering.
