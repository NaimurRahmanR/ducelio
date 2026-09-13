# Professor execution governance — Phase 3 Checkpoint 1D-B1

B1 adds a provider-neutral trusted execution control plane. No provider, model call, prompt, generated answer, chat, public endpoint, academic write or actual usage/cost accounting exists. `PROFESSOR_READ_V2` is unchanged. The new execution policy is `PROFESSOR_EXECUTION_V1`, with execution kind `CONTROL_PLANE_ONLY`.

## Architecture decision and trust root

The current deployment uses Next.js on Node and Supabase through a publishable key and the authenticated human session. An RPC granted to `authenticated` therefore proves no independent server identity. `server-only` protects import boundaries; it does not turn an authenticated RPC into a trusted-server operation.

B1 requires **both the authenticated learner session and an HMAC-SHA256 attestation from the Ducelio execution controller**. PostgreSQL independently verifies the MAC and constrains every transition. Possessing the controller key authorizes only the reviewed execution-command protocol through this path; it grants no table, SQL, support-record, assessment-content or academic-write privileges. The human remains a STUDENT principal; PROFESSOR is fixed and is never a database principal or RoleGrant.

Alternatives considered:

- A dedicated narrowly privileged database login could establish server identity, but this stack has no server PostgreSQL driver, connection pool or deployment/provisioning path for that login. It would also require a separately reviewed binding from that connection to verified learner identity. HMAC composes with the existing authenticated session and installed cryptographic primitives without introducing an application database credential.
- An asymmetric attestation could avoid a shared verification secret, but a reviewed matching verifier is not part of the current database/runtime stack. B1 does not implement custom signature cryptography to bridge that gap.
- An ordinary authenticated RPC, hidden route or TypeScript-only convention cannot establish the required identity. A broad Supabase service-role credential is unnecessary and is not introduced.

The trust root is the matching 32-byte controller secret held by the trusted Node server and the protected database key store, plus existing Supabase identity verification. Database owners and operators who can read the key store/backups remain trusted: HMAC is symmetric. This is not isolation from a compromised trusted server, database owner or privileged infrastructure operator.

Migration 022 explicitly revokes service_role access to `academic_executions`, `academic_content_releases`, the execution RPC, the private schema/key table and all private install/verify/projection/guard/audit functions. It also revokes access to the migration 021 begin/close and release helper functions. For `audit_events`, INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER are revoked while existing SELECT is preserved. Column-level INSERT/UPDATE/REFERENCES grants are cleared on all four protected tables, because a table-level REVOKE alone does not clear them. An effective-ACL assertion fails migration if inherited privileges still permit these mutations or private/helper access; it never removes grants required by the authenticated learner path. B1 application code uses no service-role credential.

Existing institutional audit triggers have fixed operation/table targets; they are not arbitrary execution-event writers. Preventing release/execution table mutation, preventing access to their dedicated trigger functions and denying direct audit mutation closes the reviewed Data API forgery paths. Hosted ACL/default-privilege, role-membership and object-ownership acceptance remains required, including after later migrations or operator grant changes. Database owners remain privileged operators, not the service-role runtime boundary.

## Secret provisioning and cryptography

Migration `202609100022_phase3_trusted_execution_governance.sql` creates an **empty** `academic_execution_private.controller_keys` table. It contains key UUID, 32-byte secret, installation time and optional revocation time. The private schema is not in the configured PostgREST exposed schemas. Schema/table privileges and helper-function execution are revoked from PUBLIC, anon and authenticated; RLS has no learner policy. No authenticated read/provisioning path exists. Function source contains no secret value.

Production provisioning is an outstanding, out-of-band operator procedure:

1. Generate a fresh random 32-byte secret and key UUID for each environment using an approved secret-management process.
2. Over a protected database-owner connection, invoke `academic_execution_private.install_controller_key(uuid, bytea)` with bound binary parameters. The function is SECURITY INVOKER and is not granted to application users. Do not paste secret literals into migration SQL, SQL-editor history, command-line arguments or shell history. Validate that database, proxy and operator tooling do not log secret bind values, including on failure.
3. Supply the same key as 64 lowercase hex characters through the trusted server's secret manager as `ACADEMIC_EXECUTION_HMAC_KEY_HEX`, with its UUID in `ACADEMIC_EXECUTION_KEY_ID`. Never use a NEXT_PUBLIC name, build-time client configuration, provider adapter argument or committed environment file.
4. Restrict operator/key-store/backup access and verify transport, backup protection and logging before deployment. For rotation, install a new key ID, switch the trusted server configuration and revoke the old key with a DB-clock `revoked_at`; do not replace historical execution records. Review coordinated rollout and emergency revocation operationally.

