# Assessment and homework firewalls

Assessment authorization must consult server-owned activity state before releasing protected content or invoking academic actors. Prompt-only enforcement is insufficient.

Checkpoint 11 introduces the first technical controlled-assessment foundation:

- assessment metadata follows DRAFT → PUBLISHED → CLOSED lifecycle;
- protected questions and answer keys exist outside ordinary learner-readable tables;
- published questions and answer keys are immutable;
- learners receive question prompts only through the controlled release RPC and only while they have a server-owned ACTIVE attempt inside the assessment window and attempt expiry;
- answer keys and marking guidance are never returned by learner delivery services;
- assessment responses are append-only revisions bound to the authenticated learner, active attempt and assessment question;
- an ACTIVE attempt sets `current_academic_activity_state()` to `CONTROLLED_ASSESSMENT_ACTIVE`;
- `academic_action_allowed()` blocks normal academic-help actions such as explain, hint, critique, final-answer generation, submission generation and practice while the controlled attempt is active;
- only examiner delivery and counsellor logistics remain permitted by the current firewall contract during a controlled attempt;
- `assert_academic_action_allowed()` provides a deny-by-default enforcement point future permissioned academic-agent tools must call before acting;
- administrative voiding exists as an audited override for ACTIVE attempts;
- assessment audit payloads deliberately exclude full prompts, answer keys, marking guidance and learner response bodies.

During graded homework, the intended future policy remains different: explain, hint and critique_attempt can be permitted while give_final_answer and generate_submission are denied. Coursework assignments therefore remain separate from controlled assessments.

Assessment grading/results still require separate authoritative services and publication policy. Checkpoint 11 does not add automatic marking, grades, pass/fail decisions, official external-exam content or an AI Examiner/Tutor. Future academic actors must use permissioned services and the technical activity firewall rather than direct database access.

Do not advertise protected exam delivery as production-ready until hosted Supabase/JWT/RLS tests, concurrent-session testing, browser/accessibility review and the remaining grading/result controls have passed.

## Phase 3 checkpoint 1D-A: academic content release ordering

Migration `202609090021_phase3_academic_content_release.sql` adds a serialized database content-release authorization boundary for the seven Professor academic reads. Identity and informational permission introspection require no release. Fixed EXPLAIN enforcement and exact STUDENT self/enrolment/version scope remain in place.

Release begin, release close and controlled assessment start all lock the same authenticated learner's `student_profiles` row FOR UPDATE. Begin finalizes stale releases, checks controlled activity, then commits a fixed 30-second ACTIVE release or a terminal BLOCKED denial. Assessment start finalizes stale releases under that same lock and refuses to start while any valid ACTIVE release remains. The rest of the migration 020 start workflow is preserved, including stale attempt finalization, STUDENT/ACTIVE enrolment, assessment status/windows, same-active-attempt idempotency, one-active-attempt rule, void accounting, monotonic attempt numbering, limits, expiry and audit.

The gateway keeps the lease active through content services, strict output/context validation, fresh principal validation and final EXPLAIN enforcement. It requires a fresh ACTIVE → COMPLETED close before returning content. Errors abort; expired/replayed completion or close/audit failure returns SERVICE_UNAVAILABLE without content. Database loss may leave a bounded lease until expiry. Expired records are deterministically marked EXPIRED at their expiry time on a later committing lifecycle operation, and never qualify to block assessment start indefinitely.

This orders authorization: an assessment cannot start during a valid release, and a release cannot start during an active controlled assessment. The database checks live-clock attempt validity after acquiring the lock as well as the existing EXPLAIN policy, conservatively handling transaction timestamps that precede a lock wait. Successful completion authorizes release before assessment start can acquire the lock; it does not retract network bytes or promise their physical arrival precedes assessment start. Later provider generation/delivery will require a separate reviewed boundary.

Durable `audit_events` record only database-owned release authorization lifecycle metadata. A structured BLOCKED denial commits its audit; raising an exception after an audit insert would roll it back. Audit state and release state commit atomically and contain no resource bodies, objective/evidence prose, protected prompts/answers/guidance, support prose or learner response bodies. Terminal release rows are immutable and deletion/direct authenticated table mutation is forbidden.

Both release RPCs remain directly callable by authenticated users. They are not gateway-only; a lifecycle event proves an authenticated owner's authorization request/closure, never trusted gateway or AI execution. No provider/model exists. Trusted provider execution audit, rate/cost/retention controls and failure/abstention/escalation policy remain Checkpoint 1D-B; provider integration remains blocked.

Local PGlite tests exercise real row-lock SQL and sequential exclusion, lifecycle, RLS and audit semantics. True concurrent hosted PostgreSQL acceptance using two independent transactions has **not** been performed and remains a production prerequisite. See `14-academic-capabilities.md` for RPC semantics and failure behavior.
