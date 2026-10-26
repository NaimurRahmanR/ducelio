// Presentation helpers for the learner experience (docs/61). Pure
// formatting only: every value they format comes from an authenticated
// server projection (src/domain/learner-contract.ts). Nothing here derives
// state, mastery or results.
import type {
  ActivityKind,
  ActivityState,
  LearnerActivity,
  LearnerCourse,
} from "@/domain/learner-contract";

export const KIND_LABEL: Record<ActivityKind, string> = {
  LESSON: "Class",
  LAB: "Practical",
  REVISION: "Revision",
  ASSESSMENT: "Assessment",
};

// Attendance is not completion and completion is not mastery: the labels
// say only what the server recorded.
export const STATE_LABEL: Record<ActivityState, string> = {
  UPCOMING: "Upcoming",
  OPEN: "Open now",
  ATTENDED: "Attended",
  SUBMITTED: "Submitted, results not released",
  RELEASED: "Results released",
  MISSED: "Missed",
  CLOSED: "Closed",
};

export type Tone = "blue" | "gold" | "green" | "muted";

export const STATE_TONE: Record<ActivityState, Tone> = {
  UPCOMING: "muted",
  OPEN: "blue",
  ATTENDED: "green",
  SUBMITTED: "gold",
  RELEASED: "green",
  MISSED: "gold",
  CLOSED: "muted",
};

export function courseStatusLabel(course: LearnerCourse): string {
  if (course.accessRevoked) return "Access ended";
  if (course.status === "COMPLETED") return "Completed";
  return course.scheduled ? "Active" : "Awaiting timetable";
}

export function courseStatusTone(course: LearnerCourse): Tone {
  if (course.accessRevoked) return "muted";
  if (course.status === "COMPLETED") return "green";
  return course.scheduled ? "blue" : "gold";
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    ISO_DATE.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  );
}

// Calendar arithmetic on YYYY-MM-DD dates, independent of any time zone.
export function shiftDate(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function weekDates(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, i) => shiftDate(weekStart, i));
}

function safeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone });
    return timeZone;
  } catch {
    return "UTC";
  }
}

// The learner's local calendar date of an instant.
export function localDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: safeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

export function formatTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: safeZone(timeZone),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

export function formatDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: safeZone(timeZone),
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(iso));
}

export function formatDateTime(iso: string, timeZone: string): string {
  return `${formatDate(iso, timeZone)}, ${formatTime(iso, timeZone)}`;
}

// Heading for a calendar date (already local), e.g. "Monday 2 November".
export function dayHeading(isoDate: string): { weekday: string; date: string } {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return {
    weekday: new Intl.DateTimeFormat("en-GB", {
      weekday: "long",
      timeZone: "UTC",
    }).format(d),
    date: new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "long",
      timeZone: "UTC",
    }).format(d),
  };
}

export function weekRangeLabel(weekStart: string): string {
  const fmt = (d: string, year: boolean) =>
    new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "short",
      ...(year ? { year: "numeric" } : {}),
      timeZone: "UTC",
    }).format(new Date(`${d}T00:00:00Z`));
  return `${fmt(weekStart, false)} to ${fmt(shiftDate(weekStart, 6), true)}`;
}

export function activityTitle(a: LearnerActivity): string {
  return a.parts > 1 ? `${a.title} (part ${a.part} of ${a.parts})` : a.title;
}

// Groups every activity of a week under its local day. Activities whose
// local date falls outside the seven days (never expected from the server)
// are still returned, in `outside`, so nothing is ever dropped.
export function groupByDay(
  weekStart: string,
  timeZone: string,
  activities: LearnerActivity[],
): {
  days: { date: string; activities: LearnerActivity[] }[];
  outside: LearnerActivity[];
} {
  const dates = weekDates(weekStart);
  const byDate = new Map(dates.map((d) => [d, [] as LearnerActivity[]]));
  const outside: LearnerActivity[] = [];
  const sorted = [...activities].sort(
    (a, b) =>
      Date.parse(a.startsAt) - Date.parse(b.startsAt) ||
      a.itemId.localeCompare(b.itemId),
  );
  for (const a of sorted) {
    const bucket = byDate.get(localDate(a.startsAt, timeZone));
    if (bucket) bucket.push(a);
    else outside.push(a);
  }
  return {
    days: dates.map((date) => ({ date, activities: byDate.get(date)! })),
    outside,
  };
}

// A ratio of two real counts, as a whole percentage for a bar. Never
// invented: with no total there is no ratio.
export function ratio(part: number, total: number): number | null {
  if (!Number.isFinite(total) || total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((part / total) * 100)));
}

export function scoreText(score: number, max: number): string {
  const n = (v: number) =>
    Number.isInteger(v) ? String(v) : v.toFixed(1).replace(/\.0$/, "");
  return `${n(score)} / ${n(max)}`;
}

export function monthLabel(month: string): string {
  const d = new Date(`${month}-01T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return month;
  return new Intl.DateTimeFormat("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(d);
}

export function weekHref(
  base: string,
  weekStart: string,
  extra: Record<string, string | null | undefined> = {},
): string {
  const params = new URLSearchParams();
  params.set("week", weekStart);
  for (const [k, v] of Object.entries(extra)) if (v) params.set(k, v);
  return `${base}?${params.toString()}`;
}

export function workspaceHref(enrolmentId: string): string {
  return `/student/courses/${encodeURIComponent(enrolmentId)}`;
}
