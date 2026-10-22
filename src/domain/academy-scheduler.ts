// Ducelio Academy (B2C) deterministic timetable planner.
//
// Pure domain module: no I/O, no clock, no timezone database. It works in
// learner-local calendar dates and minute offsets only. The authoritative
// copy of this algorithm is academy_private.plan_units in migration
// 202610220060_academy_course_engineering.sql, which also converts each
// local session start to an instant in the learner's IANA timezone (and
// refuses a local time that does not exist on a study day). This module is
// used for package validation and the admin review estimates; a parity test
// (tests/academy-course-engineering-db.test.ts) proves both produce the same
// plan for the same input.
//
// Algorithm (identical in SQL):
//   * Study slots are the dates from the start date up to the format's last
//     day (start + weeks*7 - 1) whose ISO weekday is selected. Each slot is
//     one class session of the format's sessionMinutes.
//   * Units are packed in their fixed academic order. LESSON and REVISION
//     units may continue across consecutive sessions; LAB and ASSESSMENT
//     units are indivisible and move to the next session with room.
//   * An ASSESSMENT may not start before minimumDaysAfterTeaching calendar
//     days after the last session that taught a lesson. The planner never
//     reorders units to fill the gap: later teaching waits behind the
//     assessment, so the assessment is always sat before new material.
//   * If any unit does not fit before the last day, the plan is infeasible.

export const ACADEMY_FORMATS = {
  ACCELERATED_2W: { weeks: 2, label: "Accelerated" },
  INTENSIVE_4W: { weeks: 4, label: "Intensive" },
  STANDARD_6W: { weeks: 6, label: "Standard" },
  EXTENDED_8W: { weeks: 8, label: "Extended" },
  FLEXIBLE_12W: { weeks: 12, label: "Flexible" },
} as const;
export type AcademyFormatId = keyof typeof ACADEMY_FORMATS;
export const ACADEMY_FORMAT_IDS = Object.keys(
  ACADEMY_FORMATS,
) as AcademyFormatId[];

export type UnitKind = "LESSON" | "LAB" | "REVISION" | "ASSESSMENT";
export type PlanUnit = {
  kind: UnitKind;
  ref: string;
  minutes: number;
  // ASSESSMENT only.
  minimumDaysAfterTeaching?: number;
};
export const isSplittable = (kind: UnitKind) =>
  kind === "LESSON" || kind === "REVISION";

export type PlannedItem = {
  sequence: number;
  unitIndex: number;
  kind: UnitKind;
  ref: string;
  part: number;
  parts: number;
  sessionIndex: number;
  localDate: string;
  offsetMinutes: number;
  minutes: number;
};
export type PlannedSession = {
  index: number;
  localDate: string;
  usedMinutes: number;
};
export type FeasiblePlan = {
  feasible: true;
  startDate: string;
  endDate: string;
  finishDate: string;
  sessions: PlannedSession[];
  items: PlannedItem[];
  weeklyMinutes: number[];
};
export type InfeasiblePlan = {
  feasible: false;
  code: "INSUFFICIENT_AVAILABILITY";
  startDate: string;
  endDate: string;
  firstUnscheduledUnit: number;
  requiredMinutes: number;
  availableSessions: number;
};
export type Plan = FeasiblePlan | InfeasiblePlan;

export type PlanFormat = { weeks: number; sessionMinutes: number };
export type PlanAvailability = { startDate: string; studyDays: number[] };

const DAY_MS = 86400000;
const dateRe = /^\d{4}-\d{2}-\d{2}$/;
export function toDay(date: string): number {
  if (!dateRe.test(date)) throw new Error("Invalid local date.");
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== date)
    throw new Error("Invalid local date.");
  return ms / DAY_MS;
}
export const fromDay = (day: number) =>
  new Date(day * DAY_MS).toISOString().slice(0, 10);
// ISO weekday, Monday = 1 ... Sunday = 7 (PostgreSQL isodow).
export const isoWeekday = (day: number) =>
  ((new Date(day * DAY_MS).getUTCDay() + 6) % 7) + 1;

export function formatEndDate(startDate: string, weeks: number) {
  return fromDay(toDay(startDate) + weeks * 7 - 1);
}

// Resume state for a learner-requested revision: earlier history is kept
// verbatim and only `units` (the remaining work, a partially taught lesson
// carrying its remaining minutes) is planned from `fromDate`.
export type PlanResume = {
  fromDate: string;
  lastTeachingDate: string | null;
  // The first remaining unit, when it is a partially taught lesson, continues
  // its part numbering.
  firstPartOffset?: number;
};

