# PR14 — Production Course Engineering Admin

PR14 starts from merged main `58c6216fa2a992623f309b78ad459bba3993bca7`
(PR #15, Commercial V1 PR13 commerce onboarding). PR13 is CLOSED GREEN.
PR14 remains uncommitted and subject to independent review, commit, push,
PR-head CI, merge and post-merge main CI. This checkpoint does not declare
Commercial V1 production-ready.

## Operator journey

Open **Administration → Programmes → Course & Agent Engineering** at
`/admin/course-engineering`. The existing StaffShell is reused.

1. Choose a UTF-8 `COURSE_PACKAGE_V1` JSON file and supply a 5–300 character
   administrative reason. The server checks the authenticated administrator
   before reading the file, requires a non-empty `.json` upload and limits it to
   512 KiB. Next's existing default Server Action request limit remains unchanged.
   JSON parsing never evaluates content or accepts a filesystem path.
2. Import through `importCoursePackage`. The existing database authority owns
   identity, revision-conflict handling, content hashing and staging. The file is
   not written to disk or added to source control. Follow the returned review link.
3. Review the authoritative lifecycle list: key/revision/schema/status/hash,
   programme/version IDs and available timestamps. Listing failure is displayed
   as unavailable, not as an empty successful list.
4. Validate using `validateStagedCoursePackage`. That service reads the staged
   content, performs the domain checks and invokes the existing database
   validation authority. Failure rejects that revision under the existing
   lifecycle; correct the file and import a new revision. The UI shows at most
   twenty sanitized structural locations, never arbitrary validation messages,
   uploaded values or the full successful validation result.
5. Inspect the safe preview and proposed agent configuration. Preview failure
   does not prevent validation/rejection: lifecycle actions use metadata, not the
   potentially malformed package preview, to locate the selected import.
6. Apply through `applyCoursePackage`. Apply creates the draft ProgrammeVersion
   ID required by `setAgentConfig`, so persisted agent configuration follows Apply.
7. Explicitly save each of the five roles using its governed form. Proposals are
   shown separately and never automatically copied or saved by this page.
8. Publish through `publishCoursePackage` only after all five saved role
   configurations semantically match the reviewed package proposal. The admin
   surface re-reads authoritative metadata, redacted preview and saved configs
   server-side before delegation; the canonical programme publication authority
   remains unchanged. Applied/published identifiers remain visible.
9. Once PUBLISHED and all five configurations still match the proposal, follow
   **Activate course delivery** to `/admin/activation?importId=<UUID>`.
10. Existing activation controls select the cohort/instructor and materialise
    delivery. On confirmed activation success the form offers **Continue to
    commercial offers**, linking to `/admin/commerce`. Commerce retains offer
    creation/archive and explicit pricing authority.

Lifecycle controls follow database state: IMPORTED allows Validate/Reject;
VALIDATED allows Apply/Reject; APPLIED offers Publish only when all five saved
agent configurations match the reviewed proposal; PUBLISHED and REJECTED have
no lifecycle mutation controls here. Actions re-read metadata before
calling the existing authority, and the database remains the final concurrent
state validator. No delete, rollback or unsupported undo is added.

## Authorization and safe presentation

The page requires the existing ACADEMIC_ADMIN/PLATFORM_ADMIN role gate. Every
Server Action independently obtains fresh backend identity and checks those
roles before processing inputs. Existing services and RPCs then enforce their
own authorization. Browser role fields are never used. Agent configuration
derives the exact programme-version ID from the selected import metadata rather
than accepting it from the form.

Only `getCoursePackagePreview` supplies preview content. The page does not call
the full-content RPC. Its additional `operatorPreviewSchema` allowlist strips
unknown root fields, removes package audit prose and reduces assessment
questions to counts/total marks. Question prompts, expected answers and marking
guidance never enter rendered preview components or client props. Programme,
module, lesson, objective, resource, practical and assignment information remains
available, along with schedule defaults and proposed role configuration.
All prose renders as React text. Resource URLs are shown as text; uploaded
content cannot create a navigation target or inject HTML.

The full validation result deliberately stays server-side: its success branch
contains the unredacted package. Actions return only fixed outcome messages and
sanitized issue locations. Errors never return raw SQL/PostgREST diagnostics,
JSON parser excerpts, file contents or protected answers. No new logging of
uploaded/protected content is added. These controls protect designated assessment
fields; operators must still avoid embedding confidential assessment material
inside ordinary teaching prose or configuration notes.

## Explicit agent configuration and existing activation semantics

`setAgentConfig` and `listAgentConfigs` remain canonical. PROFESSOR, TUTOR,
LAB_INSTRUCTOR, EXAMINER and COUNSELLOR forms use the existing code-owned
capability catalogue and input schema. There are no new capabilities or profile
registrations. The model profile field names an already reviewed configured
runtime profile; saving a name does not create or enable an execution path.
Missing configuration remains fail-closed in the existing runtime.

Until saved, each form starts disabled with no selected capabilities. The package
proposal is displayed alongside it, so the administrator can review and enter
the intended configuration explicitly. Import, validate, preview and Apply do
not invoke `setAgentConfig` from this UI. Publish independently re-reads the
redacted proposal plus saved rows and fails closed unless all five roles match;
it never auto-saves a proposal.

Migration 027's existing activation authority is unchanged: it requires matching
version-level configurations, creates missing ones from package proposals through
its existing governed workflow, and refuses conflicting existing rows. PR14's
handoff is offered only after all five rows have been explicitly saved. That
handoff condition is an operator workflow guard, not a replacement for database
authorization or a change to direct activation RPC semantics. Configurations
must match the package proposal for activation; a changed proposal requires a
corrected package revision. This page does not silently reconcile conflicts.

## Commercial V1 test-stage boundary

The frozen Commercial V1 authoring contract includes a distinct
`upload → validate → preview → configure agents → test → publish` lifecycle.
PR14 does **not** implement that dedicated governed test-before-publish stage.
The publication-readiness comparison above proves configuration consistency; it
is not a substitute for the future governed test stage. Course & Agent
Engineering therefore remains partially open after PR14, and Commercial V1 is
not production-ready on the strength of this admin surface alone.

## Scope and tests

No migration or course-specific production data is added. Historical migrations
remain unchanged. Course packages are runtime administrative input, so a new
valid package requires neither application source changes nor a redeployment.
The new code calls existing authorities only; it introduces no table writer,
generic RPC proxy, service-role client, assessment-firewall change or provider
integration.

Focused coverage uses the existing `tests/activation-fixture.ts` test package.
It is never auto-seeded or exposed as a production course. New tests exercise
role denial, malformed/oversized/non-UTF-8 input, lifecycle delegation and stale
states, safe validation feedback, agent allowlist checks and version derivation,
SSR/page-prop sentinel exclusion, activation/commerce links and truthful read
failures. A PGlite test runs the actual new actions and actual existing services
through import → validate → preview → apply → explicit role saves → publish,
including proof that Apply alone creates no agent configuration.

New tests: 33. Combined focused Course Engineering/package/agent/activation
regressions: 197 tests across eight files. On Node v24.19.0, `npm run check`
passed lint, typecheck and 1,708 tests across 77 files. Production build,
`format:check` and diff whitespace checks passed. PR14 remains unapproved;
local validation does not substitute for independent review or hosted acceptance.

Remaining acceptance: authenticated hosted browser upload/refresh and
mobile/accessibility review, hosted Supabase/JWT/PostgREST and production
infrastructure acceptance. SSR and PGlite are local checks, not proof of those
deployments. The existing activation workflow still requires a matching cohort
and instructor. Pricing, payment readiness, course-content review and existing
runtime provisioning remain separate institutional responsibilities. Files above
512 KiB require a future reviewed upload-bound change; this checkpoint does not
silently raise request limits or introduce chunked uploads.
