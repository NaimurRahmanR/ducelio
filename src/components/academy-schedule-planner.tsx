"use client";
import { useActionState, useState, useSyncExternalStore } from "react";
import {
  confirmScheduleAction,
  previewRevisionAction,
  previewScheduleAction,
  reviseScheduleAction,
  type PlanActionState,
} from "@/app/student/academy/actions";
import {
  KIND_LABELS,
  WEEKDAYS,
  type AcademyPlan,
} from "@/domain/academy-delivery";
import {
  ACADEMY_FORMATS,
  type AcademyFormatId,
} from "@/domain/academy-scheduler";

type Format = {
  formatId: AcademyFormatId;
  weeks: number;
  sessionMinutes: number;
  minStudyDays: number;
  maxStudyDays: number;
};

const dateText = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone,
  }).format(new Date(iso));
const timeText = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(new Date(iso));
const localDay = (d: string) =>
  new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${d}T00:00:00Z`));
const hours = (m: number) => `${Math.round((m / 60) * 10) / 10} h`;

// The browser's timezone database and zone, read hydration-safely: the
// server render uses a fixed fallback, and the client snapshot replaces it.
const FALLBACK_ZONE = "Europe/London";
const noSubscription = () => () => {};
let browserZones: string[] | null = null;
function zoneList() {
  try {
    return (browserZones ??= Intl.supportedValuesOf("timeZone"));
  } catch {
    return (browserZones ??= ["UTC", FALLBACK_ZONE, "America/New_York"]);
  }
}
const SERVER_ZONES = [FALLBACK_ZONE];
function useZones(current: string) {
  const list = useSyncExternalStore(
    noSubscription,
    zoneList,
    () => SERVER_ZONES,
  );
  return list.includes(current) ? list : [current, ...list];
}
function useDeviceZone() {
  return useSyncExternalStore(
    noSubscription,
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || FALLBACK_ZONE,
    () => FALLBACK_ZONE,
  );
}

// The learner's own preview: exactly what the database would confirm.
function Preview({ plan }: { plan: AcademyPlan }) {
  if (!plan.feasible)
    return (
      <div className="acad-outcome error" role="alert">
        <p>{plan.message}</p>
        {plan.alternatives && plan.alternatives.length > 0 && (
          <>
            <p>These choices would work (nothing has been changed):</p>
            <ul className="acad-issues">
              {plan.alternatives.map((a, i) => (
                <li key={i}>
                  {ACADEMY_FORMATS[a.formatId].label} (
                  {ACADEMY_FORMATS[a.formatId].weeks} weeks) on{" "}
                  {a.studyDays.map((d) => WEEKDAYS[d - 1][1]).join(", ")}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    );
  const tz = plan.timezone;
  const sittings = plan.items.filter((i) => i.kind === "ASSESSMENT");
  const labs = plan.items.filter((i) => i.kind === "LAB");
  const sessions = new Set(
    plan.items.filter((i) => !i.carried).map((i) => i.localDate),
  ).size;
  const peak = Math.max(...plan.weeklyMinutes, 1);
  return (
    <section className="acad-preview" aria-labelledby="preview-title">
      <h3 id="preview-title">Your timetable preview</h3>
      <dl className="acad-facts">
        <div>
          <dt>Starts</dt>
          <dd>{localDay(plan.startOn)}</dd>
        </div>
        <div>
          <dt>Expected finish</dt>
          <dd>{plan.finishOn ? localDay(plan.finishOn) : "—"}</dd>
        </div>
        <div>
          <dt>Course window ends</dt>
          <dd>{localDay(plan.endOn)}</dd>
        </div>
        <div>
          <dt>Classes</dt>
          <dd>
            {sessions} × up to {plan.sessionMinutes} min at {plan.localTime} (
            {tz})
          </dd>
        </div>
      </dl>
      <h4>Weekly study load</h4>
      <ol className="acad-weeks">
        {plan.weeklyMinutes.map((m, w) => (
          <li key={w}>
            <span>Week {w + 1}</span>
            <span className="acad-bar" aria-hidden="true">
              <span style={{ width: `${(m / peak) * 100}%` }} />
            </span>
            <span>{hours(m)}</span>
          </li>
        ))}
      </ol>
      <h4>Assessments</h4>
      <ul className="acad-sittings">
        {sittings.map((s) => (
          <li key={s.ref}>
            <strong>{s.title}</strong> · opens {timeText(s.opensAt!, tz)}, sit
            by {timeText(s.closesAt!, tz)} · {s.minutes} min
            {s.carried && " · unchanged"}
          </li>
        ))}
      </ul>
      <p className="muted">
        {labs.length} practical activities and every lesson in order, with
        preparation time before each assessment.
      </p>
      <details>
        <summary>Full lesson sequence</summary>
        <ol className="acad-sequence">
          {plan.items.map((i, n) => (
            <li key={n}>
              <span className="muted">{dateText(i.startsAt, tz)}</span>{" "}
              {KIND_LABELS[i.kind]}: {i.title}
              {i.parts > 1 ? ` (part ${i.part} of ${i.parts})` : ""} ·{" "}
              {i.minutes} min
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}

function Weekdays({
  value,
  onChange,
}: {
  value: number[];
  onChange: (v: number[]) => void;
}) {
  return (
    <fieldset className="acad-days">
      <legend>Study days</legend>
      {WEEKDAYS.map(([n, label]) => (
        <label key={n} className={value.includes(n) ? "on" : ""}>
          <input
            type="checkbox"
            name="studyDays"
            value={n}
            checked={value.includes(n)}
            onChange={(e) =>
              onChange(
                e.target.checked
                  ? [...value, n].sort()
                  : value.filter((d) => d !== n),
              )
            }
          />
          {label}
        </label>
      ))}
    </fieldset>
  );
}

export function SchedulePlanner({
  enrolmentId,
  formats,
  fixedFormatId,
  today,
}: {
  enrolmentId: string;
  formats: Format[];
  fixedFormatId: AcademyFormatId | null;
  today: string;
}) {
  const available = fixedFormatId
    ? formats.filter((f) => f.formatId === fixedFormatId)
    : formats;
  const [formatId, setFormatId] = useState<AcademyFormatId>(
    available[Math.min(2, available.length - 1)]?.formatId ??
      available[0].formatId,
  );
  const format = available.find((f) => f.formatId === formatId) ?? available[0];
  const [days, setDays] = useState<number[]>(
    [1, 3, 5, 6, 2, 4, 7].slice(0, format.minStudyDays).sort(),
  );
  const deviceZone = useDeviceZone();
  const [chosenZone, setTimezone] = useState<string | null>(null);
  const timezone = chosenZone ?? deviceZone;
  const [requestKey] = useState(() => crypto.randomUUID());
  const [preview, previewAction, previewing] = useActionState<
    PlanActionState,
    FormData
  >(previewScheduleAction, {});
  const [confirm, confirmAction, confirming] = useActionState<
    PlanActionState,
    FormData
  >(confirmScheduleAction, {});
  const zones = useZones(timezone);
  const daysOk =
    days.length >= format.minStudyDays && days.length <= format.maxStudyDays;
  return (
    <form className="acad-planner" action={previewAction}>
      <input type="hidden" name="enrolmentId" value={enrolmentId} />
      <input type="hidden" name="requestKey" value={requestKey} />
      <fieldset className="acad-formats">
        <legend>Learning format</legend>
        {available.map((f) => (
          <label
            key={f.formatId}
            className={
              f.formatId === formatId ? "acad-format on" : "acad-format"
            }
          >
            <input
              type="radio"
              name="formatId"
              value={f.formatId}
              checked={f.formatId === formatId}
              onChange={() => setFormatId(f.formatId)}
            />
            <strong>{ACADEMY_FORMATS[f.formatId].label}</strong>
            <span>{f.weeks} weeks</span>
            <small>
              {f.minStudyDays === f.maxStudyDays
                ? f.minStudyDays
                : `${f.minStudyDays}–${f.maxStudyDays}`}{" "}
              days a week · classes up to {f.sessionMinutes} min
            </small>
          </label>
        ))}
      </fieldset>
      <p className="muted">
        Every format teaches the same lessons and assessments to the same
        standard; only the pace changes.
      </p>
      <div className="acad-grid-3">
        <label>
          Start date
          <input
            type="date"
            name="startOn"
            min={today}
            required
            defaultValue={today}
          />
        </label>
        <label>
          Class time
          <input
            type="time"
            name="localTime"
            required
            defaultValue="19:00"
            step={300}
          />
        </label>
        <label>
          Timezone
          <select
            name="timezone"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
          >
            {zones.map((z) => (
              <option key={z}>{z}</option>
            ))}
          </select>
        </label>
      </div>
      <Weekdays value={days} onChange={setDays} />
      {!daysOk && (
        <p className="muted" role="status">
          Choose{" "}
          {format.minStudyDays === format.maxStudyDays
            ? format.minStudyDays
            : `${format.minStudyDays} to ${format.maxStudyDays}`}{" "}
          study days for this format.
        </p>
      )}
      <div className="acad-actions">
        <button className="button secondary" disabled={previewing || !daysOk}>
          {previewing ? "Building preview…" : "Preview my timetable"}
        </button>
        <button
          className="button"
          formAction={confirmAction}
          disabled={confirming || !daysOk || !preview.plan?.feasible}
        >
          {confirming ? "Confirming…" : "Confirm this timetable"}
        </button>
      </div>
      {preview.error && <p role="alert">{preview.error}</p>}
      {confirm.error && <p role="alert">{confirm.error}</p>}
      {confirm.message && <p role="status">{confirm.message}</p>}
      {preview.plan && <Preview plan={preview.plan} />}
    </form>
  );
}

export function ScheduleRevision({
  enrolmentId,
  revision,
  format,
  current,
  tomorrow,
}: {
  enrolmentId: string;
  revision: number;
  format: Format;
  current: { studyDays: number[]; localTime: string; timezone: string };
  tomorrow: string;
}) {
  const [days, setDays] = useState<number[]>(current.studyDays);
  const [requestKey] = useState(() => crypto.randomUUID());
  const [preview, previewAction, previewing] = useActionState<
    PlanActionState,
    FormData
  >(previewRevisionAction, {});
  const [save, saveAction, saving] = useActionState<PlanActionState, FormData>(
    reviseScheduleAction,
    {},
  );
  const [timezone, setTimezone] = useState(current.timezone);
  const zones = useZones(timezone);
  const daysOk =
    days.length >= format.minStudyDays && days.length <= format.maxStudyDays;
  return (
    <form className="acad-planner" action={previewAction}>
      <input type="hidden" name="enrolmentId" value={enrolmentId} />
      <input type="hidden" name="expectedRevision" value={revision} />
      <input type="hidden" name="requestKey" value={requestKey} />
      <p className="muted">
        Changes apply from the date you choose. Everything before it — including
        any assessment you have opened or sat — stays exactly as it is, and your{" "}
        {ACADEMY_FORMATS[format.formatId].label} course still ends on its
        original date.
      </p>
      <div className="acad-grid-3">
        <label>
          Change from
          <input
            type="date"
            name="effectiveOn"
            min={tomorrow}
            required
            defaultValue={tomorrow}
          />
        </label>
        <label>
          Class time
          <input
            type="time"
            name="localTime"
            required
            defaultValue={current.localTime}
            step={300}
          />
        </label>
        <label>
          Timezone
          <select
            name="timezone"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
          >
            {zones.map((z) => (
              <option key={z}>{z}</option>
            ))}
          </select>
        </label>
      </div>
      <Weekdays value={days} onChange={setDays} />
      <div className="acad-actions">
        <button className="button secondary" disabled={previewing || !daysOk}>
          {previewing ? "Building preview…" : "Preview changes"}
        </button>
        <button
          className="button"
          formAction={saveAction}
          disabled={saving || !daysOk || !preview.plan?.feasible}
        >
          {saving ? "Saving…" : "Save new future dates"}
        </button>
      </div>
      {preview.error && <p role="alert">{preview.error}</p>}
      {save.error && <p role="alert">{save.error}</p>}
      {save.message && <p role="status">{save.message}</p>}
      {preview.plan && <Preview plan={preview.plan} />}
    </form>
  );
}
