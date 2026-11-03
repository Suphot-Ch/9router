// Weekly enable/disable windows: evaluation must agree with what the user reads
// in the modal ("Mon-Fri 09:00-18:00 Asia/Bangkok") at every boundary.
import { describe, expect, it } from "vitest";
import {
  evaluateConnectionSchedule,
  formatScheduleSummary,
  getLocalizedDayLabels,
  getScheduleBadgeLabel,
  getWindowDurationMinutes,
  normalizeConnectionSchedule,
  CONNECTION_SCHEDULE_WEEK_ORDER,
} from "@/shared/services/connectionSchedule.js";

const BKK = "Asia/Bangkok"; // UTC+7, no DST

const weekly = (overrides = {}) => ({
  enabled: true,
  days: [1, 2, 3, 4, 5],
  start: "09:00",
  end: "18:00",
  timezone: BKK,
  ...overrides,
});

const at = (iso) => new Date(iso).getTime();

describe("connection schedule evaluation", () => {
  it("is active inside the window", () => {
    // 2026-06-01 is a Monday; 05:00Z = 12:00 in Bangkok.
    const result = evaluateConnectionSchedule(weekly(), at("2026-06-01T05:00:00.000Z"));

    expect(result).toEqual({
      active: true,
      nextChangeAt: "2026-06-01T11:00:00.000Z", // 18:00 Bangkok
    });
  });

  it("is inactive before the window opens and points at the start", () => {
    const result = evaluateConnectionSchedule(weekly(), at("2026-06-01T01:59:00.000Z"));

    expect(result).toEqual({
      active: false,
      nextChangeAt: "2026-06-01T02:00:00.000Z", // 09:00 Bangkok
    });
  });

  it("treats the start boundary as inside and the end boundary as outside", () => {
    expect(evaluateConnectionSchedule(weekly(), at("2026-06-01T02:00:00.000Z")).active).toBe(true);
    expect(evaluateConnectionSchedule(weekly(), at("2026-06-01T10:59:00.000Z")).active).toBe(true);

    const atEnd = evaluateConnectionSchedule(weekly(), at("2026-06-01T11:00:00.000Z"));
    expect(atEnd.active).toBe(false);
    // Next opening is Tuesday 09:00 Bangkok.
    expect(atEnd.nextChangeAt).toBe("2026-06-02T02:00:00.000Z");
  });

  it("is inactive on a weekday that is not selected", () => {
    const mondayOnly = weekly({ days: [2] });

    const result = evaluateConnectionSchedule(mondayOnly, at("2026-06-01T05:00:00.000Z"));

    expect(result.active).toBe(false);
    expect(result.nextChangeAt).toBe("2026-06-02T02:00:00.000Z");
  });

  it("skips the weekend and opens again on Monday", () => {
    // Saturday 12:00 Bangkok.
    const result = evaluateConnectionSchedule(weekly(), at("2026-06-06T05:00:00.000Z"));

    expect(result.active).toBe(false);
    expect(result.nextChangeAt).toBe("2026-06-08T02:00:00.000Z");
  });

  it("keeps an overnight window open past midnight", () => {
    const overnight = weekly({ days: [5], start: "22:00", end: "06:00" });

    // Friday 23:30 Bangkok.
    expect(evaluateConnectionSchedule(overnight, at("2026-06-05T16:30:00.000Z"))).toEqual({
      active: true,
      nextChangeAt: "2026-06-05T23:00:00.000Z", // Saturday 06:00 Bangkok
    });

    // Saturday 02:00 Bangkok — still Friday's window.
    expect(evaluateConnectionSchedule(overnight, at("2026-06-05T19:00:00.000Z")).active).toBe(true);
  });

  it("closes an overnight window on the next local day and waits for the next start day", () => {
    const overnight = weekly({ days: [5], start: "22:00", end: "06:00" });

    // Saturday 06:00 Bangkok — exactly the end boundary.
    const atEnd = evaluateConnectionSchedule(overnight, at("2026-06-05T23:00:00.000Z"));
    expect(atEnd.active).toBe(false);
    expect(atEnd.nextChangeAt).toBe("2026-06-12T15:00:00.000Z"); // next Friday 22:00

    // Saturday 07:00 Bangkok — Saturday is not a selected day.
    expect(evaluateConnectionSchedule(overnight, at("2026-06-06T00:00:00.000Z")).active).toBe(false);
  });

  it("attributes an overnight window to the day it starts, not the day it ends", () => {
    // Tuesday 03:00 Bangkok.
    const tuesdayNight = at("2026-06-01T20:00:00.000Z");

    expect(evaluateConnectionSchedule(weekly({ days: [1], start: "22:00", end: "06:00" }), tuesdayNight).active).toBe(true);
    expect(evaluateConnectionSchedule(weekly({ days: [2], start: "22:00", end: "06:00" }), tuesdayNight).active).toBe(false);
  });

  it("evaluates the same instant differently per timezone", () => {
    const instant = at("2026-06-01T05:00:00.000Z"); // 12:00 Bangkok, 05:00 UTC

    expect(evaluateConnectionSchedule(weekly({ timezone: BKK }), instant).active).toBe(true);
    expect(evaluateConnectionSchedule(weekly({ timezone: "UTC" }), instant).active).toBe(false);
    expect(evaluateConnectionSchedule(weekly({ timezone: "America/New_York" }), instant).active).toBe(false);
  });

  it("treats end == start as a full-day window", () => {
    const fullDay = weekly({ days: [1], start: "09:00", end: "09:00" });

    expect(getWindowDurationMinutes("09:00", "09:00")).toBe(1440);
    expect(evaluateConnectionSchedule(fullDay, at("2026-06-01T05:00:00.000Z")).active).toBe(true);
    // Tuesday 08:59 Bangkok — still Monday's 24h window.
    expect(evaluateConnectionSchedule(fullDay, at("2026-06-02T01:59:00.000Z")).active).toBe(true);
    expect(evaluateConnectionSchedule(fullDay, at("2026-06-02T02:00:00.000Z")).active).toBe(false);
  });

  it("converts wall-clock bounds through a DST change instead of adding fixed hours", () => {
    // 2026-03-08 is a Sunday: New York jumps 02:00 EST → 03:00 EDT, so a
    // 01:30-03:30 window is one real hour long, not two.
    const dst = weekly({ days: [0], start: "01:30", end: "03:30", timezone: "America/New_York" });

    expect(evaluateConnectionSchedule(dst, at("2026-03-08T06:29:00.000Z")).active).toBe(false); // 01:29 EST
    expect(evaluateConnectionSchedule(dst, at("2026-03-08T06:30:00.000Z")).active).toBe(true);  // 01:30 EST
    expect(evaluateConnectionSchedule(dst, at("2026-03-08T07:29:00.000Z")).active).toBe(true);  // 03:29 EDT
    expect(evaluateConnectionSchedule(dst, at("2026-03-08T07:30:00.000Z")).active).toBe(false); // 03:30 EDT
  });

  it("returns null when the schedule is absent, disabled or invalid", () => {
    expect(evaluateConnectionSchedule(null)).toBeNull();
    expect(evaluateConnectionSchedule(undefined)).toBeNull();
    expect(evaluateConnectionSchedule({ ...weekly(), enabled: false })).toBeNull();
    expect(evaluateConnectionSchedule({ ...weekly(), days: [9] })).toBeNull();
    expect(evaluateConnectionSchedule({ ...weekly(), timezone: "Mars/Olympus" })).toBeNull();
    expect(normalizeConnectionSchedule({ ...weekly(), enabled: false })).toBeNull();
  });

  it("accepts an injected clock as a Date or epoch ms", () => {
    const iso = "2026-06-01T05:00:00.000Z";
    expect(evaluateConnectionSchedule(weekly(), new Date(iso))).toEqual(evaluateConnectionSchedule(weekly(), at(iso)));
  });
});

