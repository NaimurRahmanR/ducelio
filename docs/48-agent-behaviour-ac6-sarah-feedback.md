# AC-6: Sarah post-session feedback and the admin teaching-quality surface

AC-6 is the sixth checkpoint of the Agent / Model control and Governed Academic Agent Behaviour workstream (see [AC-1](43-agent-control-1.md) to [AC-5](47-agent-behaviour-ac5-sarah.md)). Branch `feat/ac6-sarah-session-feedback`, base `f6ab664d1a42706f34fa5db9ba8826cb483a0b41` (AC-5 merged through PR #59). Migration `202610060055_sarah_session_feedback.sql`; migrations 001–054 are unchanged.

**Status:** independently reviewed and merged through PR #60 (merge `b33da08b3ce4bd9e918230bf7940c5f1bfb58889` on `main`). Migration 055 is **not** deployed; migration 054 (AC-5) is also still undeployed. No hosted evidence exists for AC-6. **Not production-ready.**

The approved definition (AC-1 section 7): _Sarah post-session feedback. Feedback collection and an admin teaching-quality surface._ AC-7 (course guidance and commercial recommendation behind a hard data firewall) is implemented separately in [AC-7](49-agent-behaviour-ac7-sarah-course-guidance.md) (independently reviewed and approved for commit/PR, not yet merged). It never reads AC-6 feedback.

## 1. Architecture decision: no model call

Sarah Mitchell, Ducelio's AI learner-success counsellor, is the **learner-facing persona** that asks for feedback. The feedback itself is deterministic, structured institutional data: three integer ratings. Transforming them with a language model adds no value, so AC-6 calls none of the following:

- OpenAI or any other provider;
- `COUNSELLOR_PLATFORM_V1`;
- the AC-5 Sarah execution ledger (`SARAH_EXECUTION_V1`);
- any academic runtime.

The AC-5 runtime is unchanged. Sarah's behaviour instructions still say "Never ask for or collect feedback about classes, teachers or teaching quality". This stays true: the **model** never collects feedback. The deterministic card does.

Proven by:

- a server test that mocks every Sarah, runtime, adapter and profile entrypoint as a spy, runs submission, listing and the Server Action, and asserts no spy was called;
- a static import check on every AC-6 source file;
- a mutation that smuggles a dynamic runtime-profile call into submission, which the spy kills.

## 2. Authoritative session and eligibility

Feedback binds to the existing `public.class_sessions` row. There is no parallel teaching-session model. The learner, cohort, programme version, lesson and instructor are derived by the database. The browser sends only:

- the class-session handle;
- a request UUID;
- three ratings.

**Eligibility rule.** All of these must hold, and `submit_my_session_feedback` re-checks each one under locks:

1. The caller is authenticated, active and has the `STUDENT` role.
2. The session exists.
3. The caller's **own** enrolment is in the session's cohort **and** programme version, with status `ACTIVE`, `PAUSED` or `COMPLETED`. `WITHDRAWN` is not eligible.
4. The session status is not `CANCELLED`.
5. `scheduled_end <= clock_timestamp()`.
6. The caller's authoritative `attendance_records` row for that session and enrolment has status exactly `PRESENT`.

Notes on the rule:

- A session still `SCHEDULED` after its scheduled end **is eligible**. An admin who has not yet marked it `COMPLETED` does not block legitimate feedback. `COMPLETED` is also eligible.
- `LATE`, `ABSENT`, `EXCUSED` and a missing attendance record are not eligible.
- Attendance is never inferred from opening the classroom, Professor use, page views or learner statements.
- A `COMPLETED` enrolment stays eligible, so a learner can rate their final session after the course closes.

**Refusal codes.**

| Code                     | Meaning                                                                        |
| ------------------------ | ------------------------------------------------------------------------------ |
| `FORBIDDEN`              | No authenticated STUDENT                                                       |
| `INVALID_INPUT`          | Missing handle or UUID, or a rating outside 1–5                                |
| `NOT_ELIGIBLE`           | Unknown session, foreign cohort or withdrawn enrolment (deliberately one code) |
| `SESSION_CANCELLED`      | The learner's own session was cancelled                                        |
| `SESSION_NOT_ENDED`      | The learner's own session has not ended                                        |
| `ATTENDANCE_NOT_PRESENT` | Attendance is not PRESENT, or missing                                          |
| `ALREADY_SUBMITTED`      | This learner already rated this session (checked before the session state)     |
| `REQUEST_CONFLICT`       | The request UUID was already used for a different session or different ratings |

`NOT_ELIGIBLE` collapses three cases on purpose, so a probe cannot learn whether a foreign session exists or when it is scheduled. A session cancelled **after** a learner rated it still answers `ALREADY_SUBMITTED` for a new key and `REPLAYED` for the original key. The learner's recorded fact takes precedence over the later session state.

## 3. Stored fields

`public.session_teaching_feedback` has exactly these columns:

| Column              | Notes                                      |
| ------------------- | ------------------------------------------ |
| `id`                | uuid                                       |
| `class_session_id`  | FK to `class_sessions`                     |
| `student_id`        | FK to `student_profiles`; database-derived |
| `request_id`        | the learner's idempotency UUID             |
| `policy_version`    | always `SESSION_FEEDBACK_V1`               |
| `clarity_rating`    | 1–5                                        |
| `pace_rating`       | 1–5: how well the pace suited the learner  |
| `usefulness_rating` | 1–5                                        |
| `submitted_at`      | set by the database                        |

Higher is better on every scale. Table constraints:

- `unique(student_id, class_session_id)`: exactly one durable record per learner and session;
- `unique(student_id, request_id)`.

There is no free text, comment, complaint, sentiment, diagnosis, engagement or learning-style field.

Learner wording is friendly and the stored terms stay explicit:

- "How clear was the session?"
- "How was the pace for you?"
- "How useful was the session for your learning?"

Each question shows a 1–5 scale hint.

**Immutability.** A `BEFORE INSERT OR UPDATE OR DELETE` trigger:

- refuses every `UPDATE` and `DELETE` (`SESSION_FEEDBACK_IMMUTABLE`), including by the database owner;
- refuses any insert without an ended, non-cancelled session and a PRESENT attendance record for the same learner (`SESSION_FEEDBACK_INELIGIBLE`);
- sets `policy_version` and `submitted_at` itself.

Historical feedback for a session that is cancelled later is retained.

## 4. Idempotency

The server renders the request UUID per prompt (`randomUUID()` in the Server Component), so hydration is stable. The fingerprint is the exact submission tuple: session plus the three ratings. The stored row holds these values, so it is compared directly and no hash is stored.

| Situation                                              | Result                        |
| ------------------------------------------------------ | ----------------------------- |
| same UUID, same session and ratings                    | `ok`, `REPLAYED` (no new row) |
| same UUID, different ratings or session                | `REQUEST_CONFLICT`            |
| new UUID for an already-rated session                  | `ALREADY_SUBMITTED`           |
| concurrent insert reaching the unique index (backstop) | `ALREADY_SUBMITTED`           |

How the client rotates the UUID:

- It keeps the UUID after an unresolved transport failure, so a retry replays safely.
- It rotates only after `REQUEST_CONFLICT`. The learner's next deliberate attempt then gets a definitive answer: recorded, or already submitted.

## 5. Learner UI (Sarah persona)

- **`/student/sarah`** always shows the "How did that session go?" card. It contains the prompts, or "No sessions are waiting for your feedback right now." Sarah's intro also says she can ask for three quick 1–5 ratings, that recording them uses no AI, and that it never changes grades, attendance or progress.
- **`/student/classes`** shows the same component, with the `SarahIdentity` header ("Sarah Mitchell · Ducelio AI learner-success counsellor · AI"), only when at least one eligible session is listed.
- Each prompt shows:
  - the lesson, programme, cohort and instructor;
  - a fixed-format UTC time, so server render and hydration agree;
  - three radio groups (1–5, each required, in a `fieldset` with a `legend`).
- There is no text input of any kind.
- After success the prompt closes with "Thanks — your feedback has been recorded." `ALREADY_SUBMITTED` closes it with "You have already shared feedback for this session." Recoverable outcomes keep the form open.
- The copy never claims that Sarah reviewed the feedback, that the instructor has seen it, or that anyone will act on it. No internal identifier is displayed; the session handle is only a hidden form value.
- Privacy copy: administrators see only combined results for a session, and only once at least 3 learners have answered. The learner's name and individual answers are not shown to administrators or to the instructor.
- The page is not revalidated after a submission. This keeps the truthful outcome visible, and the next navigation reads a fresh, dynamic list.

## 6. Learner opportunity projection

`list_my_session_feedback_opportunities()` returns the caller's **10 most recent** eligible, unrated sessions, newest end first. Each one has:

- `classSessionId`;
- lesson, cohort and programme titles;
- instructor name;
- scheduled start and end.

It excludes cancelled, unended, non-PRESENT, foreign, withdrawn and already-rated sessions, and creates no synthetic sessions. Older eligible sessions beyond the 10 are not listed but remain submittable.

## 7. Admin teaching quality

- **Where:** `/admin?section=Sessions`, card "Teaching quality". The Sessions section is shown only to Academic Admin and Platform Admin.
- **Server:** `getTeachingQuality` requires `ACADEMIC_ADMIN` or `PLATFORM_ADMIN`.
- **Database:** `admin_session_teaching_quality` checks `has_role('ACADEMIC_ADMIN') or has_role('PLATFORM_ADMIN')` **explicitly**. `is_academic_admin()` also admits `REGISTRAR`, and registrar correction authority is not teaching authority.
- **Refused roles:** `INSTRUCTOR`, including the instructor who taught the session; `COUNSELLOR`; `REGISTRAR`; `STUDENT`.
- **Filters:** instructor, cohort, and a scheduled-start window (`tqInstructorId`, `tqCohortId`, `tqFrom`, `tqUntil`), with 50 sessions per page (`tqOffset`). These parameters are separate from the session register's own filters. Invalid filters show a message, never a crash.
- **Each row** is an **ended, non-cancelled** session with:
  - lesson, cohort, instructor, programme / version label, scheduled time and status;
  - `presentCount` and `responseCount`;
  - `scoresAvailable`;
  - the three averages, as numbers rounded to 2 decimals.
- **Summary** for the filters: ended sessions, responses, sessions with scores and their response count, and summary averages.
- **Aggregation:** deterministic SQL `avg` and `count`. No LLM is used. The averages are JSON numbers; strict Zod schemas refuse numeric strings, unknown keys, more than 50 rows and `CANCELLED` rows.

### Privacy threshold (minimum 3 responses)

- A session row carries averages **only** when it has at least 3 responses. Below that it shows the response count and "Insufficient responses for scores", and the averages are `null`.
- The TypeScript schema enforces the same rule in both directions. A row with scores below the threshold, or with missing scores at or above it, is refused, and the page shows "could not be loaded".
- **Summary hardening (stricter than "may").** The summary averages use **only sessions that individually meet the threshold**. If they used every filtered response, an admin could compare a broad filter with a visible session and recover a hidden 1–2 response session's average. Under this rule, the summary averages are derivable from rows that are already visible, and reveal nothing new.
- The admin projection never contains:
  - a student id, name or number;
  - an individual rating;
  - a request or feedback id;
  - a submission timestamp.

  This is tested against the full JSON.

- Cancelled sessions are excluded from rows and the summary. Their feedback rows are kept.

## 8. Authority, side effects and the AC-7 firewall

Feedback is observational. Submission writes exactly one feedback row and one audit row. A before/after snapshot test proves that 25 tables stay byte-identical, including:

- attendance, class sessions, enrolments;
- lesson progress, learning evidence, objective mastery and its history;
- assessment attempts, assignment submissions, registrar corrections;
- agent configs, learning resources, lessons, cohorts, staff profiles, role grants;
- support profiles, events, follow-ups and notifications;
- Sarah reservations, executions and proposals;
- counsellor assignments and commercial orders.

There is no automatic escalation, punishment or academic action.

Ratings reach **no** commercial path: course recommendation, pricing, sales, re-enrolment, upsell or progression. No AC-6 file imports a commercial, Sarah-runtime or provider module (tested). AC-7 designs its own hard firewall: its commercial projection never reads `session_teaching_feedback`, and changing any rating leaves the commercial-context fingerprint unchanged (tested; see [AC-7](49-agent-behaviour-ac7-sarah-course-guidance.md) sections 4–5).

## 9. ACL, RLS and private schema

- `session_teaching_feedback`:
  - RLS on, with no policies;
  - every table **and column** privilege revoked from `public`, `anon`, `authenticated` and `service_role`. `service_role` therefore has no ambient read or write, despite its `bypassrls` and broad default grants.
- `session_feedback_private` (the guard and audit trigger functions): no USAGE or CREATE for any application role.
- Three public RPCs, each `security definer`, `search_path=''`, independently authorised, and executable by `authenticated` only:
  - `list_my_session_feedback_opportunities()`: STUDENT, own data;
  - `submit_my_session_feedback(uuid,uuid,integer,integer,integer)`: STUDENT, own data;
  - `admin_session_teaching_quality(uuid,uuid,timestamptz,timestamptz,integer)`: ACADEMIC_ADMIN or PLATFORM_ADMIN.
- A migration-time self-verification block (`$session_feedback_acl$`) fails deployment on any other effective schema, table, column (including `MAINTAIN` on PostgreSQL 17+) or function privilege. A test re-runs it and shows it fails closed on an injected grant.

## 10. Audit

On insert, the trigger writes one `audit_events` row:

- `action = 'SESSION_FEEDBACK_SUBMITTED'`;
- `target_type = 'session_teaching_feedback'`, `target_id` = the feedback id;
- `source = 'LEARNER_SESSION_FEEDBACK'`;
- a fixed reason;
- `after_state` = `{feedback_id, class_session_id, action, submitted_at}`.

**`actor_id` is deliberately `NULL`.** Platform Admins can read audit, so recording the learner would link each learner to a response. The authoritative learner link stays in the feedback table, which no application role can read.

The three ratings are not copied into audit, and no student id, name or number is audited. Replays write nothing. Admin aggregate reads are not audited per read, consistent with the existing Sessions read RPCs.

## 11. Concurrency (PGlite proves sequential behaviour only)

**Submission lock order:**

1. the learner `student_profiles` row, `FOR UPDATE` (the same first lock as 021/053/054);
2. the enrolment, `FOR SHARE`;
3. the class session, `FOR SHARE`;
4. the attendance record, `FOR SHARE`.

This matches `record_attendance`'s session-then-attendance order. A structural test pins the order on the live function definition.

| Race                                           | Protection                                                                                                                                     |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| two submissions by one learner for one session | learner lock serialises them; the second sees the committed row (`REPLAYED`, `REQUEST_CONFLICT` or `ALREADY_SUBMITTED`); unique index backstop |
| same request UUID racing                       | same learner lock; `unique(student_id, request_id)` backstop                                                                                   |
| session cancellation racing submission         | session `FOR SHARE` conflicts with the status change's `FOR UPDATE`; a committed cancellation is re-read and refused                           |
| attendance mutation racing submission          | attendance `FOR SHARE` conflicts with `record_attendance` and registrar correction `FOR UPDATE`; the committed status is re-read               |
| enrolment withdrawal racing submission         | enrolment `FOR SHARE` conflicts with enrolment status `FOR UPDATE`                                                                             |

**Hosted PostgreSQL acceptance still required.** These need independent sessions, a start gate and the `authenticated` role context, as in AC-3's harness:

- concurrent double submit (same and different UUIDs) for one learner and session: exactly one row, one `RECORDED`;
- `change_class_session_status(..., 'CANCELLED')` racing submission: either feedback was recorded before the cancellation committed, or `SESSION_CANCELLED`, never a row on a session that was cancelled first;
- registrar attendance correction (PRESENT → ABSENT) racing submission: either the row was recorded under PRESENT or `ATTENDANCE_NOT_PRESENT`;
- enrolment withdrawal racing submission;
- deadlock absence across the lock orders above under load.

## 12. Local evidence

| Suite                               | Tests | Covers                                                                                                                                          |
| ----------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/session-feedback-db.test.ts` | 27    | real migration chain: eligibility, ownership, roles, idempotency, immutability, ACL/RLS, aggregates, threshold, privacy, audit, no side effects |
| `tests/session-feedback.test.ts`    | 19    | schemas, outcome mapping, projections, server boundary, Server Action, no provider/runtime call                                                 |
| `tests/session-feedback-ui.test.ts` | 13    | Sarah prompt, classes view, UUID rotation, admin panel, role reachability                                                                       |

Two existing tests were updated for AC-6:

- `tests/sarah.test.ts`: migration 054 is now followed only by 055;
- `tests/sarah-ui.test.ts`: the session-feedback server is mocked, and the "no feedback" assertion now applies to everything **outside** the deterministic feedback card. The forbidden-claims list is unchanged.

The control-plane copy (`PLATFORM_ROLE_FACTS.COUNSELLOR`, `/admin/agents`) is truth-synced: AC-6 is deterministic data that never runs on the Sarah plane. The `COUNSELLOR_PLATFORM_V1` profile, its fingerprint and Sarah's behaviour instructions are unchanged.

Mutation checks and gates are recorded in `docs/implementation-progress.md`.

## 13. Known limitations

- **Temporal differencing.** An admin who reads a session's averages just before and just after one more response arrives can infer that single anonymous response. Mitigations need a separate review: release after a fixed feedback window, delayed batching, or coarser rounding. The rows still never identify who responded.
- No feedback window: an eligible session stays ratable indefinitely, and only the 10 most recent are prompted.
- LATE attendance is not eligible (strict PRESENT rule, as specified). Broadening it needs a reviewed decision.
- No feedback editing or withdrawal, and no learner export or retention period yet. This is a production privacy item.
- Present count and response count are both visible. When everyone present responded, the group is known but the individual answers are not.

## 14. Hosted and production items still required

- Deploy migrations 054 and 055 in order, verify the ledger, and run the ACL/RLS smoke for the table, private schema and three RPCs.
- JWT/PostgREST enforcement of the three RPCs (still BLOCKED independently).
- The true-PostgreSQL races in section 11.
- Browser, device and accessibility acceptance of `/student/sarah`, `/student/classes` and `/admin?section=Sessions`.
- A privacy/retention decision for feedback rows, and a review of the temporal-differencing residual.
