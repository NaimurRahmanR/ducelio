"use client";
import { ExamWorkspace, type ExamQuestion } from "./exam-workspace";
import {
  finishAcademyAttemptAction,
  saveAcademyResponseAction,
} from "@/app/student/academy/actions";

// The Academy sitting uses the same exam interface as institutional
// controlled assessments; only the save/finish authorities differ.
const actions = {
  save: saveAcademyResponseAction,
  finish: finishAcademyAttemptAction,
};

export function AcademyExam(props: {
  title: string;
  instructions: string;
  attempt: { id: string; attempt_number: number; expires_at: string };
  questions: ExamQuestion[];
  serverNow: string;
}) {
  return <ExamWorkspace {...props} actions={actions} />;
}
