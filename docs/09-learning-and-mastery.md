# Learning and mastery

Class time, lesson progress and objective mastery are separate measures.

- Elapsed class time: duration since session entry.
- Lesson progress: completed planned lesson segments.
- Today's mastery: fixed required lesson objectives demonstrated by validated evidence.

A lesson can be 90% complete with 40% mastery. Scrolling, videos, elapsed time and Next clicks do not establish evidence.

The institutional flow is:

validated evidence submission → source/activity validation → deterministic evaluation policy → objective mastery current-state update + immutable transition history + audit in one transaction.

Evidence binds learner, enrolment/version, objective, class session/activity and provenance. Replays use idempotency keys. Published objectives remain fixed and version corrections must not silently rewrite enrolled history.

## Objective states

- `NOT_STARTED` — no validated evidence has yet been processed for the objective.
- `DEVELOPING` — validated evidence exists, but the demonstration threshold is not yet satisfied.
- `DEMONSTRATED` — the deterministic evidence-diversity threshold is satisfied by the latest evaluation.
- `NEEDS_REINFORCEMENT` — an objective previously demonstrated has received later partial or incorrect validated evidence.

## MASTERY_V1

Checkpoint 9 introduces the first explicit deterministic policy. It is deliberately conservative and versioned so later academic-policy changes can be audited rather than silently changing history.

1. The first validated evidence moves the objective from `NOT_STARTED` to `DEVELOPING`.
2. `DEMONSTRATED` requires the triggering evidence to be `CORRECT`, with correct evidence for the same learner/enrolment/objective from at least **two distinct class sessions** and at least **two distinct evidence kinds**.
3. After `DEMONSTRATED`, later `PARTIAL` or `INCORRECT` evidence moves the objective to `NEEDS_REINFORCEMENT`.
4. A later `CORRECT` observation restores `DEMONSTRATED` when the required session/kind diversity remains satisfied.
5. Evidence counts, diversity counts, policy version, triggering evidence and evaluator are stored with the current mastery record and transition history.
6. Mastery history is append-only. Current mastery identity cannot be reassigned to another learner, enrolment, objective, lesson or curriculum version.
7. Lesson progress, attendance, page views, elapsed time and resource consumption are not inputs to the mastery policy.

This is not a claim that two observations are universally sufficient for educational mastery. It is the first explicit Ducelio policy contract for the deterministic Academy OS and is intended to be reviewed and versioned as assessment design matures.
