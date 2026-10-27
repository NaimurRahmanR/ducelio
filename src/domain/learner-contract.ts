// Shared learner-experience projections (docs/61). Owned by the integration
// lead. Lane B's server functions return these shapes from authorised data;
// Lane A's components render them; Lane C's services fill the service fields.
// Nothing here is a fixture: every value comes from an authenticated read.

export type ActivityKind = "LESSON" | "LAB" | "REVISION" | "ASSESSMENT";

// Derived on the server from the window, attendance and attempts. Attendance
// is not completion and completion is not mastery.
export type ActivityState =
  | "UPCOMING" // before its window opens
  | "OPEN" // inside its availability window
  | "ATTENDED" // LESSON: checked in (not completion, not mastery)
  | "SUBMITTED" // ASSESSMENT/LAB: work submitted, results not released
  | "RELEASED" // ASSESSMENT: deadline passed and graded; results visible
  | "MISSED" // window closed with no attendance or submission
  | "CLOSED"; // window closed (other kinds)

export type LearnerCourse = {
  enrolmentId: string;
  courseId: string;
  title: string;
  provider: string; // the course organisation's name
  status: "ACTIVE" | "COMPLETED"; // COMPLETED only after release processing
  scheduled: boolean; // a timetable has been confirmed
  accessRevoked: boolean;
};

export type LearnerActivity = {
  itemId: string;
  enrolmentId: string;
  courseTitle: string;
  provider: string;
  kind: ActivityKind;
  ref: string;
  title: string;
  part: number;
  parts: number;
  startsAt: string; // occupied interval start (ISO)
  endsAt: string; // occupied interval end (ISO)
  opensAt: string | null; // availability window
  closesAt: string | null;
  state: ActivityState;
};

export type LearnerWeek = {
  weekStart: string; // ISO date of Monday in the learner's timezone
  timezone: string;
  serverTime: string;
  activities: LearnerActivity[]; // every activity in the week, no truncation
};

export type ClassEvidence = {
  checkedInAt: string | null; // attendance
  correctInClassAnswers: number; // display only, never mastery
  lessonObjectives: { ref: string; title: string; covered: boolean }[];
  topicsCovered: string[];
};

export type ReleasedResult = {
  enrolmentId: string;
  courseTitle: string;
  assessmentRef: string;
  assessmentTitle: string;
  kind: string; // QUIZ / MIDTERM / FINAL …
  releasedAt: string;
  bestScore: number;
  maxScore: number;
  attemptsUsed: number;
  passed: boolean | null; // null when the component has no pass mark
};

export type AssessmentCentre = {
  itemId: string;
  ref: string;
  title: string; // used for "Take {title}"
  opensAt: string;
  closesAt: string;
  durationMinutes: number;
  attemptsUsed: number;
  attemptsAllowed: number; // never more than 2
  activeAttemptId: string | null; // resume target
  state: ActivityState;
  canStart: boolean;
  reason: string | null; // why it cannot start, when it cannot
} | null;

export type PracticalLab = {
  itemId: string;
  ref: string;
  title: string;
  opensAt: string;
  closesAt: string | null; // null when the practical has no closing time
  state: ActivityState;
  canAttend: boolean;
  submitted: boolean;
  graded: boolean;
} | null;

export type CourseProgression = {
  enrolmentId: string;
  classes: { total: number; attended: number; missed: number };
  objectives: { total: number; demonstrated: number }; // released evidence only
  practicals: { total: number; submitted: number; graded: number };
  assessments: { total: number; released: number };
  completion: { completed: boolean; completedAt: string | null };
};

export type CourseWorkspace = {
  course: LearnerCourse;
  currentClass:
    | (LearnerActivity & {
        evidence: ClassEvidence;
        classroomId: string | null;
      })
    | null;
  tutorAvailable: boolean; // false during an active examination
  assessment: AssessmentCentre;
  lab: PracticalLab;
  results: ReleasedResult[];
  progression: CourseProgression;
};

export type LeaderboardEntry = {
  rank: number;
  label: string; // pseudonymous; "You" for the caller
  bestScore: number;
  maxScore: number;
  isMe: boolean;
};

export type AssessmentLeaderboard = {
  courseTitle: string;
  assessmentRef: string;
  assessmentTitle: string;
  month: string; // YYYY-MM (UTC month of the first attempt)
  entries: LeaderboardEntry[]; // top 10 at most
};
