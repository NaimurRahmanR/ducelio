// CP2 hosted exam-engine acceptance: the pure, side-effect-free plan.
//
// SYNTHETIC, labelled demo content only. Nothing here is real course,
// certification or official exam content, and no official question bank is
// reproduced. The run course is never offered for sale, so it never appears
// on the public catalogue.
//
// This module owns: the synthetic question sets (all six question types),
// the package built from them (validated and activated by the real hosted
// RPCs, never written directly), the canonical learner answers and the marks
// the database scorer must award for them, the protected markers that must
// never reach a learner, the provider or an audit payload, and the exact
// hosted-write plan. It never touches the network or a database.
import { buildAcceptancePackage } from "./fixtures.mjs";

export const SYNTHETIC_LABEL =
  "Synthetic demo question (not real exam content).";

// Distinctive text that exists only in protected fields (expected answers /
// rationales and answer keys). Its appearance in any learner-visible
// response, provider request or audit payload is a protection failure.
export const RATIONALE_SENTINEL = "CP2E-PROTECTED-RATIONALE";
export const PROTECTED_KEY_FIELDS = Object.freeze([
  "answerKey",
  "answer_key",
  "correctOptionId",
  "correctOptionIds",
  "correctOrder",
  '"mapping"',
  "expectedAnswer",
  "expected_answer",
  "markingGuidance",
  "marking_guidance",
]);

const options = (n) =>
  Array.from({ length: n }, (_, i) => ({
    id: `o${i + 1}`,
    label: `Synthetic option ${i + 1}`,
  }));
const base = (position, maxMarks) => ({
  position,
  prompt: `${SYNTHETIC_LABEL} Question ${position}.`,
  maxMarks,
  expectedAnswer: `${RATIONALE_SENTINEL} ${position}`,
  markingGuidance: null,
  objectiveRefs: ["obj-1"],
});

// One question of each type. `answers.best` scores maxMarks; `answers.partial`
// is a valid, deliberately imperfect answer with the documented mark.
export function examEngineQuestions() {
  return [
    {
      ...base(1, 2),
      questionType: "SINGLE_SELECT",
      interaction: { options: options(3) },
      answerKey: { correctOptionId: "o2" },
      answers: {
        best: { optionId: "o2" },
        partial: { optionId: "o1" },
        partialMarks: 0,
      },
    },
    {
      ...base(2, 4),
      questionType: "MULTIPLE_SELECT",
      interaction: {
        options: options(4),
        requiredSelections: 2,
        scoringRule: "NET_PROPORTIONAL",
      },
      answerKey: { correctOptionIds: ["o1", "o3"] },
      answers: {
        best: { optionIds: ["o1", "o3"] },
        // One right, one wrong: net zero under NET_PROPORTIONAL.
        partial: { optionIds: ["o1", "o2"] },
        partialMarks: 0,
      },
    },
    {
      ...base(3, 6),
      questionType: "PBQ_MATCHING",
      interaction: {
        items: [1, 2, 3].map((n) => ({
          id: `i${n}`,
          label: `Synthetic item ${n}`,
        })),
        targets: [1, 2, 3].map((n) => ({
          id: `t${n}`,
          label: `Synthetic target ${n}`,
        })),
        allowTargetReuse: false,
        scoringRule: "PER_ITEM_PROPORTIONAL",
      },
      answerKey: { mapping: { i1: "t1", i2: "t2", i3: "t3" } },
      answers: {
        best: { matches: { i1: "t1", i2: "t2", i3: "t3" } },
        // One of three items right: floor(6 * 1/3) = 2.
        partial: { matches: { i1: "t1", i2: "t3", i3: "t2" } },
        partialMarks: 2,
      },
    },
    {
      ...base(4, 4),
      questionType: "PBQ_ORDERING",
      interaction: {
        steps: [3, 1, 4, 2].map((n) => ({
          id: `s${n}`,
          label: `Synthetic step ${n}`,
        })),
        scoringRule: "ALL_OR_NOTHING",
      },
      answerKey: { correctOrder: ["s1", "s2", "s3", "s4"] },
      answers: {
        best: { order: ["s1", "s2", "s3", "s4"] },
        partial: { order: ["s2", "s1", "s3", "s4"] },
        partialMarks: 0,
      },
    },
    {
      ...base(5, 3),
      questionType: "PBQ_CONFIGURATION",
      interaction: {
        scenario:
          "Synthetic scenario: a demo host must refuse remote shell access. No command is executed; choose settings only.",
        fields: [
          {
            id: "action",
            label: "Rule action",
            options: [
              { id: "allow", label: "Allow" },
              { id: "deny", label: "Deny" },
            ],
          },
          {
            id: "protocol",
            label: "Protocol",
            options: [
              { id: "tcp", label: "TCP" },
              { id: "udp", label: "UDP" },
            ],
          },
          {
            id: "port",
            label: "Port",
            options: [
              { id: "p22", label: "22" },
              { id: "p80", label: "80" },
              { id: "p443", label: "443" },
            ],
          },
        ],
        scoringRule: "PER_FIELD_PROPORTIONAL",
      },
      answerKey: { values: { action: "deny", protocol: "tcp", port: "p22" } },
      answers: {
        best: { values: { action: "deny", protocol: "tcp", port: "p22" } },
        // Two of three fields right: floor(3 * 2/3) = 2.
        partial: { values: { action: "deny", protocol: "udp", port: "p22" } },
        partialMarks: 2,
      },
    },
    {
      ...base(6, 5),
      questionType: "FREE_TEXT",
      answers: {
        best: "Synthetic written answer for the demo control question.",
      },
    },
  ];
}