describe("connection schedule summary", () => {
  it("renders compact weekday runs", () => {
    expect(formatScheduleSummary(weekly())).toBe("Mon-Fri 09:00-18:00 (Asia/Bangkok)");
    expect(formatScheduleSummary(weekly({ days: [1, 3, 5] }))).toBe("Mon, Wed, Fri 09:00-18:00 (Asia/Bangkok)");
    expect(formatScheduleSummary(weekly({ days: [0, 6] }))).toBe("Sat-Sun 09:00-18:00 (Asia/Bangkok)");
    expect(formatScheduleSummary(weekly({ days: [0, 1, 2, 3, 4, 5, 6] }))).toBe("Every day 09:00-18:00 (Asia/Bangkok)");
  });

  it("supports localized day labels", () => {
    const dayLabels = { 0: "อา.", 1: "จ.", 2: "อ.", 3: "พ.", 4: "พฤ.", 5: "ศ.", 6: "ส." };

    expect(formatScheduleSummary(weekly({ days: [1, 2] }), { dayLabels })).toBe("จ.-อ. 09:00-18:00 (Asia/Bangkok)");
  });

  it("returns an empty summary for unusable input", () => {
    expect(formatScheduleSummary(null)).toBe("");
    expect(formatScheduleSummary({ start: "nope" })).toBe("");
  });

  it("builds the compact row badge", () => {
    expect(getScheduleBadgeLabel(weekly())).toBe("Auto 09:00-18:00");
    expect(getScheduleBadgeLabel({ ...weekly(), enabled: false })).toBe("Auto off");
    expect(getScheduleBadgeLabel(null)).toBeNull();
  });
});

describe("connection schedule day labels", () => {
  it("labels all seven days, Monday first", () => {
    const labels = getLocalizedDayLabels("en");

    // Integer-like keys always enumerate ascending, so assert coverage + order constant.
    expect(Object.keys(labels).map(Number).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(CONNECTION_SCHEDULE_WEEK_ORDER).toEqual([1, 2, 3, 4, 5, 6, 0]);
    expect(labels[1].short).toBe("Mon");
    expect(labels[0].short).toBe("Sun");
    expect(labels[0].long).toBe("Sunday");
  });

  it("localizes to the app locale", () => {
    const thai = getLocalizedDayLabels("th");
    const japanese = getLocalizedDayLabels("ja");

    expect(Object.keys(thai)).toHaveLength(7);
    expect(thai[1].short).not.toBe("Mon");
    expect(japanese[1].long).not.toBe("Monday");
  });

  it("falls back to English for an unusable locale", () => {
    expect(getLocalizedDayLabels("not a locale").hasOwnProperty(1)).toBe(true);
  });
});
