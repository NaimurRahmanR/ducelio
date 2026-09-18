# Commercial V1 PR22 — Native AI Routing

## Scope

PR22 starts from PR21 CLOSED GREEN at
`cf3f0b5cd4b9759c2e8108e832ee24d6b6b78759`.

It replaces the generic gateway route used by the four existing production
academic runtime profiles with native server-side HTTP adapters while leaving
all role/profile references, database execution contracts and institutional
authority unchanged.

The fixed routing is:

| Academic role | Provider adapter | Reviewed model |
| --- | --- | --- |
| PROFESSOR | OpenAI Responses | `gpt-5.6-terra` |
| TUTOR | OpenAI Responses | `gpt-5.6-luna` |
| LAB_INSTRUCTOR | Anthropic Messages | `claude-sonnet-5` |
| EXAMINER | OpenAI Responses | `gpt-5.6-luna` |

No browser, learner, course package or stored agent configuration can select a
vendor, model, endpoint, API key or tariff. They can only reference the same
role-bound profile ids already governed before this checkpoint.

## Cost governance

Tariffs are code-owned reviewed snapshots dated 2026-09-18 and are used only
to produce the provider-neutral `estimatedCostMicrousd` consumed by the
existing post-call budget reconciliation.

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

PR22 deliberately does **not** provider-enable the existing academic
`COUNSELLOR` role. That role is the privacy-sensitive assigned learner
support plane and remains `providerBacked:false`.

A future free public/prospect admissions counsellor must be a separately
bounded public-catalogue surface rather than silently reusing the academic
support role or its private learner context.

## Evidence and non-claims

PR22 tests native request/response mapping, refusal handling, secret hygiene,
role routing, tariff arithmetic, database-ceiling compatibility and fail-closed
missing-key behaviour using deterministic mocked HTTP responses.

No OpenAI or Anthropic live request is made by this checkpoint. Passing local
or GitHub CI therefore does **not** establish provider quality, latency,
billing accuracy against a real invoice, hosted Supabase behaviour or
production readiness. Those remain post-PR24 paid acceptance gates.
