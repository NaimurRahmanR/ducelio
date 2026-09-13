"use client";
import { useState } from "react";
import { requestPracticalSupportAction } from "@/app/student/practicals/actions";
export function PracticalSupport({
  enrolmentId,
  practicalId,
  requestId,
  lab,
}: {
  enrolmentId: string;
  practicalId: string;
  requestId: string;
  lab: boolean;
}) {
  const [state, setState] = useState<"IDLE" | "PENDING" | "DONE" | "ERROR">(
    "IDLE",
  );
  return (
    <div>
      <button
        className="button secondary"
        disabled={state === "PENDING" || state === "DONE"}
        onClick={async () => {
          setState("PENDING");
          try {
            const result = await requestPracticalSupportAction({
              enrolmentId,
              practicalId,
              requestId,
            });
            setState(result.ok ? "DONE" : "ERROR");
          } catch {
            setState("ERROR");
          }
        }}
      >
        {state === "PENDING"
          ? "Recording request…"
          : "Request " + (lab ? "Lab" : "Tutor") + " support"}
      </button>
      <p role="status">
        {state === "DONE"
          ? "Support request recorded. This has not started an AI session."
          : state === "ERROR"
            ? "Support is unavailable. Your course or assessment state may restrict this request."
            : ""}
      </p>
    </div>
  );
}