No real secret is provisioned by this checkpoint. Empty, malformed, mismatched or revoked configuration fails closed. Tests provision randomly generated ephemeral **test-only** keys through bound parameters; there are no production secrets or key snapshots. The application emits no secret, MAC, raw RPC diagnostic or validation payload in its results or audits. Transport request logging must remain disabled/redacted for attestations; logs must never capture provisioning secrets.

Node's `createHmac('sha256', key)` and PostgreSQL's `extensions.hmac(message, key, 'sha256')` implement the standard primitive. Migration 022 requires pgcrypto in `extensions` and fails rather than silently relocating an existing installation. MAC input is UTF-8. Supplied tags must be exactly 64 lowercase hex characters, decoded into 32 bytes. Comparison visits all 32 bytes and accumulates differences without an early exit or text/case conversion of the tag. This fixed-work comparison is not a formal constant-time guarantee for the PostgreSQL interpreter or hosted network; hosted cryptographic/timing review remains required. See the primary [PostgreSQL pgcrypto documentation](https://www.postgresql.org/docs/current/pgcrypto.html) and [Node crypto documentation](https://nodejs.org/api/crypto.html).

## Canonical protocol and replay

The canonical message consists of exactly these 16 fields, separated by one ASCII LF byte, with **no trailing LF**:

```text
DUCELIO_EXECUTION_HMAC_SHA256_V1
PROFESSOR_EXECUTION_V1
PROFESSOR
key_id
authenticated_app_user_id
execution_id
release_id
operation
requested_state
requested_reason
max_provider_calls
max_input_tokens
max_output_tokens
max_estimated_cost_microusd
issued_at_epoch_seconds
expires_at_epoch_seconds
```

UUIDs use lowercase canonical PostgreSQL UUID spelling. Integers use ordinary base-10 notation with no padding, sign, exponent or fractional component. Operations/states/reasons are exact allowlisted ASCII symbols; active commands use reason `NONE`. All fields are required and none permits free-form text, LF, arbitrary JSON or caller-selected identity/profile/policy. These restrictions make the delimiter unambiguous. The database reconstructs the message independently, deriving the actor from `current_app_user()` and fixing profile/policy itself.

The signed release UUID binds its immutable owner, academic capability, V2 contract and invocation from migration 021. Admission copies that database-owned invocation; the server independently checks the returned invocation against the gateway's release grant. No separate caller-supplied invocation/actor/profile field can override those relationships.

An attestation expires exactly **10 seconds after its integer issuance time**. DB clock must be strictly before that expiry and issuance may be at most **5 seconds ahead** of DB time. A server clock behind the database consumes the ten-second validity window; a clock too far ahead is rejected. Verification runs before and again after acquiring the learner lock. The five-second tolerance can allow acceptance before the stated issuance time; it never changes the signed expiry. Operational clock synchronization is required. No browser clock or configurable client lifetime is used.

Execution UUID is the durable lifecycle identity and each release can bind only one execution (`UNIQUE release_id`). AUTHORIZE requires a new execution/release pair; START requires AUTHORIZED; FINALIZE requires an allowed nonterminal state. Repeated AUTHORIZE, START or terminal commands are rejected with `REPLAY_REJECTED`, including the exact captured packet and an otherwise identical freshly signed terminal request. Timeout history instead reports `EXECUTION_TIMEOUT`. No replay writes a second lifecycle event or renews a deadline. State transitions, immutability and uniqueness provide replay protection without a process-local nonce cache. A rolled-back command was never accepted durably; uncertain acknowledgements fail closed rather than creating a replacement lifecycle.

The only public execution RPC is `govern_professor_execution`, with typed key/execution/release UUIDs, operation/state/reason, bounded budget proposal, issuance/expiry and MAC. It accepts no arbitrary payload, SQL or audit JSON. No standalone generic verifier or signing oracle is exposed: this RPC necessarily validates a MAC only for its fixed, typed execution-governance protocol and returns bounded acceptance/denial. Private `verify_command` and `execution_projection` helpers are inaccessible to authenticated and service_role callers. A browser may call the public RPC directly but cannot forge an accepted command without the secret. Captured authorized packets are short-lived and usable for at most their exact single transition, still requiring the matching authenticated learner.

## Lifecycle, admission and budget

The database takes the same `student_profiles WHERE user_id = current_app_user() FOR UPDATE` lock as migration 021. It finalizes stale executions and releases before checking the current command. Identity, release, policy, budget and deadline are immutable. Terminal execution rows cannot change and deletion is forbidden. RLS is enabled with no ordinary learner execution-history query or direct mutation grants.

| State      | Meaning and allowed transition                                                                                                                                   |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AUTHORIZED | Trusted controller admission passed; may become RUNNING or FAILED                                                                                                |
| RUNNING    | Controller opened the bounded execution; may become SUCCEEDED, FAILED, ABSTAINED or ESCALATED                                                                    |
| SUCCEEDED  | Terminal control-plane completion with `CONTROL_PLANE_COMPLETE`; exercised only by explicit lifecycle fixtures in B1, never emitted by its production controller |
| FAILED     | Terminal policy, timeout, validation or internal failure                                                                                                         |
| ABSTAINED  | Terminal intentional absence of an academic answer                                                                                                               |
| ESCALATED  | Terminal request for the fixed `ACADEMIC_REVIEW` path; no notification, queue delivery or completed human review is claimed                                      |
| BLOCKED    | Terminal admission refusal with RATE_LIMITED or BUDGET_BLOCKED; never RUNNING                                                                                    |

Versioned pre-production **security/abuse ceilings**, not commercial/subscription quotas:

- One active AUTHORIZED/RUNNING execution per learner.
- At most five new execution admissions in the preceding 60 seconds and 30 in the preceding hour. The count uses DB `created_at > now - window`, including persisted BLOCKED admissions; at the ceiling a new record is BLOCKED rather than admitted. Replays and invalid attestations do not create execution rows.
- Maximum execution lifetime is 20 seconds, capped again by the bound release's expiry, with no renewal.
- Accounting/verification/persistence failure denies execution. A valid later command lazily marks stale AUTHORIZED/RUNNING records FAILED/EXECUTION_TIMEOUT with `terminal_at = expires_at`; no scheduler or new credential is needed for admission exclusion.

The DB owns these constants. The controller cannot accept larger quotas from browser JSON, and even a correctly signed nonzero budget proposal is BUDGET_BLOCKED. Policy changes require review and a database migration.

The provider-neutral budget envelope is **zero provider calls, zero input tokens, zero output tokens and zero estimated USD micro-units** in B1. One micro-USD means one millionth of a US dollar, represented as an integer. These fields are ceilings, not observed usage or charges. There is no actual cost/usage record. This B1 envelope itself remains unchanged: migration 022 is not edited by any later checkpoint. A reviewed nonzero envelope, provider-specific accounting and actual reconciliation now exist as a **separate**, distinctly identifiable V2 policy/table (`PROFESSOR_EXECUTION_V2`/`PROVIDER_BACKED_V1`, migration 025) rather than a change to this one — see `docs/19-live-professor-execution.md`. No payments/plans are implied.

Direct release-RPC abuse and invalid-MAC request floods are not solved by execution admission accounting. Perimeter request limits and storage/operational protection remain rollout gates; these controls do not claim tested distributed or network abuse protection.

## Composition with 1D-A and server port

`src/server/academic-execution/index.ts` exposes server-only `executeProfessorRead(request)` with the seven academic capability names and their existing strict inputs. It obtains verified STUDENT identity and generates the execution UUID. No client-supplied execution, release, actor, role, profile, budget, outcome or signature is accepted. No route or Server Action exposes it.

The existing gateway's `withValidatedProfessorContent` composition point keeps one original release active while the controller runs. Ordering is:

1. Gateway authenticates, validates input, begins the 30-second release and enforces EXPLAIN.
2. Existing Academy OS services retrieve self-owned exact-version context; gateway strictly validates output and requested references.
3. Controller attests AUTHORIZE, START and its terminal operation. Each RPC independently validates the authenticated learner, owned ACTIVE/unexpired academic release and current EXPLAIN policy under the shared learner lock. No future provider adapter is invoked in B1.
4. Gateway revalidates the principal and final EXPLAIN permission, closes the release, then returns. B1 discards the content and returns only the terminal execution metadata.

The normal B1 terminal outcome is **ABSTAINED/POLICY_BLOCKED**, because no provider is enabled. `ok: true` means this control-plane workflow completed with abstention, not an academic answer or provider success. SUCCEEDED/provider-specific failures are never selected from browser/provider JSON.

COMPLETED, ABORTED, EXPIRED, BLOCKED, foreign and missing releases cannot admit execution. A direct learner closure during execution makes subsequent trusted operations fail; it cannot create success. Release-close or audit persistence failure overrides other outcomes with SERVICE_UNAVAILABLE and discards the result. Invalid DB output and principal/correlation conflicts fail closed. After successful admission, a validated START/FINALIZE denial of POLICY_BLOCKED, ACTIVITY_BLOCKED, CONTENT_RELEASE_UNAVAILABLE or EXECUTION_TIMEOUT confirms DB terminal failure for that immutable learner/execution/release binding. The authority marks that server-internal error as DB-terminal; the controller preserves its code without an INTERNAL_ERROR rewrite. AUTHORIZE denials, transport errors and malformed responses provide no such terminal evidence. Those uncertain admitted failures still attempt FAILED/INTERNAL_ERROR cleanup; inability to establish terminal cleanup remains SERVICE_UNAVAILABLE. A DB policy terminal during cleanup also establishes failure. An unavailable database or uncertain acknowledgement may leave a bounded active record until lazy expiry. Already terminal audit history is never rewritten to hide a later delivery failure. No read-back RPC or canonical/protocol change was needed.

The secret-aware transport remains in `src/server/academic-execution/authority.ts`; it signs only constrained operations and returns validated metadata, never a MAC, signing callback or Supabase client. The pure `AcademicExecutor` interface is a future design port only: bounded content, capability, execution reference, deadline and budget. There is no adapter implementation/registration in this B1 path. Its own V2 counterpart (`src/server/academic-provider-execution/authority.ts`, `docs/19-live-professor-execution.md`) reuses this same controller-key trust root under a distinct protocol tag and never grants a provider adapter controller credentials or generic Academy OS RPC access.

The 30-second release is unchanged. B1 does not solve future provider latency, cancellation or content reuse after expiry; the later V2 checkpoint (`docs/19-live-professor-execution.md`) runs the provider strictly inside that same still-open release and defers any durable success determination until after the release has itself closed successfully, but does not change the release's own 30-second lifetime or lease semantics. Expiry or owner closure may still allow an assessment to start while external work is still pending. The present lease orders authorization; it cannot retract bytes or content already supplied to a future external process.

## Audit, failure and privacy semantics

Existing `audit_events` receives fixed, allowlisted metadata from a dedicated trigger in the same transaction as the execution row. Events are EXECUTION_AUTHORIZED/RUNNING/SUCCEEDED/FAILED/ABSTAINED/ESCALATED/BLOCKED. Timeout cleanup identifies `DATABASE_EXECUTION_POLICY`; other transitions identify `ATTESTED_EXECUTION_CONTROLLER`, meaning a verified controller command caused a DB-governed transition. The database may force FAILED because the release, role or activity is no longer valid; the event records the actual state, not a claim that the requested outcome was accepted.

Structured admission refusal persists BLOCKED and its audit instead of raising and rolling them back. Audit failure rolls back the execution transition. Invalid/untrusted/replayed commands do not fabricate trusted lifecycle records. The existing Platform Admin audit read policy remains; an ordinary learner cannot inspect the execution table, mutate audit records or access keys. Extra institutional roles never grant signing authority.

A verified MAC proves only that **a component possessing the Ducelio controller secret authorized that exact bounded command**; the database determines whether it may take effect. B1 audit records the resulting execution-control lifecycle. It does not prove that a specific TypeScript function ran, that a model ran, that a provider was contacted, that content was delivered, that an answer was correct or that a learner read anything. Migration 021 release authorization, B1 controller authorization and future B2 provider execution remain three distinct claims.

Controller-key UUID attribution is explicitly deferred: it is signed and checked but not persisted with each transition. Historical audit therefore proves verification by some active controller key, not which active key authorized that transition. Rotation/incident review must account for that limitation. No MAC or secret is retained in execution/audit metadata.

Enabled reasons cover ACTIVITY_BLOCKED, CONTENT_RELEASE_UNAVAILABLE, RATE_LIMITED, BUDGET_BLOCKED, EXECUTION_TIMEOUT, OUTPUT_INVALID, POLICY_BLOCKED, ABSTAIN_UNCERTAIN, HUMAN_REVIEW_REQUIRED, INTERNAL_ERROR and the fixture/future state-machine reason CONTROL_PLANE_COMPLETE. Only reviewed state/reason pairs are allowed. PROVIDER_UNAVAILABLE and PROVIDER_ERROR are reserved domain vocabulary; the B1 SQL/controller cannot emit them. Stable transport errors include UNAUTHENTICATED, FORBIDDEN, INVALID_INPUT, UNTRUSTED_EXECUTION, REPLAY_REJECTED, CONTEXT_CONFLICT and SERVICE_UNAVAILABLE. Messages contain no raw SQL/PostgREST diagnostics or free-text reason. Neither sentiment nor behavioural inference triggers escalation; this layer produces no grade, mastery or risk judgment.

Execution rows and lifecycle audit contain identifiers, fixed profile/policy/kind, constrained state/reason/review path, timestamps and the zero envelope only. They contain no prompts, model inputs/outputs, resource bodies, objective prose, evidence references, assessment prompts/answers/guidance, learner answers, counselling/support prose, credentials, signatures, arbitrary JSON or sensitive-content hashes. The key store is separate from execution/audit records. Exact metadata retention duration is an undecided production governance requirement; B1 adds no unrestricted delete endpoint and does not weaken institutional audit immutability. Future governed retention must preserve those obligations without introducing content storage.

## Verification and B2 prerequisites

The corrected local gate used bundled Node **v24.19.0**: **115 focused B1 tests** (68 execution DB + 47 execution workflow); `npm run check` passed lint/type generation/TypeScript and **438 tests across 29 files**, preserving the earlier capability/release and Academy OS coverage. Production build, formatting and `git diff --check` also passed. B1 has passed final second review, is committed/pushed at `85d3b85`, and PR #2 CI passed on that head; PR #2 is now merged at `52720f5` and post-merge main CI passed. Production acceptance remains outstanding.

The fixture includes service_role with BYPASSRLS, broad schema/table/function defaults and pre-existing audit/release column grants. ACL and real-operation tests deny service-role INSERT/UPDATE/DELETE of execution/release/audit rows, key/helper access and even a valid signed execution RPC, preserve audit SELECT/authenticated entry points, and reject unsafe inherited rights in deployment acceptance. Exact workflow assertions cover all four DB-governed terminal codes at START and FINALIZE with one terminal audit and no redundant cleanup command, plus successful/failed necessary cleanup after transport uncertainty. Privileged activity/deadline fault injection does not claim normal assessment start bypasses the release lock.

Local focused tests exercise actual Node signing and pgcrypto reconstruction in PGlite, authenticated privileges/RLS, private-key access denial, forgery and every bound-field alteration, expiry, exact captured-command replay after committed transitions, terminal/delete guards, admission windows, zero budgets, timeout cleanup, release/firewall composition, all seven real-service controller workflows, strict malformed-output denial, role changes, privacy and audit-failure rollback. Historical-window/timeout fixtures use privileged test-only timestamps; there is no runtime clock override.

These tests do not prove hosted Supabase/JWT/PostgREST acceptance, production secret provisioning, cryptographic side-channel resistance, process/network isolation, true multi-process distributed admission, true concurrent PostgreSQL behavior or any provider acceptance. PGlite exercises sequential semantics; **two independent concurrent PostgreSQL connections have not been tested**.

Provider integration remains blocked pending hosted key/grant/pgcrypto/RPC acceptance, protected provisioning/rotation/logging/backup review, true concurrent learner-lock acceptance, provider/process isolation, generation/lease-expiry design, model-specific budget/reconciliation/overrun controls, retention decisions and reviewed failure/abstention/escalation/human-review delivery policy. No legal retention duration or commercial quota has been invented.
