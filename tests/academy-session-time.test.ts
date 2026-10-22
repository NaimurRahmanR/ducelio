import { describe, expect, it } from "vitest";
import { formatAcademySessionTime } from "@/domain/academy-delivery";

// The Academy classroom renders its scheduled session in the learner's
// timetable timezone, independent of the host timezone, with the correct
// offset on each side of a daylight-saving change.
describe("formatAcademySessionTime", () => {
  it("ignores the host timezone", () => {
    const previous = process.env.TZ;
    process.env.TZ = "Pacific/Auckland";
    try {
      expect(
        formatAcademySessionTime(
          "2026-03-28T19:00:00Z",
          "2026-03-28T20:30:00Z",
          "Europe/London",
        ),
      ).toEqual({
        timeZone: "Europe/London",
        text: "Saturday, 28 March 2026, 19:00 GMT – 20:30 GMT",
      });
    } finally {
      process.env.TZ = previous;
    }
  });

  it("applies summer time after the spring transition", () => {
    expect(
      formatAcademySessionTime(
        "2026-03-30T18:00:00Z",
        "2026-03-30T19:30:00Z",
        "Europe/London",
      ).text,
    ).toBe("Monday, 30 March 2026, 19:00 BST – 20:30 BST");
  });

  it("shows each end's own offset across the spring-forward gap", () => {
    expect(
      formatAcademySessionTime(
        "2026-03-29T00:30:00Z",
        "2026-03-29T02:30:00Z",
        "Europe/London",
      ).text,
    ).toBe("Sunday, 29 March 2026, 00:30 GMT – 03:30 BST");
  });

  it("distinguishes the repeated hour on the autumn transition", () => {
    expect(
      formatAcademySessionTime(
        "2026-10-25T00:30:00Z",
        "2026-10-25T01:30:00Z",
        "Europe/London",
      ).text,
    ).toBe("Sunday, 25 October 2026, 01:30 BST – 01:30 GMT");
    expect(
      formatAcademySessionTime(
        "2026-11-01T05:30:00Z",
        "2026-11-01T07:00:00Z",
        "America/New_York",
      ).text,
    ).toBe("Sunday, 1 November 2026, 01:30 GMT-4 – 02:00 GMT-5");
  });

  it("uses the learner's local date, not the UTC date", () => {
    expect(
      formatAcademySessionTime(
        "2026-03-28T23:30:00Z",
        "2026-03-29T01:00:00Z",
        "Asia/Tokyo",
      ).text,
    ).toBe("Sunday, 29 March 2026, 08:30 GMT+9 – 10:00 GMT+9");
  });

  it("names both dates when a session crosses local midnight", () => {
    expect(
      formatAcademySessionTime(
        "2026-06-01T22:30:00Z",
        "2026-06-01T23:30:00Z",
        "Europe/London",
      ).text,
    ).toBe("Monday, 1 June 2026, 23:30 BST – Tuesday, 2 June 2026, 00:30 BST");
  });

  it("falls back to labelled UTC for an unknown zone, never the host", () => {
    expect(
      formatAcademySessionTime(
        "2026-03-28T19:00:00Z",
        "2026-03-28T20:30:00Z",
        "Not/AZone",
      ),
    ).toEqual({
      timeZone: "UTC",
      text: "Saturday, 28 March 2026, 19:00 UTC – 20:30 UTC",
    });
  });
});
