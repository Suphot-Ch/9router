// Per-API-key spending limits: reset-window math.
// Pure functions, fixed Asia/Bangkok (UTC+07:00) boundaries, injected `now`.
import { describe, it, expect } from "vitest";
import {
  RESET_MODES,
  nextResetAt,
  calcResetBoundary,
  getDueResetBoundary,
  isValidResetMode,
  isValidResetDay,
} from "../../src/lib/db/keyReset.js";

const bkk = (iso) => Date.parse(`${iso}+07:00`); // local wall clock → epoch ms
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

describe("reset modes", () => {
  it("accepts only none|monthly|weekly", () => {
    expect(RESET_MODES).toEqual(["none", "monthly", "weekly"]);
    expect(isValidResetMode("monthly")).toBe(true);
    expect(isValidResetMode("weekly")).toBe(true);
    expect(isValidResetMode("none")).toBe(true);
    expect(isValidResetMode("daily")).toBe(false);
    expect(isValidResetMode(undefined)).toBe(false);
  });

  it("validates resetDay ranges per mode", () => {
    expect(isValidResetDay("monthly", 1)).toBe(true);
    expect(isValidResetDay("monthly", 31)).toBe(true);
    expect(isValidResetDay("monthly", 0)).toBe(false);
    expect(isValidResetDay("monthly", 32)).toBe(false);
    expect(isValidResetDay("weekly", 0)).toBe(true);
    expect(isValidResetDay("weekly", 6)).toBe(true);
    expect(isValidResetDay("weekly", 7)).toBe(false);
    expect(isValidResetDay("weekly", -1)).toBe(false);
    expect(isValidResetDay("monthly", 1.5)).toBe(false);
    expect(isValidResetDay("none", null)).toBe(true);
  });
});

describe("nextResetAt", () => {
  it("returns null when the key never resets", () => {
    expect(nextResetAt({ resetMode: "none", from: bkk("2026-11-03T12:00:00") })).toBeNull();
  });

  it("monthly day 31 clamps to the last day of February", () => {
    // Boundary exactly at Jan 31 00:00 local → next is Feb 28 (2026 is not a leap year).
    expect(iso(nextResetAt({ resetMode: "monthly", resetDay: 31, from: bkk("2026-01-31T00:00:00") })))
      .toBe("2026-02-27T17:00:00.000Z");
    // Mid-February still lands on Feb 28, not March.
    expect(iso(nextResetAt({ resetMode: "monthly", resetDay: 31, from: bkk("2026-02-01T09:30:00") })))
      .toBe("2026-02-27T17:00:00.000Z");
  });

  it("monthly advances month by month and never backwards (Jan 31 → Feb 28 → Mar 31)", () => {
    const feb = nextResetAt({ resetMode: "monthly", resetDay: 31, from: bkk("2026-01-31T00:00:00") });
    const mar = nextResetAt({ resetMode: "monthly", resetDay: 31, from: feb });
    expect(iso(feb)).toBe("2026-02-27T17:00:00.000Z");
    expect(iso(mar)).toBe("2026-03-30T17:00:00.000Z"); // Mar 31 00:00 +07
    expect(mar).toBeGreaterThan(feb);
  });

  it("monthly day 1 rolls to the next month's first", () => {
    expect(iso(nextResetAt({ resetMode: "monthly", resetDay: 1, from: bkk("2026-02-10T23:59:59") })))
      .toBe("2026-02-28T17:00:00.000Z"); // Mar 1 00:00 +07
  });

  it("weekly rolls to the configured weekday at local midnight", () => {
    // 2026-11-03 is a Tuesday; next Monday is 2026-11-09 00:00 +07.
    expect(iso(nextResetAt({ resetMode: "weekly", resetDay: 1, from: bkk("2026-11-03T12:00:00") })))
      .toBe("2026-11-08T17:00:00.000Z");
    // On the boundary itself the next one is a full week later.
    expect(iso(nextResetAt({ resetMode: "weekly", resetDay: 1, from: bkk("2026-11-09T00:00:00") })))
      .toBe("2026-11-15T17:00:00.000Z");
    // Sunday (0) is a different rollover than Monday (1).
    expect(iso(nextResetAt({ resetMode: "weekly", resetDay: 0, from: bkk("2026-11-03T12:00:00") })))
      .toBe("2026-11-07T17:00:00.000Z"); // Nov 8 00:00 +07
  });

  it("rejects an invalid resetDay instead of picking something silently", () => {
    expect(() => nextResetAt({ resetMode: "monthly", resetDay: 0, from: 0 })).toThrow(RangeError);
    expect(() => nextResetAt({ resetMode: "weekly", resetDay: 9, from: 0 })).toThrow(RangeError);
    expect(() => nextResetAt({ resetMode: "daily", resetDay: 1, from: 0 })).toThrow(RangeError);
  });
});

