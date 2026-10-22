// Builds the Ducelio Academy (B2C) conversion of the committed Security+
// SY0-701 revision 6 COURSE_PACKAGE_V1 package.
//
//   node scripts/academy/build-security-plus-academy.mjs [--check]
//
// The academic content (modules, lessons, objectives, resources, practical
// activities, assignments, assessments, questions, answer keys and agent
// configuration) is copied from revision 6 unchanged. Only the embedded
// package identity (key, revision, reason, curriculum label) is set to the
// separate Academy identity, so materialising it never touches the hosted
// security-plus-sy0-701 programme, its activation, offer or history.
//
// Every value added below is a DUCELIO DELIVERY PROPOSAL, not CompTIA
// content and not owner-approved academic policy. See PROPOSAL_NOTE.
// --check exits 1 if the committed artefact differs from this build.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { format } from "prettier";

const dir = resolve("content/courses/security-plus-sy0-701");
const sourceFile = resolve(dir, "ducelio-upload-rev6-six-assessments.json");
const outFile = resolve(dir, "academy-b2c-rev1.json");
const rev6 = JSON.parse(readFileSync(sourceFile, "utf8"));
const sources = JSON.parse(readFileSync(resolve(dir, "sources.json"), "utf8"));

const KEY = "security-plus-sy0-701-academy";
const REVISION = 1;
const PROPOSAL_NOTE =
  "Academy B2C conversion of SEC701 revision 6. Content unchanged. Workload, placement, pass mark and formats are Ducelio proposals pending owner academic approval.";

const lessons = rev6.modules
  .toSorted((a, b) => a.position - b.position)
  .flatMap((m) => m.lessons.toSorted((a, b) => a.position - b.position));
const lessonKeys = lessons.map((l) => l.key);
const upTo = (key) => lessonKeys.slice(0, lessonKeys.indexOf(key) + 1);
const coverage = (template) => [
  ...new Set([
    template.lessonRef,
    ...template.questions.map((q) => q.lessonRef ?? template.lessonRef),
  ]),
];

const lastCovered = (template) =>
  lessonKeys[Math.max(...coverage(template).map((k) => lessonKeys.indexOf(k)))];

// Component identities and weights are the existing code-owned Commercial V1
// NO_LABS distribution (src/domain/commercial-v1-assessment-policy.ts). Labs
// stay ungraded because revision 6 contains no lab rubric or marking
// guidance, and none is invented here.
const COMPONENTS = {
  "quiz-1": ["QUIZ_1", "QUIZ", 500],
  "quiz-2": ["QUIZ_2", "QUIZ", 500],
  midterm: ["MIDTERM", "MIDTERM", 2000],
  "quiz-3": ["QUIZ_3", "QUIZ", 500],
  "quiz-4": ["QUIZ_4", "QUIZ", 500],
  final: ["FINAL", "FINAL", 6000],
};
const PREPARATION = {
  QUIZ: { revisionMinutes: 30, minimumDaysAfterTeaching: 0, window: 48 },
  MIDTERM: { revisionMinutes: 90, minimumDaysAfterTeaching: 1, window: 72 },
  FINAL: { revisionMinutes: 120, minimumDaysAfterTeaching: 1, window: 72 },
};

const curriculum = {
  ...rev6,
  packageKey: KEY,
  packageRevision: REVISION,
  curriculumVersion: {
    label: `${rev6.curriculumVersion.label} / Academy B2C rev ${REVISION}`,
  },
  reason: PROPOSAL_NOTE,
};

