"use client";
import { useState } from "react";
import type { ActivationOptions } from "@/domain/course-activation";
import { activateCourseAction } from "@/app/admin/activation/actions";
import Link from "next/link";
export function CourseActivationForm({
  options,
  importId,
}: {
  options: ActivationOptions;
  importId: string;
}) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [activated, setActivated] = useState(false);
  return (
    <form
      className="form-grid"
      onSubmit={async (e) => {
        e.preventDefault();
        setPending(true);
        setMessage("");
        setActivated(false);
        const f = new FormData(e.currentTarget);
        const timestamp = (name: string) => {
          const v = String(f.get(name) ?? "");
          return v.length === 16 ? v + ":00Z" : v + "Z";
        };
        try {
          const result = await activateCourseAction({
            importId,
            cohortId: f.get("cohort"),
            instructorId: f.get("instructor"),
            reason: f.get("reason"),
            assignments: options.assignments.map((t) => ({
              templateKey: t.templateKey,
              opensAt: timestamp("a-open-" + t.templateKey),
              dueAt: timestamp("a-end-" + t.templateKey),
            })),
            assessments: options.assessments.map((t) => ({
              templateKey: t.templateKey,
              opensAt: timestamp("e-open-" + t.templateKey),
              closesAt: timestamp("e-end-" + t.templateKey),
            })),
          });
          setMessage(
            result.ok
              ? "Course activated. Identical replay reuses the existing activation."
              : "Activation was not completed (" +
                  result.code +
                  "). Review the package, configuration and schedule.",
          );
          setActivated(result.ok);
        } catch {
          setMessage(
            "Activation status could not be verified. Retrying the same schedule is safe.",
          );
        } finally {
          setPending(false);
        }
      }}
    >
      <label>
        Cohort
        <select name="cohort" required disabled={pending}>
          <option value="">Select matching cohort</option>
          {options.cohorts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
      </label>
      <label>
        Instructor
        <select name="instructor" required disabled={pending}>
          <option value="">Select instructor</option>
          {options.instructors.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </select>
      </label>
      <p>
        Enter all schedule times in UTC. Activation publishes coursework with
        these explicit windows.
      </p>
      {options.assignments.map((t) => (
        <fieldset key={t.templateKey}>
          <legend>Assignment: {t.title}</legend>
          <label>
            Opens (UTC)
            <input
              type="datetime-local"
              name={"a-open-" + t.templateKey}
              required
              disabled={pending}
            />
          </label>
          <label>
            Due (UTC)
            <input
              type="datetime-local"
              name={"a-end-" + t.templateKey}
              required
              disabled={pending}
            />
          </label>
        </fieldset>
      ))}
      {options.assessments.map((t) => (
        <fieldset key={t.templateKey}>
          <legend>Assessment: {t.title}</legend>
          <label>
            Opens (UTC)
            <input
              type="datetime-local"
              name={"e-open-" + t.templateKey}
              required
              disabled={pending}
            />
          </label>
          <label>
            Closes (UTC)
            <input
              type="datetime-local"
              name={"e-end-" + t.templateKey}
              required
              disabled={pending}
            />
          </label>
        </fieldset>
      ))}
      <label>
        Reason
        <textarea
          name="reason"
          minLength={5}
          maxLength={300}
          required
          disabled={pending}
        />
      </label>
      <button
        className="button"
        disabled={
          pending || !options.cohorts.length || !options.instructors.length
        }
      >
        {pending ? "Activating…" : "Activate cohort delivery"}
      </button>
      <p role="status">{message}</p>
      {activated && (
        <Link className="button secondary" href="/admin/commerce">
          Continue to commercial offers
        </Link>
      )}
    </form>
  );
}
