import { learnerRangeParts } from "@/domain/learner-time";

// A class's start and end, each a machine-readable instant in its own
// <time> element; the visible text is in the learner's time zone.
export function LearnerTimeRange({
  start,
  end,
  zone,
}: {
  start: string;
  end: string;
  zone: string;
}) {
  const text = learnerRangeParts(start, end, zone);
  return (
    <>
      <time dateTime={new Date(start).toISOString()}>{text.start}</time>
      {" – "}
      <time dateTime={new Date(end).toISOString()}>{text.end}</time>
    </>
  );
}
