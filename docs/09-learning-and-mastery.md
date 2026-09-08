# Learning and mastery
Class time, lesson progress and objective mastery are separate measures.
- Elapsed class time: duration since session entry.
- Lesson progress: completed planned lesson segments.
- Today's mastery: fixed required lesson objectives demonstrated by validated evidence.
A lesson can be 90% complete with 40% mastery. Scrolling, videos, elapsed time and Next clicks do not establish evidence.
Future flow: evidence submission → source/activity validation → deterministic evaluation policy → mastery transition + history + audit in one transaction. Evidence must bind learner, enrolment/version, objective, activity and provenance. Replays need idempotency.
Objective states: NOT_STARTED, DEVELOPING, DEMONSTRATED, NEEDS_REINFORCEMENT. Published objectives are fixed. Version corrections must not silently rewrite enrolled history.
Phase 1 displays clearly labelled demonstration measures only. There is no authoritative mastery write API or automatic completion calculation yet.