export function planSchedule(
  units: readonly PlanUnit[],
  format: PlanFormat,
  availability: PlanAvailability,
  resume?: PlanResume,
): Plan {
  const start = toDay(availability.startDate);
  const end = start + format.weeks * 7 - 1;
  const from = resume ? toDay(resume.fromDate) : start;
  const days = new Set(availability.studyDays);
  const slots: number[] = [];
  for (let d = Math.max(from, start); d <= end; d++)
    if (days.has(isoWeekday(d))) slots.push(d);
  const cap = format.sessionMinutes;
  const items: Omit<PlannedItem, "parts">[] = [];
  const used = new Array<number>(slots.length).fill(0);
  let slot = 0;
  let lastTeaching =
    resume?.lastTeachingDate != null ? toDay(resume.lastTeachingDate) : null;
  const fail = (unitIndex: number): InfeasiblePlan => ({
    feasible: false,
    code: "INSUFFICIENT_AVAILABILITY",
    startDate: availability.startDate,
    endDate: fromDay(end),
    firstUnscheduledUnit: unitIndex,
    requiredMinutes: units.reduce((n, u) => n + u.minutes, 0),
    availableSessions: slots.length,
  });

  for (let u = 0; u < units.length; u++) {
    const unit = units[u];
    if (isSplittable(unit.kind)) {
      let remaining = unit.minutes;
      let part =
        u === 0 && resume?.firstPartOffset ? resume.firstPartOffset : 0;
      while (remaining > 0) {
        if (slot >= slots.length) return fail(u);
        const free = cap - used[slot];
        if (free <= 0) {
          slot++;
          continue;
        }
        const take = Math.min(free, remaining);
        part++;
        items.push({
          sequence: items.length + 1,
          unitIndex: u,
          kind: unit.kind,
          ref: unit.ref,
          part,
          sessionIndex: slot,
          localDate: fromDay(slots[slot]),
          offsetMinutes: used[slot],
          minutes: take,
        });
        used[slot] += take;
        remaining -= take;
        if (unit.kind === "LESSON") lastTeaching = slots[slot];
      }
    } else {
      const earliest =
        unit.kind === "ASSESSMENT" && lastTeaching !== null
          ? lastTeaching + (unit.minimumDaysAfterTeaching ?? 0)
          : null;
      for (;;) {
        if (slot >= slots.length) return fail(u);
        if (
          cap - used[slot] < unit.minutes ||
          (earliest !== null && slots[slot] < earliest)
        ) {
          slot++;
          continue;
        }
        break;
      }
      items.push({
        sequence: items.length + 1,
        unitIndex: u,
        kind: unit.kind,
        ref: unit.ref,
        part: 1,
        sessionIndex: slot,
        localDate: fromDay(slots[slot]),
        offsetMinutes: used[slot],
        minutes: unit.minutes,
      });
      used[slot] += unit.minutes;
    }
  }

  const partsByUnit = new Map<number, number>();
  for (const i of items)
    partsByUnit.set(
      i.unitIndex,
      Math.max(partsByUnit.get(i.unitIndex) ?? 0, i.part),
    );
  const sessions: PlannedSession[] = [];
  slots.forEach((d, index) => {
    if (used[index] > 0)
      sessions.push({ index, localDate: fromDay(d), usedMinutes: used[index] });
  });
  const weeklyMinutes = new Array<number>(format.weeks).fill(0);
  for (const s of sessions)
    weeklyMinutes[Math.floor((toDay(s.localDate) - start) / 7)] +=
      s.usedMinutes;
  return {
    feasible: true,
    startDate: availability.startDate,
    endDate: fromDay(end),
    finishDate: sessions.length
      ? sessions[sessions.length - 1].localDate
      : availability.startDate,
    sessions,
    items: items.map((i) => ({ ...i, parts: partsByUnit.get(i.unitIndex)! })),
    weeklyMinutes,
  };
}

// Deterministic weekday patterns used for blueprint-level estimates only
// (never applied to a learner): k study days spread across the week.
const SPREAD = [1, 3, 5, 2, 4, 6, 7];
export const canonicalStudyDays = (k: number) =>
  SPREAD.slice(0, k).sort((a, b) => a - b);
// A fixed Monday so estimates are reproducible.
export const ESTIMATE_START_DATE = "2027-01-04";

// Offered alternatives when a learner's availability is insufficient: the
// learner's own days plus the fewest extra weekdays (in Monday-first order)
// that make the plan feasible, within the format's allowed range. Never
// applied automatically.
export function suggestStudyDays(
  units: readonly PlanUnit[],
  format: PlanFormat & { maxStudyDaysPerWeek: number },
  availability: PlanAvailability,
): number[] | null {
  const chosen = [...new Set(availability.studyDays)];
  const others = [1, 2, 3, 4, 5, 6, 7].filter((d) => !chosen.includes(d));
  for (
    let extra = 1;
    chosen.length + extra <= format.maxStudyDaysPerWeek &&
    extra <= others.length;
    extra++
  ) {
    const days = [...chosen, ...others.slice(0, extra)].sort((a, b) => a - b);
    if (
      planSchedule(units, format, { ...availability, studyDays: days }).feasible
    )
      return days;
  }
  return null;
}
