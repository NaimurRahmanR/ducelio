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
