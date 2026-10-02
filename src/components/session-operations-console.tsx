"use client";
import { useActionState, useState } from "react";
import {
  runSessionOperation,
  type SessionActionState,
} from "@/app/admin/session-actions";
import {
  updateClassSessionStatus,
  type ClassSessionActionState,
} from "@/app/admin/actions";
import { Card } from "./ui";
import { LocalDateTimeField } from "./local-datetime-field";
import {
  SESSION_ACTIVATION_PAGE_SIZE,
  SESSION_LESSON_PAGE_SIZE,
  type SessionDiscovery,
  type BatchOptions,
} from "@/domain/session-operations";
function Feedback({ state }: { state: SessionActionState }) {
  return (
    <>
      {state.error && <p role="alert">{state.error}</p>}
      {state.message && <p role="status">{state.message}</p>}
    </>
  );
}
function Reschedule({ id, requestId }: { id: string; requestId: string }) {
  const [state, action, pending] = useActionState(runSessionOperation, {});
  return (
    <form action={action}>
      <input type="hidden" name="operation" value="reschedule" />
      <input type="hidden" name="sessionId" value={id} />
      <input type="hidden" name="requestId" value={requestId} />
      <label>
        New start instant (ISO with offset)
        <input
          name="scheduledStart"
          placeholder="2030-01-06T18:00:00Z"
          required
        />
      </label>
      <label>
        Reason
        <input name="reason" minLength={5} maxLength={300} required />
      </label>
      <button className="button secondary" disabled={pending}>
        Reschedule with original duration
      </button>
      <Feedback state={state} />
    </form>
  );
}
function Status({ id }: { id: string }) {
  const [state, action, pending] = useActionState<
    ClassSessionActionState,
    FormData
  >(updateClassSessionStatus, {});
  return (
    <form action={action}>
      <input type="hidden" name="sessionId" value={id} />
      <label>
        Status
        <select name="status" required defaultValue="">
          <option value="" disabled>
            Choose status
          </option>
          <option>COMPLETED</option>
          <option>CANCELLED</option>
        </select>
      </label>
      <label>
        Reason
        <input name="reason" required minLength={5} maxLength={300} />
      </label>
      <button className="button secondary" disabled={pending}>
        Update status
      </button>
      <Feedback state={state} />
    </form>
  );
}
export function SessionOperationsConsole({
  discovery,
  options,
  activationId,
  instructors,
  cohorts,
  requestIds,
  batchRequestId,
  filters,
}: {
  discovery: SessionDiscovery;
  options: BatchOptions;
  activationId?: string;
  instructors: { user_id: string; display_name: string }[];
  cohorts: { id: string; title: string }[];
  requestIds: Record<string, string>;
  batchRequestId: string;
  filters: Record<string, string | undefined>;
}) {
  const [state, action, pending] = useActionState(runSessionOperation, {});
  const [requestId, setRequestId] = useState(batchRequestId);
  const [items, setItems] = useState([
    { lessonId: "", scheduledStart: "", scheduledEnd: "" },
  ]);
  const activation = options.selectedActivation;
  const activationChoices =
    activation && !options.activations.some((x) => x.id === activation.id)
      ? [activation, ...options.activations]
      : options.activations;
  function pagination(offset: number, field = "offset") {
    const q = new URLSearchParams({ section: "Sessions" });
    for (const [key, value] of Object.entries(filters))
      if (value) q.set(key, value);
    if (activationId) q.set("activationId", activationId);
    q.set(field, String(offset));
    return "/admin?" + q.toString();
  }
  return (
    <>
      <Card>
        <h2>Session operations register</h2>
        <form method="get">
          <input type="hidden" name="section" value="Sessions" />
          <label>
            Cohort
            <select name="cohortId" defaultValue={filters.cohortId ?? ""}>
              <option value="">All cohorts</option>
              {cohorts.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            Status
            <select name="status" defaultValue={filters.status ?? ""}>
              <option value="">All states</option>
              <option>SCHEDULED</option>
              <option>COMPLETED</option>
              <option>CANCELLED</option>
            </select>
          </label>
          <LocalDateTimeField
            id="session-from"
            name="from"
            label="Starts from (inclusive)"
            required={false}
          />
          <LocalDateTimeField
            id="session-until"
            name="until"
            label="Starts before (exclusive)"
            required={false}
          />
          <button className="button secondary">Filter sessions</button>
          <a href="/admin?section=Sessions">Clear filters</a>
        </form>
        <p>
          Up to 50 sessions per page. Single-session selectors show at most 200
          cohorts and 500 lessons; these are request bounds, not institutional
          limits. Times below are explicit instants. Cohort start/end dates do
          not impose teaching boundaries.
        </p>
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Session</th>
                <th>Schedule and provenance</th>
                <th>Operations</th>
              </tr>
            </thead>
            <tbody>
              {discovery.rows.map((x) => (
                <tr key={x.id}>
                  <td>
                    {x.lessonTitle}
                    <br />
                    {x.cohortTitle} ({x.cohortStatus})<br />
                    {x.instructorName}
                    <br />
                    {x.programmeTitle} / {x.versionLabel}
                  </td>
                  <td>
                    {x.scheduledStart}
                    <br />
                    {x.scheduledEnd}
                    <br />
                    {x.status}
                    {x.originalId && (
                      <p>
                        <a
                          href={
                            "/admin?section=Sessions&sessionId=" + x.originalId
                          }
                        >
                          Original session
                        </a>
                      </p>
                    )}
                    {x.replacementId && (
                      <p>
                        <a
                          href={
                            "/admin?section=Sessions&sessionId=" +
                            x.replacementId
                          }
                        >
                          Replacement session
                        </a>
                      </p>
                    )}
                  </td>
                  <td>
                    {x.canReschedule && (
                      <Reschedule id={x.id} requestId={requestIds[x.id]} />
                    )}{" "}
                    {x.status === "SCHEDULED" ? (
                      <Status id={x.id} />
                    ) : (
                      "Historical record retained"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!discovery.rows.length && <p>No sessions match these filters.</p>}
        <p>
          {discovery.hasMore
            ? "More matching sessions are available."
            : "End of matching sessions."}
        </p>
        {Number(filters.offset ?? 0) > 0 && (
          <a href={pagination(Math.max(0, Number(filters.offset) - 50))}>
            Previous page
          </a>
        )}{" "}
        {discovery.hasMore && (
          <a href={pagination(Number(filters.offset ?? 0) + 50)}>Next page</a>
        )}
      </Card>
      <Card>
        <h2>Generate an explicit session batch</h2>
        <p>
          One activated course and confirmed instructor. Maximum 100 items per
          request; submit additional batches for more sessions. No recurrence,
          inferred duration or package scheduling defaults are applied.
          Conflicts refuse the whole batch.
        </p>
        <form method="get">
          <input type="hidden" name="section" value="Sessions" />
          <label>
            Activated course
            <select name="activationId" defaultValue={activationId ?? ""}>
              <option value="">Choose activated course</option>
              {activationChoices.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.title} ({x.status})
                </option>
              ))}
            </select>
          </label>
          <input
            type="hidden"
            name="activationOffset"
            value={options.activationOffset}
          />
          <button className="button secondary">Load course lessons</button>
        </form>
        <p>
          Activation page: up to 200 records.{" "}
          {options.hasMore
            ? "More activations are available."
            : "End of activations."}
        </p>
        {options.activationOffset > 0 && (
          <a
            href={pagination(
              Math.max(
                0,
                options.activationOffset - SESSION_ACTIVATION_PAGE_SIZE,
              ),
              "activationOffset",
            )}
          >
            Previous activations
          </a>
        )}{" "}
        {options.hasMore && (
          <a
            href={pagination(
              options.activationOffset + SESSION_ACTIVATION_PAGE_SIZE,
              "activationOffset",
            )}
          >
            Next activations
          </a>
        )}
        {activation && (
          <>
            <p>
              Selected course: {activation.title} ({activation.status}). Lesson
              page: up to 250 records.{" "}
              {options.lessonsHasMore
                ? "More activation lessons are available."
                : "End of activation lessons."}
            </p>
            {options.lessonOffset > 0 && (
              <a
                href={pagination(
                  Math.max(0, options.lessonOffset - SESSION_LESSON_PAGE_SIZE),
                  "lessonOffset",
                )}
              >
                Previous lessons
              </a>
            )}{" "}
            {options.lessonsHasMore && (
              <a
                href={pagination(
                  options.lessonOffset + SESSION_LESSON_PAGE_SIZE,
                  "lessonOffset",
                )}
              >
                Next lessons
              </a>
            )}
            <p>
              Submit the current preview before paging. Page navigation starts a
              new preview; additional independent batches are permitted.
            </p>
          </>
        )}
        {activation && activation.status !== "COMPLETED" && (
          <form action={action}>
            <input type="hidden" name="operation" value="batch" />
            <input type="hidden" name="requestId" value={requestId} />
            <input type="hidden" name="activationId" value={activationId} />
            <input type="hidden" name="items" value={JSON.stringify(items)} />
            <label>
              Confirm batch instructor
              <select
                name="instructorId"
                defaultValue={activation.instructorId}
                required
              >
                <option value="">Choose active instructor</option>
                {instructors.map((x) => (
                  <option key={x.user_id} value={x.user_id}>
                    {x.display_name}
                  </option>
                ))}
              </select>
            </label>
            <h3>Explicit batch preview</h3>
            {items.map((x, i) => (
              <fieldset key={i}>
                <legend>Session {i + 1}</legend>
                <label>
                  Lesson
                  <select
                    value={x.lessonId}
                    required
                    onChange={(e) =>
                      setItems(
                        items.map((row, j) =>
                          j === i ? { ...row, lessonId: e.target.value } : row,
                        ),
                      )
                    }
                  >
                    <option value="">Choose activation lesson</option>
                    {options.lessons.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Start instant (ISO with offset)
                  <input
                    required
                    value={x.scheduledStart}
                    placeholder="2030-01-05T18:00:00Z"
                    onChange={(e) =>
                      setItems(
                        items.map((row, j) =>
                          j === i
                            ? { ...row, scheduledStart: e.target.value }
                            : row,
                        ),
                      )
                    }
                  />
                </label>
                <label>
                  End instant (ISO with offset)
                  <input
                    required
                    value={x.scheduledEnd}
                    placeholder="2030-01-05T19:00:00Z"
                    onChange={(e) =>
                      setItems(
                        items.map((row, j) =>
                          j === i
                            ? { ...row, scheduledEnd: e.target.value }
                            : row,
                        ),
                      )
                    }
                  />
                </label>
                {items.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setItems(items.filter((_, j) => j !== i))}
                  >
                    Remove session {i + 1}
                  </button>
                )}
              </fieldset>
            ))}
            <button
              type="button"
              disabled={items.length >= 100}
              onClick={() =>
                setItems([
                  ...items,
                  { lessonId: "", scheduledStart: "", scheduledEnd: "" },
                ])
              }
            >
              Add explicit session
            </button>
            <label>
              Batch reason
              <input name="reason" required minLength={5} maxLength={300} />
            </label>
            <button className="button" disabled={pending}>
              Generate {items.length} sessions atomically
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setRequestId(crypto.randomUUID());
                setItems([
                  { lessonId: "", scheduledStart: "", scheduledEnd: "" },
                ]);
              }}
            >
              Start new batch request
            </button>
            <Feedback state={state} />
          </form>
        )}
        {activation?.status === "COMPLETED" && (
          <p>Delivery is completed. Batch generation is unavailable.</p>
        )}
      </Card>
    </>
  );
}
