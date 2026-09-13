# Learner-facing Professor classroom — Commercial V1 checkpoint

This checkpoint gives the previous checkpoint's governed provider execution path (`docs/19-live-professor-execution.md`) an actual learner-facing surface: an authenticated STUDENT can go from `/student` to a dedicated classroom for an owned, eligible `ClassSession`, start or resume it, see authoritative lesson/class context, and interact with PROFESSOR — begin the lesson, or ask a bounded plain-text question — only through the existing, single `executeRoleCapability` composition boundary. That boundary was **narrowly extended** with one reviewed `interaction` contract (see below) — it was not left unmodified, and no second runtime or authorization boundary was created alongside it. Every governance layer introduced by migrations 022–025 and the 2A delivery lifecycle runs exactly as it did before this checkpoint, now reached from a real page instead of only from tests.

**Correction pass (independent review):** this document originally described `executeRoleCapability` as "unmodified," which is not accurate — that composition boundary's own request schema was narrowly extended (see "How provider context is constructed" below); the accurate framing above replaces it throughout this document. This pass also fixes three concrete blockers: idempotency now survives out-of-order key replay (durable per-classroom reservations, not "compare against the latest key"); a classroom `interaction` is now bound, at `executeRoleCapability` itself, to exactly one role+capability+selector combination rather than being accepted independent of capability; and an unexpected exception from `executeRoleCapability` is now caught at the Server Action boundary and mapped to the same safe `RETRY_LATER` learner state, never propagated raw. Each is detailed in its own section below.

## Why a new migration was needed, and why it is not an institutional record

"Leave and return to the same class/lesson state" requires something durable and learner-owned that survives a page refresh, a different device, or the browser losing client state — a client-supplied `classSessionId` alone cannot provide that safely, since it is untrusted input and must never be allowed to select another student's enrolment, cohort, programme version, lesson or classroom. `202609130026_commercial_v1_professor_classroom.sql` (additive-only; migrations 001–025 are byte-for-byte unchanged) is still exactly one migration, and adds two tables: `public.professor_classroom_sessions`, holding the minimum necessary learner-owned UX state (classroom id, `student_id`, `class_session_id`, the enrolment/programme-version/lesson identity the server itself derived, `mode` (`LIVE`/`CATCH_UP`), `first_opened_at`/`last_opened_at`); and `public.professor_classroom_interaction_reservations`, a small metadata-only idempotency ledger keyed by `(classroom_id, idempotency_key)` (see "Idempotency" below). Neither is an institutional academic record: neither can mark attendance, write `learning_evidence`, change `objective_mastery` or `lesson_progress`, assign a grade or complete an assessment — those remain exclusively controlled by their own existing, unmodified services. This is proven directly, not just asserted by design: `tests/professor-classroom-db.test.ts` asserts zero new rows appear in `attendance_records`, `learning_evidence`, `objective_mastery` or `audit_events` as a result of opening a classroom or recording a Professor interaction.

Professor/learner chat transcripts are **not** persisted anywhere. A repository-wide check confirmed no existing, reviewed, self-scoped content-storage mechanism exists that this checkpoint could safely reuse for that purpose without inventing a second trusted execution architecture, so — per the checkpoint's own instruction to stop and report rather than expand scope — transcript persistence is explicitly out of scope. The current Professor response exists only in interactive client (page) state for the duration of that browser session; "resume" means resuming the same authoritative classroom/class-session identity, lesson, mode, schedule and institutional progress/mastery/resources, not restoring prior chat text.

## Eligibility: LIVE / CATCH_UP / FUTURE / CANCELLED

Eligibility is computed from server/database time (`clock_timestamp()`) against the same `class_sessions` ownership relationship migration 019's `list_my_class_sessions` already uses — a join through the caller's own `ACTIVE`/`PAUSED` enrolment on `(cohort_id, programme_version_id)` — deliberately **not** the unrelated 2A delivery-occurrence schedule (`getDeliveryAgentAccess`/`getDeliveryContext`), which is a different, self-paced scheduling concept:

| Condition (server time `now`, session `[scheduled_start, scheduled_end]`) | Result                                                                     |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `status = 'CANCELLED'`                                                    | No classroom entry (overrides everything)                                  |
| `now < scheduled_start`                                                   | `FUTURE` — visible with scheduled time, no early start (`NOT_YET_STARTED`) |
| `scheduled_start <= now <= scheduled_end` (inclusive both ends)           | `LIVE` — Start class / Resume class                                        |
| `now > scheduled_end`                                                     | `CATCH_UP` — Start catch-up / Resume catch-up                              |
| No matching owned enrolment for this session's cohort/programme version   | No classroom entry (`FORBIDDEN`)                                           |

This exact rule is implemented identically in two places: the authoritative SQL gate, `public.open_professor_classroom` (migration 026), which is the only place a classroom is actually created/resumed and is re-verified on every call — a client cannot skip ahead by caching a prior `LIVE` result — and a pure TypeScript preview, `previewClassroomEligibility` (`src/domain/professor-classroom.ts`), used only to render the right CTA on the `/student` classes list. The preview is explicitly documented as non-authoritative: real entry always re-derives eligibility server-side, so a stale or manipulated client preview can at most show the wrong button label, never grant classroom access. No attendance is fabricated from classroom usage in either path.

## The two learner-facing Professor actions

1. **Begin lesson** — a deliberate "Begin with Professor" button press, constructing a fixed, server-recognised `{ kind: "BEGIN_LESSON" }` interaction. Rendering or refreshing the classroom page never itself triggers a provider call.
2. **Ask Professor** — a plain `<textarea>` with a real `<label>`, submitting free text validated server-side by `learnerMessageSchema` (`z.string().trim().min(1).max(2000)`) before any classroom lookup or provider call happens. There is no browser-selected role, provider, model, capability or budget field anywhere in this path, and no `dangerouslySetInnerHTML` is used anywhere in `professor-classroom-panel.tsx` — React's own escaping renders all learner and Professor text.

Both actions are handled by `src/app/student/classroom/actions.ts`'s shared `requestProfessorClassroom` helper, which:

1. Requires an authenticated STUDENT (via the same `getAuthenticatedActor` every other server path uses).
2. Validates `classSessionId` as a UUID; rejects anything else before any DB call.
3. Calls `openProfessorClassroom(classSessionId)`, which re-derives — never trusts — the enrolment/programme-version/lesson relationship via `open_professor_classroom`, mapping any denial (`FORBIDDEN`/`NOT_FOUND`/`CANCELLED`/`NOT_YET_STARTED`/`SERVICE_UNAVAILABLE`) to one calm, internals-free learner message.
4. Validates the idempotency key and interaction payload (`BEGIN_LESSON`, or `LEARNER_QUESTION` with the bounded message above) — a malformed or overlong message is rejected here, before step 5.
5. Calls `recordProfessorClassroomInteraction`; if this exact key was already reserved for this classroom (including one reserved before other, later interactions — see "Idempotency" below), returns `{ status: "DUPLICATE" }` immediately with **no** call to `executeRoleCapability`.
6. Calls `executeRoleCapability({ enrolmentId, role: "PROFESSOR", capability: "get_lesson_context", lessonId, interaction })` — `enrolmentId`/`lessonId`/`role`/`capability` are all **server-derived**, never read from the submitted form, even if the form happens to carry its own (ignored) values for them. This call is wrapped in a narrow try/catch (see "Safe failure on an unexpected exception" below): an unexpected throw from `executeRoleCapability` itself never propagates to the learner.
7. Maps the returned `RuntimeResult` to one safe learner-facing outcome (see below) and returns only that.

`tests/professor-classroom-actions.test.ts` proves this concretely: a form that additionally supplies `enrolmentId`, `role: "TUTOR"`, `capability: "delete_everything"`, `provider`, `model`, `maxProviderCalls` and `maxEstimatedCostMicrousd` still produces an `executeRoleCapability` call whose argument key-set is exactly `{capability, enrolmentId, interaction, lessonId, role}` with server-chosen values — none of the extra fields reach it.

## How provider context is constructed, without a JSON escape hatch

`executeRoleCapability`'s own request schema (`src/server/academic-runtime/index.ts`) — the single existing composition boundary — was extended by exactly one new, optional, closed field:

```ts
interaction: professorClassroomInteractionSchema.optional();
```

`professorClassroomInteractionSchema` is a `z.discriminatedUnion` of exactly two `z.strictObject` shapes (`{kind:"BEGIN_LESSON"}` and `{kind:"LEARNER_QUESTION", learnerMessage: learnerMessageSchema}`) — never `z.unknown()` or a general JSON passthrough. The resulting provider context is built as:

```ts
const context = {
  capability: capabilityName.data,
  data, // the existing, already-validated Academy OS capability output (get_lesson_context)
  ...(payload.interaction ? { interaction: payload.interaction } : {}),
};
```

so `interaction` is present in the context only when the caller actually supplied one, and is otherwise entirely absent — `tests/professor-classroom-runtime.test.ts` proves a request with no `interaction` field produces a context object failing `toHaveProperty("interaction")`, i.e. this extension is fully backward-compatible with every pre-existing V2 test and does not change behaviour for any caller that doesn't opt in. Content generation for this checkpoint is anchored entirely in the existing, reviewed `get_lesson_context` capability output — no new retrieval architecture, no LLM-based capability/institutional-data router was introduced. Lesson objectives, approved resources and objective mastery are shown to the learner separately, via the existing `getStudentLessonObjectives`/`getStudentLessonResources`/`getStudentLessonMastery` reads (`src/server/professor-classroom.ts`'s `getClassroomLessonContent`), each of which independently re-enforces the controlled-assessment explanation firewall for itself.

### The interaction is bound to exactly one role+capability+selector combination

**Correction pass (independent review, Blocker 2):** accepting `interaction` in the request schema is necessary but not sufficient — the original implementation let a caller attach an `interaction` to _any_ capability the Professor catalogue exposes, not only `get_lesson_context`. `executeRoleCapabilityCore` now enforces, immediately after validating the capability name and before `capabilityInput` is even assembled:

```ts
if (payload.interaction) {
  const boundToReviewedClassroomCapability =
    payload.role === "PROFESSOR" &&
    capabilityName.data === CLASSROOM_INTERACTION_CAPABILITY && // "get_lesson_context"
    payload.lessonId !== undefined &&
    payload.objectiveId === undefined;
  if (!boundToReviewedClassroomCapability) {
    return { outcome: "ABSTAINED", usage, reason: "NO_EXECUTION_PATH" };
  }
}
```

An `interaction` supplied with any other capability (`get_actor_context`, `get_activity_permissions`, `get_current_learner_context`, `get_lesson_objectives`, `get_current_class_session`, `get_learning_resources`, `get_permitted_learning_history`, `get_current_mastery_state`), any other role, a missing `lessonId`, or an `objectiveId` supplied alongside it as an alternate selector, is refused **here** — before `withValidatedProfessorContent` is ever called, so it never reaches the academic-content release, the provider adapter, or migration 025's AUTHORIZE/START/FINALIZE governance. This is not a second classroom capability: it is the single existing `get_lesson_context` read, with exactly one selector. `tests/professor-classroom-runtime.test.ts` proves this for every one of the eight non-`get_lesson_context` Professor capabilities, plus the `objectiveId`-as-alternate-selector and missing-`lessonId` cases, each asserting zero calls to `withValidatedProfessorContent`, the provider adapter's `generate`, and `attestProviderExecutionCommand`.

Every governance layer downstream of this gate runs completely unaware of it beyond the field's own presence in the context object handed to the provider: 2A delivery-agent-access, stored agent-configuration/capability authorization, runtime/model-profile resolution, the `withValidatedProfessorContent` academic-content release, and migration 025's AUTHORIZE → START → provider → release-closure → FINALIZE governance are all unmodified by this checkpoint.

## Assessment firewall

When `CONTROLLED_ASSESSMENT_ACTIVE` (or any other Academy OS rule) blocks Professor explanation, `getStudentLessonObjectives`/`getStudentLessonResources`/`getStudentLessonMastery` all throw `AcademicActivityBlocked` together; `getClassroomLessonContent` catches this and returns `{available:false}`, and the classroom page renders a visible "currently unavailable" state with **no** Professor interaction offered — no provider call is made, and no prior attempt's output is newly surfaced as current advice. This checkpoint does not alter assessment rules and does not add an "assessment help" exception; the firewall's existing, unmodified behaviour is simply now visible from the classroom UI as well as from `executeRoleCapability` itself (which would independently refuse the call regardless of what the UI shows).

## Idempotency

A double click or a replayed form submission must not knowingly produce two provider calls for one intended learner action — and that guarantee must hold for an **out-of-order** replay too, not merely a same-key double submission.