const sortKeys = (value) =>
  Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((k) => [k, value[k]]),
  );

// The exact canonical body text the CP2 application saves for an answer
// (mirrors canonicalResponseBody in src/domain/assessment-question-types.ts;
// the unit suite proves they agree for every planned answer).
export function canonicalBody(type, response) {
  switch (type) {
    case "SINGLE_SELECT":
      return JSON.stringify({ optionId: response.optionId });
    case "MULTIPLE_SELECT":
      return JSON.stringify({ optionIds: [...response.optionIds].sort() });
    case "PBQ_MATCHING":
      return JSON.stringify({ matches: sortKeys(response.matches) });
    case "PBQ_ORDERING":
      return JSON.stringify({ order: response.order });
    case "PBQ_CONFIGURATION":
      return JSON.stringify({ values: sortKeys(response.values) });
    case "FREE_TEXT":
      return String(response);
  }
  throw new Error(`Unknown question type ${type}`);
}

// Package-shaped question (no test-only answers); FREE_TEXT carries no
// extension keys at all, exactly like every legacy question.
export function packageQuestion(question, position = question.position) {
  const { answers: _answers, ...rest } = question;
  void _answers;
  if (rest.questionType !== "FREE_TEXT") return { ...rest, position };
  const {
    questionType: _type,
    interaction: _interaction,
    answerKey: _key,
    ...legacy
  } = rest;
  void _type;
  void _interaction;
  void _key;
  return { ...legacy, position };
}

const byType = (type) =>
  examEngineQuestions().find((q) => q.questionType === type);
export const OBJECTIVE_TYPES = Object.freeze([
  "SINGLE_SELECT",
  "MULTIPLE_SELECT",
  "PBQ_MATCHING",
  "PBQ_ORDERING",
  "PBQ_CONFIGURATION",
]);

// Which synthetic questions each run component carries.
//   QUIZ_1   all six types (the browser journey: persistence, resume, submit,
//            mixed deterministic + Examiner grading)
//   QUIZ_2   the five objective types (deterministic only, no provider call)
//   MIDTERM  unchanged legacy free text (pre-CP2 compatibility)
//   QUIZ_3   one choice + one written question, 1-minute duration (expiry)
//   QUIZ_4, FINAL  unchanged legacy free text, never attempted
// The review course's QUIZ_1 is one choice + one written question, with the
// Examiner escalating every claim to human academic review.
export const COMPONENT_PLAN = Object.freeze({
  main: {
    QUIZ_1: [
      "SINGLE_SELECT",
      "MULTIPLE_SELECT",
      "PBQ_MATCHING",
      "PBQ_ORDERING",
      "PBQ_CONFIGURATION",
      "FREE_TEXT",
    ],
    QUIZ_2: [...OBJECTIVE_TYPES],
    QUIZ_3: ["SINGLE_SELECT", "FREE_TEXT"],
  },
  review: { QUIZ_1: ["SINGLE_SELECT", "FREE_TEXT"] },
});
export const TIMED_COMPONENT = "QUIZ_3";
export const TIMED_DURATION_MINUTES = 1;

export function questionsFor(course, component) {
  const types = COMPONENT_PLAN[course][component];
  return types
    ? types.map((type, index) => ({ ...byType(type), position: index + 1 }))
    : null;
}

