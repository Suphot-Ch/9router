// Trust boundary for the schedule JSON stored in the connection's data blob:
// anything that would make evaluation ambiguous is rejected with a precise message.
import { describe, expect, it } from "vitest";
import {
  normalizeConnectionSchedule,
  parseTimeOfDay,
  validateConnectionSchedule,
} from "@/shared/services/connectionSchedule.js";

const valid = () => ({
  enabled: true,
  days: [5, 1, 3],
  start: "09:00",
  end: "18:00",
  timezone: "Asia/Bangkok",
});

const errorOf = (input) => validateConnectionSchedule(input).error;

describe("connection schedule validation", () => {
  it("normalizes a valid schedule", () => {
    const { schedule, error } = validateConnectionSchedule(valid());

    expect(error).toBeUndefined();
    expect(schedule).toEqual({
      enabled: true,
      days: [1, 3, 5],
      start: "09:00",
      end: "18:00",
      timezone: "Asia/Bangkok",
    });
  });

  it("pads single-digit hours and accepts 00:00-23:59", () => {
    const { schedule } = validateConnectionSchedule({ ...valid(), start: "9:05", end: "0:00" });

    expect(schedule.start).toBe("09:05");
    expect(schedule.end).toBe("00:00");
    expect(parseTimeOfDay("23:59")).toBe(1439);
  });

  it("defaults to the configured server timezone when none is supplied", () => {
    const { schedule } = validateConnectionSchedule({ ...valid(), timezone: undefined });

    expect(schedule.timezone).toBe("Asia/Bangkok");
  });

  it("keeps the applied-state bookkeeping the service writes", () => {
    const { schedule } = validateConnectionSchedule({
      ...valid(),
      lastAppliedState: "disabled",
      lastAppliedAt: "2026-06-01T11:00:00.000Z",
    });

    expect(schedule.lastAppliedState).toBe("disabled");
    expect(schedule.lastAppliedAt).toBe("2026-06-01T11:00:00.000Z");

    const bogus = validateConnectionSchedule({ ...valid(), lastAppliedState: "maybe" }).schedule;
    expect(bogus.lastAppliedState).toBeUndefined();
  });

  it("allows an empty day list only while the schedule is switched off", () => {
    expect(validateConnectionSchedule({ ...valid(), enabled: false, days: [] }).schedule).toMatchObject({
      enabled: false,
      days: [],
    });
    expect(errorOf({ ...valid(), days: [] })).toMatch(/days must not be empty/);
  });

  it("rejects malformed day lists", () => {
    expect(errorOf({ ...valid(), days: "1,2" })).toMatch(/days must be an array/);
    expect(errorOf({ ...valid(), days: [1, 7] })).toMatch(/invalid weekday 7/);
    expect(errorOf({ ...valid(), days: [-1] })).toMatch(/invalid weekday -1/);
    expect(errorOf({ ...valid(), days: [1.5] })).toMatch(/invalid weekday 1.5/);
    expect(errorOf({ ...valid(), days: ["1"] })).toMatch(/invalid weekday "1"/);
    expect(errorOf({ ...valid(), days: [2, 2] })).toMatch(/weekday 2 twice/);
  });

  it("rejects malformed times", () => {
    for (const start of ["24:00", "12:60", "9", "noon", "", "09:0", null, undefined]) {
      expect(errorOf({ ...valid(), start })).toMatch(/start must be a 24h time/);
    }
    for (const end of ["25:10", "18:61", "1800", -5]) {
      expect(errorOf({ ...valid(), end })).toMatch(/end must be a 24h time/);
    }
  });

  it("rejects an unknown timezone", () => {
    expect(errorOf({ ...valid(), timezone: "Mars/Olympus" })).toMatch(/valid IANA timezone/);
    expect(errorOf({ ...valid(), timezone: "Asia/Bangkok/Nope" })).toMatch(/valid IANA timezone/);
  });

  it("rejects non-object payloads and a missing enabled flag", () => {
    expect(errorOf(null)).toMatch(/schedule must be an object/);
    expect(errorOf([])).toMatch(/schedule must be an object/);
    expect(errorOf("on")).toMatch(/schedule must be an object/);
    expect(errorOf({ ...valid(), enabled: "true" })).toMatch(/enabled must be a boolean/);
    expect(errorOf({ ...valid(), enabled: undefined })).toMatch(/enabled must be a boolean/);
  });

  it("normalizes only enabled schedules for the evaluator", () => {
    expect(normalizeConnectionSchedule(valid())).toMatchObject({ enabled: true, days: [1, 3, 5] });
    expect(normalizeConnectionSchedule({ ...valid(), enabled: false })).toBeNull();
    expect(normalizeConnectionSchedule({ ...valid(), days: [] })).toBeNull();
  });
});