**Correction pass (independent review, Blocker 1):** the original design compared a submitted key only against `professor_classroom_sessions.last_interaction_key` — the single most-recently-seen key. That is insufficient: `K1` (accepted) → `K2` (accepted, now the "latest" key) → a replayed `K1` would have been wrongly accepted again, since only `K2` was ever remembered. The corrected design instead gives every spent key **durable, per-classroom uniqueness**: `public.professor_classroom_interaction_reservations` holds one row per `(classroom_id, idempotency_key)` — its `PRIMARY KEY` — written once by a single atomic `insert ... on conflict (classroom_id, idempotency_key) do nothing`. `record_professor_classroom_interaction` reports `{ok:true, duplicate:false}` when that insert actually added a row (`GET DIAGNOSTICS ... row_count`), and `{ok:true, duplicate:true}` when it did not (the key was already reserved for this classroom, at any point in the past); `requestProfessorClassroom` short-circuits to `{status:"DUPLICATE"}` on the latter, before ever calling `executeRoleCapability`.

Concretely, the required ordered sequence now holds: **`K1` → proceed; `K2` → proceed; `K1` replayed → duplicate** (and a further replay of `K2` also still reports duplicate — this is not merely a two-slot window). `tests/professor-classroom-db.test.ts` tests this exact sequence directly, and also proves the reservation is scoped to `(classroom_id, idempotency_key)`, never `(idempotency_key)` alone: the identical key value reserved independently by two different learners' own classrooms proceeds for both, so one learner's reservation can never block, or be observed by, another's. The reservation table carries no learner prose, provider response, prompt, course/assessment content or token payload — only the identity of the key spent and when; it is never treated as an institutional record or an audit/evidence store, and — like `professor_classroom_sessions` — is revoked from `public`/`anon`/`authenticated`/`service_role` directly (RPC-only access), and its rows are made permanently immutable by their own `BEFORE UPDATE OR DELETE` guard trigger.