// The package for one run course, built on the shared acceptance package so
// every non-assessment part is identical to the reviewed harness.
export function buildExamEnginePackage(runId, course = "main") {
  if (!(course in COMPONENT_PLAN)) throw new Error(`Unknown course ${course}`);
  const pkg = buildAcceptancePackage(runId, {
    examinerEnabled: true,
    assessmentDurationMinutes: 15,
  });
  return applyExamEnginePlan(pkg, course);
}

// The same transformation, applied to a package another seeding helper
// built (scripts/acceptance/fixtures.mjs seedAcceptanceCourse transform).
export function applyExamEnginePlan(pkg, course = "main") {
  const out = structuredClone(pkg);
  for (const template of out.assessmentTemplates) {
    const component = template.key.toUpperCase();
    const planned = questionsFor(course, component);
    if (planned) template.questions = planned.map((q) => packageQuestion(q));
    // The main acceptance course uses six-minute assessment windows.
    // Every assessment must fit its window; QUIZ_3 remains one minute.
    if (course === "main")
      template.durationMinutes =
        component === TIMED_COMPONENT ? TIMED_DURATION_MINUTES : 5;
  }
  if (course === "review")
    out.agentConfiguration.EXAMINER = {
      ...out.agentConfiguration.EXAMINER,
      escalationPolicy: "ACADEMIC_REVIEW",
    };
  out.programme.title = `${out.programme.title} (CP2 synthetic demo)`;
  return out;
}

// Marks the database scorer must award for a set of saved answers.
export function expectedObjectiveMarks(questions, choice) {
  return Object.fromEntries(
    questions
      .filter((q) => q.questionType !== "FREE_TEXT")
      .map((q) => [
        q.position,
        choice === "best" ? q.maxMarks : q.answers.partialMarks,
      ]),
  );
}

// The Examiner grading provider is an authorised recipient of the *legacy*
// free-text rubric (`expectedAnswer`, `markingGuidance`). These are restricted
// from learner-visible surfaces, but they must remain in the pre-CP2 grading
// request. Do not apply the blanket learner-visible marker scan to raw
// provider JSON: that would falsely flag every valid free-text request.
//
// The scanner fails closed unless the governed request has exactly the
// legacy context and exact free-text question shapes. It masks the two
// permitted rubric values solely at that structural location; objective
// answer-key fields and objective-score fields remain forbidden everywhere,
// and the sentinel remains forbidden in every other field. Nothing is logged.
const LEGACY_GRADING_CONTEXT_FIELDS = Object.freeze([
  "assessmentId",
  "attemptId",
  "component",
  "instructions",
  "questions",
  "title",
]);
const LEGACY_FREE_TEXT_QUESTION_FIELDS = Object.freeze([
  "expectedAnswer",
  "markingGuidance",
  "maxMarks",
  "position",
  "prompt",
  "questionId",
  "responseBody",
]);
const exactKeys = (value, allowed) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify(allowed);

export function protectedProviderRequestHits(raw) {
  let request;
  let input;
  try {
    request = JSON.parse(String(raw));
    input = JSON.parse(request?.input);
  } catch {
    return ["INVALID_PROVIDER_REQUEST_FORMAT"];
  }
  if (
    !request ||
    typeof request !== "object" ||
    Array.isArray(request) ||
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    !["grade_controlled_assessment", "regrade_controlled_assessment"].includes(
      input.capability,
    ) ||
    !exactKeys(input, ["capability", "context"]) ||
    !exactKeys(input.context, LEGACY_GRADING_CONTEXT_FIELDS) ||
    !Array.isArray(input.context.questions)
  )
    return ["UNEXPECTED_PROVIDER_CONTEXT_SHAPE"];

  for (const question of input.context.questions) {
    if (!exactKeys(question, LEGACY_FREE_TEXT_QUESTION_FIELDS))
      return ["UNEXPECTED_PROVIDER_QUESTION_SHAPE"];
    if (
      typeof question.questionId !== "string" ||
      !Number.isInteger(question.position) ||
      typeof question.prompt !== "string" ||
      !Number.isInteger(question.maxMarks) ||
      question.maxMarks < 0 ||
      typeof question.expectedAnswer !== "string" ||
      !(
        question.markingGuidance === null ||
        typeof question.markingGuidance === "string"
      ) ||
      typeof question.responseBody !== "string"
    )
      return ["INVALID_PROVIDER_QUESTION_TYPES"];
  }

  const safeToScan = {
    ...request,
    input: {
      ...input,
      context: {
        ...input.context,
        questions: input.context.questions.map((question) => {
          const otherFields = { ...question };
          delete otherFields.expectedAnswer;
          delete otherFields.markingGuidance;
          return otherFields;
        }),
      },
    },
  };
  // Exclude *only* legacy free-text rubric locations, not arbitrary copies
  // of these keys or values, and not any objective answer-key structure.
  return protectedMarkerHits(JSON.stringify(safeToScan));
}

