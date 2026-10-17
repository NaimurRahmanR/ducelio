import { randomBytes, randomUUID } from "node:crypto";
import {
  buildAssessmentPolicyFixture,
  asPolicyUser,
  learner,
  administrator,
  learnerAuth,
  type AssessmentPolicyFixture,
} from "./commercial-v1-assessment-policy-fixture";
export { asPolicyUser, learner, administrator };

async function value<T = string>(
  f: AssessmentPolicyFixture,
  sql: string,
  args: unknown[] = [],
): Promise<T> {
  return (await f.db.query<{ v: T }>(sql, args)).rows[0].v;
}
export async function owner(f: AssessmentPolicyFixture) {
  await f.db.exec("reset role");
}

// A real activated Commercial V1 course, WITH a published lab policy, a
// published result policy and EXAMINER enabled with both grading
// capabilities -- but deliberately NOT pre-consuming any attempt/submission,
// so each test starts a genuinely fresh submission through the real
// governed RPCs. QUIZ_1's default window is already open ("now"); the other
// five components deliberately are not (they sequence open over real
// wall-clock hours, same constraint documented in
// commercial-v1-examiner-recovery-fixture.ts), so tests use QUIZ_1 unless a
// scenario explicitly needs otherwise.
export async function submissionGradingFixture(
  opts: Pick<
    Parameters<typeof buildAssessmentPolicyFixture>[0],
    "migration059" | "quiz1QuestionsAfterValidation"
  > & { escalateToAcademicReview?: boolean } = {},
) {
  const f = await buildAssessmentPolicyFixture({
    withLabs: true,
    migration059: opts.migration059,
    quiz1QuestionsAfterValidation: opts.quiz1QuestionsAfterValidation,
    examinerAgentConfig: {
      capabilities: ["grade_controlled_assessment", "grade_practical_lab"],
      escalationPolicy: opts.escalateToAcademicReview
        ? "ACADEMIC_REVIEW"
        : "NONE",
    },
  });
  await owner(f);
  const practical = await value<string>(
    f,
    "select id as v from course_practicals where import_id=$1 and kind='PRACTICAL_LAB'",
    [f.importId],
  );
  await asPolicyUser(f.db, 2);
  await f.db.query(
    "select set_commercial_v1_lab_policy($1,$2,10,2000,'Protected grading guidance sentinel','Submission grading fixture lab policy')",
    [f.activationId, practical],
  );
  await f.db.query(
    "select publish_commercial_v1_result_policy($1,1,false,'Submission grading fixture result policy')",
    [f.activationId],
  );
  const keyId = randomUUID(),
    key = randomBytes(32);
  await owner(f);
  await f.db.query(
    "select academic_execution_private.install_controller_key($1,$2::bytea)",
    [keyId, key],
  );
  return { ...f, practical, keyId, key };
}
export type SubmissionGradingFixture = Awaited<
  ReturnType<typeof submissionGradingFixture>
>;

export async function questionIdOf(
  f: SubmissionGradingFixture,
  assessmentId: string,
) {
  await owner(f);
  return value<string>(
    f,
    "select id as v from assessment_questions where assessment_id=$1 order by position limit 1",
    [assessmentId],
  );
}

export { learnerAuth };