The reservation itself happens **before** `executeRoleCapability` is ever called, so two simultaneous duplicate actions can never knowingly produce two provider calls; if the subsequent `executeRoleCapability` call then fails for any reason, the already-reserved key remains permanently consumed — a retry is a new, deliberate learner action using a fresh key, never an automatic retry of the same one. `insert ... on conflict do nothing` is atomic by construction (PostgreSQL's unique-index conflict resolution guarantees exactly one of two racing inserts on the same key succeeds), but this repository's PGlite test harness is single-connection and cannot itself exercise genuine cross-connection concurrency; true independent hosted PostgreSQL concurrency acceptance remains a separate, outstanding item, exactly as already documented for migration 025's own concurrency posture — this checkpoint proves the sequential ordering guarantee, not concurrent load.

## Safe failure on an unexpected exception

**Correction pass (independent review, Blocker 3):** `requestProfessorClassroom` already caught failures from `openProfessorClassroom` and `recordProfessorClassroomInteraction`, but directly awaited `executeRoleCapability` with no failure boundary of its own. That call is now wrapped:

```ts
let result;
try {
  result = await executeRoleCapability({ ... });
} catch {
  return { status: "RETRY_LATER" };
}
```

If `executeRoleCapability` unexpectedly throws — an infrastructure, database, controller, schema or runtime exception, never expected in normal operation but never impossible either — the learner sees the same safe `RETRY_LATER` state already used for an ordinary transient provider failure: no raw exception message, no secret-looking substring, nothing is logged, and no automatic second call is made from here. The idempotency key was already durably reserved in the step before this one (see "Idempotency" above) and stays consumed regardless; a deliberate learner retry uses a fresh key. `tests/professor-classroom-actions.test.ts` proves this with a deliberately sensitive-looking rejected error (a fake connection string and controller-key-shaped substring) and asserts: the action itself never throws; the returned result is exactly `{status:"RETRY_LATER"}`; the sensitive substrings are absent from the serialized result; and `executeRoleCapability` was called exactly once.

## Production runtime profile

`src/server/academic-runtime/profile-registry.ts`'s `PRODUCTION_PROFILE_REGISTRY`, previously empty (no provider choice had been made), now has exactly one reviewed entry:

| Field                      | Value                                                                  |
| -------------------------- | ---------------------------------------------------------------------- |
| `ref`                      | `PROFESSOR_COMMERCIAL_V1`                                              |
| `adapterKind`              | `HTTP_JSON` (the existing generic server-only adapter — no vendor SDK) |
| `maxProviderCalls`         | 1                                                                      |
| `maxAttempts`              | 2                                                                      |
| `maxInputContextBytes`     | 16,000                                                                 |
| `maxOutputTokens`          | 900                                                                    |
| `totalDeadlineMs`          | 15,000                                                                 |
| `maxEstimatedCostMicrousd` | 40,000 (4 US cents)                                                    |

Every value is conservatively inside migration 025's DB hard ceiling (`maxProviderCalls` 1..3, `maxOutputTokens` 1..4000, `maxEstimatedCostMicrousd` 1..200,000). No vendor SDK, hardcoded OpenAI/Anthropic/Google dependency or credential was added; `resolveAdapterForProfile` still returns `null`, and production execution still fails closed to `NO_PROVIDER_CONFIGURED`, whenever `ACADEMIC_PROVIDER_BASE_URL`/`ACADEMIC_PROVIDER_API_KEY` are absent or invalid — unchanged from before this checkpoint. Which enrolments actually reference `PROFESSOR_COMMERCIAL_V1` is still controlled entirely by the existing, unmodified stored academic-agent configuration; no course package, browser value or classroom form field can define a provider endpoint, secret or budget.

## Safe outcome mapping

`mapRuntimeResultToClassroomOutcome` (`src/domain/professor-classroom.ts`) maps every `RuntimeResult` to one of five learner-safe states, never exposing a raw provider error, HMAC detail, controller key, usage number or internal DB id:

| RuntimeResult                                                           | Classroom outcome  | Learner sees                                   |
| ----------------------------------------------------------------------- | ------------------ | ---------------------------------------------- |
| `SUCCEEDED`                                                             | `SUCCEEDED`        | the provider's own `outputText`                |
| `ABSTAINED` / `ACTIVITY_BLOCKED`                                        | `ACTIVITY_BLOCKED` | a calm "not available right now" message       |
| `ABSTAINED` / other reason (policy/no-provider/unknown-profile/no-path) | `UNAVAILABLE`      | "Professor unavailable" — no config internals  |
| `ESCALATED`                                                             | `ESCALATED`        | an academic-review/support message             |
| `BUDGET_BLOCKED` / `TIMEOUT` / `FAILED` / `CANCELLED`                   | `RETRY_LATER`      | a safe retry/unavailable state, no raw payload |

The browser never auto-retries in a way that would multiply provider cost; a retry requires a fresh, deliberate learner action (which itself goes through the idempotency check above).

## Route and UI

`/student/classroom/[classSessionId]` (a dedicated route, not colliding with the existing `/student/[section]` dynamic segment) renders: programme and cohort, lesson title, scheduled class time, `LIVE`/`CATCH_UP` status, lesson-progress state where available, current lesson objectives, approved learning resources, current objective mastery where available, the Professor panel (`professor-classroom-panel.tsx`), and a clear return-to-classes link. `/student/classes` itself gains per-session CTAs (`Starts at…` / `Start class` / `Resume class` / `Start catch-up` / `Resume catch-up` / nothing for cancelled) derived from the same server-owned preview described above; it is not replaced. The page fits the existing `AcademyShell`/design system and is responsive at mobile widths; the panel's textarea has a real `<label>`, both actions expose disabled/pending states while a request is in flight, and status/error messages are plain accessible text, never hover-only.

## What this checkpoint does not do

No live provider call was made or attempted in this session — `ACADEMIC_PROVIDER_BASE_URL`/`ACADEMIC_PROVIDER_API_KEY` were not configured. **HOSTED PROVIDER ACCEPTANCE: PENDING.** No Professor/learner transcript is persisted anywhere (see above). No attendance, evidence, mastery, progress or grade is ever written by classroom code — proven by direct DB tests, not just by omission. TUTOR/LAB_INSTRUCTOR/EXAMINER/COUNSELLOR remain `NO_EXECUTION_PATH`, unchanged; no runtime profile was added for any of them. No payments, public sales site, course-authoring UI, native mobile app, push/email notification, full conversational memory/RAG/vector database, provider-specific SDK, model fine-tuning, arbitrary tool use or autonomous institutional write was built. Migrations 001–025 are byte-for-byte unchanged; migration 026 is the only migration added this checkpoint.
