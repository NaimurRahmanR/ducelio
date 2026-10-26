# 61 · Learner experience: integration contract and ownership

Branch `feat/complete-learner-experience` (local only, from `main` `ee8fec7`). This contract binds every lane. Backend contracts are authoritative; a component is not integrated until it reads authorised backend data and is tested. Nothing is pushed, deployed or applied to a hosted database.

## 1. Canonical identities

- **Learner:** `public.current_app_user()` from the authenticated session. A client-supplied id never establishes access.
- **Enrolment:** `academy_enrolments.id`, owned by `learner_id`. Every learner RPC resolves it through `academy_private.my_enrolment(...)` (which locks the learner profile row when it writes).
- **Course and organisation:** `academy_courses.id`. Organisation through `course_engine_publications.organisation_id` (Ducelio default `00000000-0000-4000-8000-000000000001`). Learner projections expose `organisationName` as the course **provider**. Legacy (non-unified) Academy courses report provider "Ducelio".
- **Scheduled activity:** `academy_schedule_items` row of the learner's **current** schedule. `kind` LESSON | LAB | REVISION | ASSESSMENT; `ref`; `part/parts`.
  - **Occupied interval** = `[starts_at, ends_at)`, the scheduled session slot.
  - **Availability window** = `unified_item_window(item)` (`opens_at`, `closes_at` = start + 23 h 59 min for unified courses). The window never blocks other activities.

## 2. Routes (learner)

