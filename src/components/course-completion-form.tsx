"use client";
import { useActionState } from "react";
import { attemptCourseCompletionAction } from "@/app/student/progress/actions";

// Deterministic: every gate is evaluated server-side from persisted,
// immutable result/policy state. Safe to press repeatedly -- an
// already-completed enrolment returns its existing outcome rather than
// erroring or creating a duplicate receipt.
export function CourseCompletionForm({ enrolmentId }: { enrolmentId: string }) {
  const [state, formAction, pending] = useActionState(
    attemptCourseCompletionAction,
    {},
  );
  return (
    <form action={formAction}>
      <input type="hidden" name="enrolmentId" value={enrolmentId} />
      <button className="button" disabled={pending}>
        {pending ? "Checking…" : "Attempt course completion"}
      </button>
      <p role="status">{state.error ?? state.message ?? ""}</p>
    </form>
  );
}
