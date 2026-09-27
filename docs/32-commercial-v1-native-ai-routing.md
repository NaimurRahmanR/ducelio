# Commercial V1 PR22 — Native AI Routing

## Scope

PR22 starts from PR21 CLOSED GREEN at
`cf3f0b5cd4b9759c2e8108e832ee24d6b6b78759`.

It replaces the generic gateway route used by the four existing production
academic runtime profiles with native server-side HTTP adapters while leaving
all role/profile references, database execution contracts and institutional
authority unchanged.

The fixed routing is:

| Academic role       | Provider adapter   | Reviewed model    |
| ------------------- | ------------------ | ----------------- |
| PROFESSOR           | OpenAI Responses   | `gpt-5.6-terra`   |
| TUTOR               | OpenAI Responses   | `gpt-5.6-luna`    |
| LAB_INSTRUCTOR      | Anthropic Messages | `claude-sonnet-5` |
| EXAMINER            | OpenAI Responses   | `gpt-5.6-luna`    |
| COUNSELLOR          | OpenAI Responses   | `gpt-5.6-luna`    |
| OPERATIONS_ENGINEER | Anthropic Messages | `claude-opus-5-5` |

**Routing correction (after PR #32):** `OPERATIONS_ENGINEER` was originally
routed to OpenAI Responses / `gpt-5.6-terra` with high reasoning effort. It now
routes to Anthropic Messages / `claude-opus-5-5` through the existing native
Anthropic adapter. Only that one profile changed; the other five mappings, the
Operations Engineer budget policy and all authority restrictions are unchanged.

No browser, learner, course package or stored agent configuration can select a
vendor, model, endpoint, API key or tariff. They can only reference the same
role-bound profile ids already governed before this checkpoint.

## Cost governance

Tariffs are code-owned reviewed snapshots dated 2026-09-18 (the Operations
Engineer's Claude Opus 5.5 snapshot — $4 input / $20 output per million
tokens, standard API pricing — is dated 2026-09-27) and are used only to
produce the provider-neutral `estimatedCostMicrousd` consumed by the existing
post-call budget reconciliation.

OpenAI input is deliberately charged by this adapter at the full input tariff
even when the API reports cached input. Anthropic input accounting sums base,
cache-creation and cache-read tokens and deliberately charges all of them at
the full input tariff. Both choices can overestimate cost; neither can
understate it because of a cheaper cache rate.

The existing database ceilings remain untouched. PR22 does not add a
migration. Professor and Lab profile cost ceilings are narrowed/adjusted only
inside limits their existing database contracts already admit. All four
production profiles now state `maxAttempts:1`, matching their one-call
admission envelope; Professor's historical `maxAttempts:2` could never make
a second provider call while `maxProviderCalls` was already 1.

## Native API boundary

OpenAI uses the fixed HTTPS `/v1/responses` endpoint, `store:false`, a
server-owned model, bounded `max_output_tokens`, and the profile's reviewed
reasoning effort. The raw response is parsed from typed output content rather
than assuming the SDK-only convenience `output_text` field exists.

Anthropic uses the fixed HTTPS `/v1/messages` endpoint with the stable API
version header and bounded `max_tokens`. Content is selected by block type,
so adaptive-thinking blocks cannot be mistaken for learner-facing text.
`stop_reason: refusal` is mapped to the existing provider-refusal outcome.

Both adapters refuse redirects, never put keys in browser-visible variables,
map bounded provider failures into the existing runtime vocabulary and leave
timeouts/retries to the existing governed runtime.

## Prompt and institutional authority

The adapter adds a server-owned instruction telling the model to treat all
supplied context, including learner prose, as data rather than authority.
Provider output remains advisory until the existing deterministic controller
accepts it. It cannot alter enrolment, permissions, mastery, attendance,
payment or academic records.

Examiner calls additionally receive the already-existing strict JSON output
contract. The existing Examiner domain parser and database finalizer remain
the authority on whether marks are valid and publishable.

## Counsellor boundary

PR22 defines **one continuing institutional Counsellor role**, not separate
prospect/support bots. Its execution context is segmented into three reviewed
modes: `PROSPECT`, `ACTIVE_COURSE`, and `POST_COURSE`.

- PROSPECT may use public catalogue/pricing/prerequisite context, help a user
  choose a course, and capture optional prospect preferences.
- ACTIVE_COURSE may use only learner-owned logistics/support context and may
  create structured academic handoffs. It does not receive Professor/Tutor/
  Examiner authority and must not freely share private support conversations.
- POST_COURSE may use learner-owned completion/progression context and explain
  next-course/re-enrolment options.

The historical academic-agent `COUNSELLOR` entry remains
`providerBacked:false` because it is tied to the privacy-sensitive assigned
support data plane and migration 036. PR22 does not silently open that plane.
Instead, `COUNSELLOR_PLATFORM_V1` defines the native routing profile for the
same institutional persona. A later execution slice must bind each mode to its
own deterministic context gate before live calls are allowed.

Counsellor is permanently prohibited from teaching course content, solving
labs, answering controlled assessments, grading, changing institutional
records, acting as a general chatbot, or acting as a therapist/diagnostic
agent.

## Operations Engineer boundary

PR22 also defines `OPERATIONS_ENGINEER_PLATFORM_V1` as an **internal,
admin-facing** AI role. It is routed to Claude Opus 5.5 (`claude-opus-5-5`,
Anthropic Messages) for its internal coding and systems-reasoning work; it is
no longer routed to OpenAI Terra. It reuses the existing native Anthropic
adapter (no Opus-specific adapter) and is gated only by `ANTHROPIC_API_KEY`.
Its capability catalogue is observation/proposal only: system
health, provider failures, usage/cost, jobs/CI, migration status, error
summaries, proposed fixes, proposed PRs, and draft release notes.

It has no raw database or shell access, no service-role credentials, no secret
access, no autonomous GitHub mutation, no merge authority and no production
deploy authority. The intended path remains:

`Admin -> Operations Engineer -> permissioned deterministic tools/services -> systems`

PR22 defines routing and policy only; it does not create a production
Operations Engineer tool-execution plane. The routing correction to Claude
Opus 5.5 changes none of these authority restrictions and does not create
that plane either.

## Evidence and non-claims

PR22 tests native request/response mapping, refusal handling, secret hygiene,
role routing, tariff arithmetic, database-ceiling compatibility and fail-closed
missing-key behaviour using deterministic mocked HTTP responses.

PR22 itself made no live provider request. Subsequent dedicated acceptance work
has now exercised three fixed production-profile paths with explicitly
authorized, single-request paid smokes through the current production adapters
and governed runtime:

- `EXAMINER_COMMERCIAL_V1` -> `OPENAI_RESPONSES` -> `gpt-5.6-luna`:
  **LIVE-PROVIDER-TESTED**;
- `LAB_INSTRUCTOR_COMMERCIAL_V1` -> `ANTHROPIC_MESSAGES` ->
  `claude-sonnet-5`: **LIVE-PROVIDER-TESTED**;
- `OPERATIONS_ENGINEER_PLATFORM_V1` -> `ANTHROPIC_MESSAGES` ->
  `claude-opus-5-5`: **LIVE-PROVIDER-TESTED**.

The Operations Engineer live run made exactly one provider request and one
attempt, returned `SUCCEEDED`, used 321 input tokens and 179 output tokens,
reported 4,864 micro-USD estimated cost and 3,837 ms elapsed time, and remained
inside its pinned production profile envelope. The raw model response is not
acceptance evidence and was not recorded in this document.

These results prove only the named live-provider surfaces. They do **not**
establish provider/model quality, production billing accuracy against an
invoice, production readiness, or an Operations Engineer production
tool-execution plane. Hosted database/application acceptance and operational
launch gates remain separately classified.
