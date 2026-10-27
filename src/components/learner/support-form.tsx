"use client";
import { useActionState, useRef } from "react";
import type { LearnerCourse } from "@/domain/learner-contract";

// The delivery state the support service reports (docs/61 §4): a message
// is saved and queued through the email outbox, and is never reported as
// sent until the provider confirms it.
export type SupportFormState = {
  delivery?: "QUEUED" | "SENT" | "FAILED";
  rateLimited?: boolean;
  reference?: string;
  error?: string;
};

export type SupportFormAction = (
  previous: SupportFormState,
  form: FormData,
) => Promise<SupportFormState>;

export const SUPPORT_CATEGORIES = [
  ["TECHNICAL", "Technical problem"],
  ["COURSE", "Course or content question"],
  ["ACCOUNT", "Account and sign-in"],
  ["BILLING", "Payments and receipts"],
  ["FEEDBACK", "Feedback or suggestion"],
  ["OTHER", "Something else"],
] as const;

export const SUPPORT_SUBJECT_MAX = 120;
export const SUPPORT_MESSAGE_MAX = 4000;

export const SUPPORT_DELIVERY_TEXT: Record<
  NonNullable<SupportFormState["delivery"]>,
  string
> = {
  QUEUED:
    "Your message is saved and queued for support@ducelio.com. Delivery is pending: it has not been confirmed as sent yet.",
  SENT: "Your message was sent to support@ducelio.com.",
  FAILED:
    "Your message is saved, but it could not be delivered yet. Please try again later or email support@ducelio.com directly.",
};

// /student/support: the Support & Feedback form linked from the footer.
export function SupportFormView({
  courses,
  sendSupportAction,
}: {
  courses: LearnerCourse[];
  sendSupportAction: SupportFormAction;
}) {
  const [state, action, pending] = useActionState<SupportFormState, FormData>(
    sendSupportAction,
    {},
  );
  // One idempotency key per message: a retried submit replays the same
  // message instead of sending a second one. The key is kept until the
  // service reports a saved message (a new reference), then replaced.
  const key = useRef<{ value: string; after?: string } | null>(null);
  const submit = (form: FormData) => {
    if (!key.current || key.current.after !== state.reference)
      key.current = { value: crypto.randomUUID(), after: state.reference };
    form.set("requestKey", key.current.value);
    action(form);
  };
  return (
    <div className="ln-page">
      <header className="ln-page__head">
        <h1>Support &amp; Feedback</h1>
        <p className="ln-muted">
          Tell the Ducelio team about a problem, a question or an idea. We reply
          by email.
        </p>
      </header>
      <section className="ln-panel" aria-labelledby="ln-support-heading">
        <h2 id="ln-support-heading">Send a message</h2>
        <form action={submit} className="ln-form">
          <fieldset disabled={pending} className="ln-fieldset">
            <div className="ln-field">
              <label htmlFor="ln-support-category" className="ln-label">
                Category
              </label>
              <select
                id="ln-support-category"
                name="category"
                required
                defaultValue=""
              >
                <option value="" disabled>
                  Choose a category
                </option>
                {SUPPORT_CATEGORIES.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            {courses.length > 0 && (
              <div className="ln-field">
                <label htmlFor="ln-support-course" className="ln-label">
                  Course (optional)
                </label>
                <select
                  id="ln-support-course"
                  name="enrolmentId"
                  defaultValue=""
                >
                  <option value="">Not about a specific course</option>
                  {courses.map((c) => (
                    <option key={c.enrolmentId} value={c.enrolmentId}>
                      {c.title} · {c.provider}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="ln-field">
              <label htmlFor="ln-support-subject" className="ln-label">
                Subject
              </label>
              <input
                id="ln-support-subject"
                name="subject"
                required
                minLength={3}
                maxLength={SUPPORT_SUBJECT_MAX}
              />
            </div>
            <div className="ln-field">
              <label htmlFor="ln-support-message" className="ln-label">
                Message
              </label>
              <textarea
                id="ln-support-message"
                name="message"
                required
                minLength={10}
                maxLength={SUPPORT_MESSAGE_MAX}
                rows={7}
                aria-describedby="ln-support-help"
              />
              <p id="ln-support-help" className="ln-help">
                Please do not include passwords or payment card details.
              </p>
            </div>
            <button className="button">
              {pending ? "Sending…" : "Send message"}
            </button>
          </fieldset>
        </form>
        <div aria-live="polite">
          {state.error && (
            <p className="ln-feedback is-error" role="alert">
              {state.error}
            </p>
          )}
          {state.rateLimited && (
            <p className="ln-feedback is-error" role="alert">
              You have sent several messages recently. Please wait a while
              before sending another.
            </p>
          )}
          {state.delivery && (
            <p
              className={
                state.delivery === "FAILED"
                  ? "ln-feedback is-error"
                  : "ln-feedback"
              }
              role="status"
            >
              {SUPPORT_DELIVERY_TEXT[state.delivery]}
              {state.reference && (
                <>
                  {" "}
                  Reference: <strong>{state.reference}</strong>.
                </>
              )}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
