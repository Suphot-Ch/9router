import { describe, expect, it } from "vitest";
import {
  describeConnectionSchedule,
  evaluateConnectionSchedule,
} from "../../src/shared/services/connectionSchedule.js";

// Mon-Fri 09:00-16:15 in Bangkok, matching the badge the owner sees today.
const WORK_HOURS = {
  enabled: true,
  days: [1, 2, 3, 4, 5],
  start: "09:00",
  end: "16:15",
  timezone: "Asia/Bangkok",
};

// +07 fixed offset (no DST since 2001), so UTC math is exact.
const bangkok = (iso) => Date.parse(iso);

describe("describeConnectionSchedule live state", () => {
  it("reports an open window with the time it closes", () => {
    const state = describeConnectionSchedule(WORK_HOURS, bangkok("2026-11-02T10:00:00+07:00"));
    expect(state).toEqual({
      active: true,
      nextChangeAt: new Date(bangkok("2026-11-02T16:15:00+07:00")).toISOString(),
      stateLabel: "on · until 16:15",
    });
  });

  it("names the reason and the resume time when the window is closed", () => {
    const state = describeConnectionSchedule(WORK_HOURS, bangkok("2026-11-02T17:00:00+07:00"));
    expect(state.active).toBe(false);
    expect(state.stateLabel).toBe("off · resumes Tue 09:00");
    expect(state.nextChangeAt).toBe(new Date(bangkok("2026-11-03T09:00:00+07:00")).toISOString());
  });

  it("skips the weekend and resumes on Monday", () => {
    const state = describeConnectionSchedule(WORK_HOURS, bangkok("2026-11-06T20:00:00+07:00"));
    expect(state.active).toBe(false);
    expect(state.stateLabel).toBe("off · resumes Mon 09:00");
  });

  it("flips exactly at the window edges", () => {
    expect(describeConnectionSchedule(WORK_HOURS, bangkok("2026-11-02T09:00:00+07:00")).active).toBe(true);
    expect(describeConnectionSchedule(WORK_HOURS, bangkok("2026-11-02T16:15:00+07:00")).active).toBe(false);
  });

  it("returns null when the schedule is disabled or invalid, so the UI falls back to manual", () => {
    expect(describeConnectionSchedule({ ...WORK_HOURS, enabled: false }, Date.now())).toBeNull();
    expect(describeConnectionSchedule({ ...WORK_HOURS, days: [] }, Date.now())).toBeNull();
    expect(describeConnectionSchedule(null, Date.now())).toBeNull();
  });

  it("claims a state change only when the evaluator says so", () => {
    // The badge flips in the same tick the enforcement flips isActive: same evaluator.
    const moments = [
      "2026-11-02T08:59:00+07:00",
      "2026-11-02T09:00:00+07:00",
      "2026-11-02T16:14:00+07:00",
      "2026-11-02T16:15:00+07:00",
    ];
    for (const moment of moments) {
      const ms = bangkok(moment);
      expect(describeConnectionSchedule(WORK_HOURS, ms).active)
        .toBe(evaluateConnectionSchedule(WORK_HOURS, ms).active);
    }
  });
});
