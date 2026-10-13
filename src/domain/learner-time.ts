// Learner-facing class times, shown in the learner's stored profile time
// zone with a fixed locale so the server render never depends on the host's
// own time zone or locale. student_profiles.timezone is unconstrained text,
// so an unrecognised zone falls back to UTC (and says so) instead of
// throwing a RangeError and failing the whole page.
export function learnerDisplayTimeZone(zone: string | null | undefined) {
  if (!zone) return "UTC";
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return zone;
  } catch {
    return "UTC";
  }
}

export function formatLearnerDateTime(iso: string, zone: string) {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: zone,
  }).format(new Date(iso));
}

// The two ends of a class, e.g. "13 Oct 2026, 09:00" and "10:00". The end
// repeats its date when it falls on another calendar day in the learner's
// zone. Each end is rendered as its own <time> element.
export function learnerRangeParts(start: string, end: string, zone: string) {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: zone });
  const sameDay = day.format(new Date(start)) === day.format(new Date(end));
  return {
    start: formatLearnerDateTime(start, zone),
    end: sameDay
      ? new Intl.DateTimeFormat("en-GB", {
          timeStyle: "short",
          timeZone: zone,
        }).format(new Date(end))
      : formatLearnerDateTime(end, zone),
  };
}