describe("calcResetBoundary", () => {
  it("returns the latest boundary crossed since lastResetAt", () => {
    expect(iso(calcResetBoundary({
      resetMode: "monthly", resetDay: 1,
      lastResetAt: new Date(bkk("2026-01-15T00:00:00")).toISOString(),
      now: bkk("2026-03-15T00:00:00"),
    }))).toBe("2026-02-28T17:00:00.000Z"); // Mar 1 00:00 +07, not Feb 1
  });

  it("uses the clamped boundary (day 31 → Feb 28) when that is the latest one", () => {
    expect(iso(calcResetBoundary({
      resetMode: "monthly", resetDay: 31,
      lastResetAt: new Date(bkk("2026-01-20T00:00:00")).toISOString(),
      now: bkk("2026-03-05T00:00:00"),
    }))).toBe("2026-02-27T17:00:00.000Z");
  });

  it("weekly rollover across several weeks picks the most recent Monday", () => {
    expect(iso(calcResetBoundary({
      resetMode: "weekly", resetDay: 1,
      lastResetAt: new Date(bkk("2026-10-01T00:00:00")).toISOString(),
      now: bkk("2026-11-03T12:00:00"),
    }))).toBe("2026-11-01T17:00:00.000Z"); // Nov 2 00:00 +07
  });

  it("returns null before the boundary and for mode none", () => {
    expect(calcResetBoundary({
      resetMode: "monthly", resetDay: 1,
      lastResetAt: new Date(bkk("2026-03-02T00:00:00")).toISOString(),
      now: bkk("2026-03-15T00:00:00"),
    })).toBeNull();
    expect(calcResetBoundary({
      resetMode: "none", resetDay: null,
      lastResetAt: "2020-01-01T00:00:00.000Z",
      now: bkk("2026-11-03T00:00:00"),
    })).toBeNull();
  });

  it("honours the injected now", () => {
    const args = {
      resetMode: "monthly", resetDay: 1,
      lastResetAt: new Date(bkk("2026-01-15T00:00:00")).toISOString(),
    };
    expect(calcResetBoundary({ ...args, now: bkk("2026-01-20T00:00:00") })).toBeNull();
    expect(iso(calcResetBoundary({ ...args, now: bkk("2026-02-02T00:00:00") })))
      .toBe("2026-01-31T17:00:00.000Z"); // Feb 1 00:00 +07
  });

  it("has no baseline → no reset (unknown window)", () => {
    expect(calcResetBoundary({ resetMode: "monthly", resetDay: 1, lastResetAt: null, now: Date.now() })).toBeNull();
  });
});

describe("getDueResetBoundary", () => {
  const row = (over = {}) => ({ resetMode: "monthly", resetDay: 1, lastResetAt: null, createdAt: null, ...over });

  it("reports the ISO boundary to stamp, or null", () => {
    expect(getDueResetBoundary(row({ lastResetAt: "2026-01-15T00:00:00.000Z" }), bkk("2026-03-15T00:00:00")))
      .toBe("2026-02-28T17:00:00.000Z");
    expect(getDueResetBoundary(row({ lastResetAt: "2026-03-02T00:00:00.000Z" }), bkk("2026-03-15T00:00:00")))
      .toBeNull();
  });

  it("falls back to createdAt when lastResetAt was never stamped", () => {
    expect(getDueResetBoundary(row({ createdAt: "2026-01-15T00:00:00.000Z" }), bkk("2026-03-15T00:00:00")))
      .toBe("2026-02-28T17:00:00.000Z");
  });

  it("never resets a key with mode none, whatever the timestamps", () => {
    expect(getDueResetBoundary(
      row({ resetMode: "none", resetDay: null, lastResetAt: "2020-01-01T00:00:00.000Z" }),
      bkk("2026-11-03T00:00:00")
    )).toBeNull();
  });

  it("ignores a malformed/absent baseline", () => {
    expect(getDueResetBoundary(row({ lastResetAt: "not-a-date", createdAt: "also-bad" }), Date.now())).toBeNull();
    expect(getDueResetBoundary(null, Date.now())).toBeNull();
  });
});