| Route                                        | Content                                                                                                                                                                                                         |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/student`                                   | Dashboard (post-login landing; `/student/academy` remains as a compatibility route)                                                                                                                             |
| `/student/learning`                          | My Learning: one full-width row per enrolment                                                                                                                                                                   |
| `/student/courses/[enrolmentId]`             | Course workspace (6 panels)                                                                                                                                                                                     |
| `/student/courses/[enrolmentId]/progression` | Detailed progression                                                                                                                                                                                            |
| `/student/timetable`                         | Full weekly timetable (`?week=YYYY-MM-DD`, `?course=`)                                                                                                                                                          |
| `/student/leaderboards`                      | Monthly assessment leaderboards for enrolled courses                                                                                                                                                            |
| `/student/profile`                           | One scrolling profile page                                                                                                                                                                                      |
| `/student/support`                           | Support & Feedback form (linked from the footer)                                                                                                                                                                |
| Existing                                     | `/student/academy/classroom/[id]`, `/student/academy/support/[id]`, `/student/academy/attempt/[id]`, `/student/academy/lesson`, `/student/academy/revision`, `/courses/**` stay and are restyled, not rewritten |

## 3. Academic policies (Lane B, server-enforced)

- **Attempts:** `allowed = least(template.attemptsAllowed, 2)`. Both attempts must start inside the availability window.
- **Effective attempt deadline:** `expires_at = least(started_at + duration, closes_at)`. A start is allowed while `now < closes_at`.
- **Same-attempt resume:** an ACTIVE attempt is resumed with its saved responses and its original `expires_at`. Duplicate or stale starts never create another attempt.
- **Release:** an assessment is _released_ for an enrolment when `now >= closes_at` of that enrolment's assessment window **and** no attempt is ACTIVE after lazy expiry. Before release, no RPC returns a score, mark, per-question correctness, correct answer, explanation, outcome, provisional score or completion status derived from that assessment. After release:
  - best eligible score per `attemptScoring` (HIGHEST/LATEST);
  - per-question correct answers;
  - explanation = the question's authored `markingGuidance`.
- **Deferred processing:** assessment objective evidence, mastery updates and `evaluate_completion` run at **release processing**, not at finalisation. Release processing is idempotent, runs from volatile learner RPCs and a learner-callable `refresh_my_academy_releases(enrolment)`, and never trusts the client clock.
- **Cross-course collisions:** preview, confirm and revise refuse any occupied interval overlapping an occupied interval of another of the learner's current schedules (`SCHEDULE_CONFLICT` with the conflicting item). The check runs under the learner-profile row lock, so concurrent activations serialise. An attempt start is refused if `[now, expires_at)` overlaps an occupied session interval of another course (`SCHEDULE_CONFLICT`).
- **Attendance:** `check_in_my_academy_class(enrolment, item)` records one attendance row, only inside the window. Attendance is not completion or mastery.
- **Class evidence** (display only, never mastery):
  - in-class checks `{objectiveRef, correct}`;
  - covered lesson objectives, restricted to the lesson's own objectives.
  - Both are recorded only from server-governed Professor executions.
- **Missed class:** a LESSON whose window closed with no attendance is _missed_. The next eligible class's Professor context includes the missed lesson's objectives for a concise recap and mastery-check questions. A missed class is never marked completed.
- **Leaderboard:** course × assessment × UTC month of the first attempt's `started_at`.
  - Best released score. Ties broken by the earlier first-attempt start, then by enrolment id.
  - Top 10, released entries only, one row per enrolment.
  - Caller must hold an enrolment in the course. Pseudonymous labels; the caller sees "You".

## 4. Services (Lane C)

- **Private files:** PostgreSQL-backed private blobs (no local Supabase Storage stack exists, so Storage cannot be exercised locally).
  - Size limits and magic-byte validation; no client table grants; access through definer RPCs scoped to the owner, or the course organisation's reviewers for lab evidence.
  - Profile photo: PNG/JPEG/WebP ≤ 1 MiB.
  - Lab artifacts: PNG/JPEG/WebP/PDF/plain text ≤ 1 MiB each, ≤ 5 per submission.
- **Email outbox:** idempotency key; QUEUED/SENT/FAILED; bounded attempts; provider adapter. With no provider configured it stays QUEUED and the UI says delivery is pending. It is never reported as sent.
- **Push:** VAPID, service worker `public/sw.js`, subscriptions per learner, reminders 15 minutes before each occupied interval.
  - Idempotent per (item, subscription); recalculated on schedule revision; expired subscriptions removed on 404/410.
  - In-app reminder fallback. Live delivery is unverified until tested on a real device with authorisation.
- **Support:** authenticated form to `support@ducelio.com` through the outbox, DB-backed rate limit, honest delivery state.
- **Certificates:** issued only from a real `academy_completions` row after release.
  - Unique verification code; PDF via `pdf-lib`; public verification page; idempotent issuance and email.
  - Text states that Ducelio prepares learners for the external exam and does not award the external qualification. The issuer is the course organisation.
- **Receipts:** issued only for FULFILLED orders with a verified PAID payment event. Unique per order, PDF, idempotent email.
  - Seller identity from configuration. When it is unconfigured, the receipt says so rather than inventing details.
- **Profile:** first/last name, photo, repeatable education and employment.
  - Email changes only through Supabase Auth's verified email-change flow.
  - Official academic records are read-only.

## 5. Migration allocation (Integration Lead)

- `202611050075_learner_academic_policies.sql`: Lane B.
- `202611060076_learner_services.sql`: Lane C.
- No other numbers may be used. The lead updates `tests/sarah.test.ts` migration list, `scripts/acceptance/academy-readiness-contract.json` and the CI real-PostgreSQL list at integration.

## 6. File ownership (one writer per file)

| Owner             | Files                                                                                                                                                                                                                                                                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Integration Lead  | this document, `docs/implementation-progress.md`, `package.json`/lock, `.github/workflows/ci.yml`, `tests/sarah.test.ts`, `scripts/acceptance/academy-readiness-contract.json`, `src/domain/learner-contract.ts` (created at integration), final page wiring                                                                                  |
| Lane A (frontend) | `src/app/globals.css`, `src/components/academy-shell.tsx`, `src/app/student/page.tsx`, new `src/app/student/{learning,courses,timetable,leaderboards,profile,support}/**` page shells, new `src/components/learner/**`, `src/components/ui.tsx`, learner UI tests (`tests/learner-*-ui.test.ts`, `tests/student-course-discovery-ui.test.ts`) |
| Lane B (academic) | `supabase/migrations/202611050075_*`, `src/server/academy-delivery.ts`, `src/domain/academy-delivery.ts`, `src/server/academy-professor-classroom.ts`, `src/server/academic-runtime/academy-professor.ts`, new `src/server/learner-academics.ts`, academic DB tests and the existing tests whose policy changes                               |
| Lane C (services) | `supabase/migrations/202611060076_*`, new `src/server/learner-{profile,files,email,push,support,certificates,receipts}.ts`, new `src/app/api/learner/**`, `src/app/verify/**`, `public/**`, `src/domain/auth.ts`, `src/app/auth/confirm/**`, `src/lib/env.ts`, services tests                                                                 |

Lanes do not edit files outside their row. Shared changes are requested from the lead.