const academy = {
  schemaVersion: "ACADEMY_COURSE_PACKAGE_V1",
  packageKey: KEY,
  packageRevision: REVISION,
  course: {
    description:
      "Self-paced Ducelio Academy preparation for the CompTIA Security+ SY0-701 examination: five modules, 28 lessons, practical activities and six assessments, delivered on the learner's own timetable.",
    qualificationPreparation: {
      examinationBody: rev6.programme.examinationBody,
      qualificationName: "CompTIA Security+ (SY0-701)",
      disclaimer:
        "Ducelio prepares learners for the CompTIA Security+ SY0-701 examination. Ducelio does not award CompTIA certifications and is not endorsed by CompTIA. Course assessments are original Ducelio practice material.",
    },
    sourceReferences: sources.sources.map((s) => ({
      key: s.sourceId,
      title: s.title,
      publisher: s.publisher,
      version: s.documentVersion ?? null,
      url: s.url ?? null,
      note: s.notes ? s.notes.slice(0, 1000) : null,
    })),
    academicPolicies: [
      {
        key: "assessment-integrity",
        title: "Assessment integrity",
        statement:
          "Assessments are sat individually within the scheduled sitting window and the fixed duration. Questions, answers and marking information are never shared.",
      },
    ],
    demoContent: false,
  },
  curriculum,
  workload: {
    lessons: lessons.map((l) => ({
      lessonRef: l.key,
      teachingMinutes: 90,
      prerequisiteLessonRefs: [],
    })),
  },
  labs: lessons.flatMap((l) =>
    l.practicalActivities
      .toSorted((a, b) => a.position - b.position)
      .map((a) => ({
        activityRef: a.key,
        durationMinutes: a.kind === "PRACTICAL_LAB" ? 60 : 30,
        graded: false,
        rubric: [],
        markingGuidance: null,
      })),
  ),
  assessments: rev6.assessmentTemplates.map((t) => {
    const [componentKey, kind] = COMPONENTS[t.key];
    const prep = PREPARATION[kind];
    return {
      templateRef: t.key,
      componentKey,
      kind,
      // Placed after the last lesson its questions actually assess (rev6
      // anchors quiz-4 at lesson-4-8 but assesses lessons up to 5-6).
      afterLessonRef: lastCovered(t),
      requiredLessonRefs: upTo(lastCovered(t)).filter((k) =>
        coverage(t).includes(k),
      ),
      preparation: {
        revisionMinutes: prep.revisionMinutes,
        minimumDaysAfterTeaching: prep.minimumDaysAfterTeaching,
      },
      sittingWindowHours: prep.window,
      passMarkBp: null,
      attemptScoring: "HIGHEST",
    };
  }),
  grading: {
    components: rev6.assessmentTemplates.map((t) => ({
      componentKey: COMPONENTS[t.key][0],
      source: "ASSESSMENT",
      weightBp: COMPONENTS[t.key][2],
    })),
  },
  completion: { coursePassMarkBp: 7000, requireEveryComponentPassMark: false },
  deliveryFormats: [
    {
      formatId: "ACCELERATED_2W",
      sessionMinutes: 360,
      minStudyDaysPerWeek: 6,
      maxStudyDaysPerWeek: 7,
    },
    {
      formatId: "INTENSIVE_4W",
      sessionMinutes: 240,
      minStudyDaysPerWeek: 5,
      maxStudyDaysPerWeek: 7,
    },
    {
      formatId: "STANDARD_6W",
      sessionMinutes: 180,
      minStudyDaysPerWeek: 4,
      maxStudyDaysPerWeek: 6,
    },
    {
      formatId: "EXTENDED_8W",
      sessionMinutes: 150,
      minStudyDaysPerWeek: 4,
      maxStudyDaysPerWeek: 6,
    },
    {
      formatId: "FLEXIBLE_12W",
      sessionMinutes: 120,
      minStudyDaysPerWeek: 3,
      maxStudyDaysPerWeek: 5,
    },
  ],
  reason: PROPOSAL_NOTE,
};

const output = await format(JSON.stringify(academy), { parser: "json" });
if (process.argv.includes("--check")) {
  if (readFileSync(outFile, "utf8") !== output) {
    console.error("academy-b2c-rev1.json is out of date; rebuild it.");
    process.exit(1);
  }
} else {
  writeFileSync(outFile, output);
  console.log(`Wrote ${outFile}`);
}