// Strings forbidden in learner-facing surfaces and audit rows. For provider
// requests, use the structurally scoped scanner above to permit only legacy
// free-text rubric fields while rejecting objective-key disclosures.
export function protectedMarkers() {
  return [RATIONALE_SENTINEL, ...PROTECTED_KEY_FIELDS];
}
export function protectedMarkerHits(text) {
  const haystack = String(text);
  return protectedMarkers().filter((marker) => haystack.includes(marker));
}

// The exact hosted-write plan for one run. `exact` rows are created by the
// seeding and authoring steps whatever happens; `run` rows depend on the
// learner journey and are listed with the precise count when every stage
// passes. Every row is permanent institutional history (append-only by
// design); nothing is deleted afterwards (see containment()).
export function plannedHostedWrites() {
  const objectiveCount = (course) =>
    Object.values(COMPONENT_PLAN[course])
      .flat()
      .filter((t) => t !== "FREE_TEXT").length;
  const questionCount = (course) =>
    Object.entries(COMPONENT_PLAN[course]).reduce(
      (n, [, t]) => n + t.length,
      0,
    ) +
    // components without a plan keep their one legacy question
    (6 - Object.keys(COMPONENT_PLAN[course]).length);
  const perCourse = (course) => ({
    course_package_imports: 1,
    programme_versions: 1,
    modules: 1,
    lessons: 1,
    lesson_objectives: 1,
    cohorts: 1,
    course_activations: 1,
    assessments: 6,
    assessment_questions: questionCount(course),
    assessment_question_interactions: objectiveCount(course),
    assessment_question_objective_keys: objectiveCount(course),
    enrolments: 1,
    assessment_component_bindings: 6,
    grading_policies: 1,
    lab_policies: 1,
    result_policies: 1,
    agent_configurations: 5,
    course_package_test_runs: 1,
    course_practicals: 1,
    learning_resources: 1,
  });
  const authoring = {
    assessments: 1, // DRAFT, never published, never learner-visible
    assessment_questions: OBJECTIVE_TYPES.length + 1,
    assessment_question_interactions: OBJECTIVE_TYPES.length,
    assessment_question_objective_keys: OBJECTIVE_TYPES.length,
  };
  return {
    exact: { main: perCourse("main"), review: perCourse("review"), authoring },
    run: {
      // learner attempts: main QUIZ_1, QUIZ_2, MIDTERM, QUIZ_3 + review QUIZ_1
      assessment_attempts: 5,
      // QUIZ_1: 6 first saves + 1 changed answer; QUIZ_2: 5; MIDTERM: 1;
      // QUIZ_3: 1 before expiry (the late save is refused); review QUIZ_1: 2.
      assessment_responses: 7 + 5 + 1 + 1 + 2,
      examiner_executions: 5,
      // QUIZ_1 (mixed), QUIZ_2 (deterministic), MIDTERM, QUIZ_3 (timed) and
      // the review case's human grade.
      result_revisions: 5,
      academic_review_cases: 1,
      // Auth: sign-ins only for the 4 existing acceptance identities (no
      // account is created): sessions, refresh tokens and Auth audit rows.
      auth_users_created: 0,
      // audit_events: one content-minimised row per governed write above;
      // counted from the database after the run, never estimated.
    },
    never: [
      "commercial_v1_offers",
      "campaigns / orders / payments / Stripe objects",
      "public catalogue entries",
      "new Auth users",
      "controller keys or any secret",
    ],
  };
}

// Containment, not deletion: attempts, responses, executions, results,
// audit rows and both CP2 tables are append-only by design (and by trigger).
// These governed, audited calls are themselves hosted writes requiring
// separate approval, run only after the evidence is captured.
export function containment() {
  return [
    "change_assessment_status(CLOSED) for the 12 published run assessments (6 per course)",
    "the DRAFT authoring assessment stays DRAFT (never learner-visible)",
    "change_enrolment_status(WITHDRAWN) for the 2 run enrolments",
    "no offer exists, so nothing is publicly listed",
    "record every created identifier in the evidence file outside the repository",
  ];
}
