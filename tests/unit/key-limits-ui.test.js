// Per-API-key spending limits — dashboard UI.
//
// Two layers, matching the other dashboard UI tests in this repo:
//   * the pure helper module is imported and exercised directly (percentages,
//     colour states, payloads, next-reset math);
//   * the components are JSX modules, so their wiring is asserted at source
//     level (which endpoint, which body, which a11y/mobile classes).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  getLimitTone,
  getLimitUsage,
  getKeyLimitStats,
  buildLimitsPayload,
  buildCreateKeyPayload,
  buildResetUsagePayload,
  nextResetInfo,
  describeNextReset,
  resetDayOptions,
  digitsOnly,
  decimalOnly,
} from "@/shared/utils/keyLimits.js";

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");

const modalSource = read("../../src/app/(dashboard)/dashboard/endpoint/components/KeyLimitsModal.js");
const fieldsSource = read("../../src/app/(dashboard)/dashboard/endpoint/components/KeyLimitsFields.js");
const summarySource = read("../../src/app/(dashboard)/dashboard/endpoint/components/KeyLimitsSummary.js");
const pageSource = read("../../src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js");
const resetModuleSource = read("../../src/lib/db/keyReset.js");

describe("percentage + colour helper", () => {
  it("returns green / yellow / red for 100 / 50 / 10 percent remaining", () => {
    expect(getLimitTone(100).key).toBe("green");
    expect(getLimitTone(50).key).toBe("yellow");
    expect(getLimitTone(10).key).toBe("red");
  });

  it("uses the quota table thresholds (>70 green, 30-70 yellow, <30 red)", () => {
    expect(getLimitTone(71).key).toBe("green");
    expect(getLimitTone(70).key).toBe("yellow");
    expect(getLimitTone(30).key).toBe("yellow");
    expect(getLimitTone(29).key).toBe("red");
    expect(getLimitTone(0).key).toBe("red");
    // Same classes the quota table paints.
    expect(getLimitTone(100).text).toContain("text-green-600");
    expect(getLimitTone(50).text).toContain("text-yellow-600");
    expect(getLimitTone(10).text).toContain("text-red-600");
  });

  it("derives the remaining percentage from used / limit", () => {
    expect(getLimitUsage(0, 100).remainingPercent).toBe(100);
    expect(getLimitUsage(50, 100).remainingPercent).toBe(50);
    expect(getLimitUsage(90, 100).remainingPercent).toBe(10);
    expect(getLimitUsage(90, 100).tone.key).toBe("red");
    expect(getLimitUsage(120, 100).remainingPercent).toBe(0);
    expect(getLimitUsage(120, 100).atLimit).toBe(true);
    expect(getLimitUsage(99, 100).atLimit).toBe(false);
  });

  it("treats a zero or missing limit as unlimited (no percentage pressure)", () => {
    for (const limit of [0, "0", null, undefined, ""]) {
      const usage = getLimitUsage(1234, limit);
      expect(usage.unlimited).toBe(true);
      expect(usage.remaining).toBeNull();
      expect(usage.atLimit).toBe(false);
    }
    // usedCost can arrive as a numeric string; it must still be counted.
    expect(getLimitUsage("1.25", 2.5).remainingPercent).toBe(50);
  });

  it("rolls both dimensions up into one 'at limit' flag", () => {
    expect(getKeyLimitStats({ usedTokens: 1, tokenLimit: 1, usedCost: 0, costLimit: 0 }).atLimit).toBe(true);
    expect(getKeyLimitStats({ usedTokens: 0, tokenLimit: 10, usedCost: 5, costLimit: 5 }).atLimit).toBe(true);
    expect(getKeyLimitStats({ usedTokens: 1, tokenLimit: 10, usedCost: 1, costLimit: 5 }).atLimit).toBe(false);
  });
});

describe("limits payloads", () => {
  it("sends 0 (unlimited) for blank limits", () => {
    expect(buildLimitsPayload({ tokenLimit: "", costLimit: "", resetMode: "none" })).toEqual({
      tokenLimit: 0,
      costLimit: 0,
      resetMode: "none",
      resetDay: null,
    });
    expect(buildLimitsPayload({ tokenLimit: "   ", costLimit: null })).toMatchObject({ tokenLimit: 0, costLimit: 0 });
  });

  it("sends numeric limits, a 2dp cost and the reset day", () => {
    expect(buildLimitsPayload({ tokenLimit: "250000", costLimit: "12.345", resetMode: "monthly", resetDay: "3" })).toEqual({
      tokenLimit: 250000,
      costLimit: 12.35,
      resetMode: "monthly",
      resetDay: 3,
    });
    expect(buildLimitsPayload({ tokenLimit: 0, costLimit: "0", resetMode: "weekly", resetDay: "0" })).toEqual({
      tokenLimit: 0,
      costLimit: 0,
      resetMode: "weekly",
      resetDay: 0,
    });
  });

  it("drops resetDay for 'never' and defaults it for a period mode", () => {
    expect(buildLimitsPayload({ resetMode: "none", resetDay: "5" }).resetDay).toBeNull();
    expect(buildLimitsPayload({ resetMode: "monthly", resetDay: "" }).resetDay).toBe(1);
    expect(buildLimitsPayload({ resetMode: "weekly", resetDay: "" }).resetDay).toBe(1);
    expect(buildLimitsPayload({ resetMode: "weekly", resetDay: 6 }).resetDay).toBe(6);
  });

  it("forwards unusable text so the API's validation message is the one shown", () => {
    expect(buildLimitsPayload({ tokenLimit: "abc" }).tokenLimit).toBe("abc");
    expect(buildLimitsPayload({ resetMode: "monthly", resetDay: "x" }).resetDay).toBe("x");
  });

  it("keeps creation optional: an untouched form still posts just the name", () => {
    expect(buildCreateKeyPayload("Default Key")).toEqual({ name: "Default Key" });
    expect(buildCreateKeyPayload("Default Key", { tokenLimit: "", costLimit: "", resetMode: "none" }))
      .toEqual({ name: "Default Key" });
    expect(buildCreateKeyPayload("Capped", { tokenLimit: "100", costLimit: "1", resetMode: "none" }))
      .toEqual({ name: "Capped", tokenLimit: 100, costLimit: 1, resetMode: "none", resetDay: null });
  });

  it("has a dedicated reset-usage body", () => {
    expect(buildResetUsagePayload()).toEqual({ resetUsage: true });
  });
});

describe("next reset", () => {
  // 2026-11-03 00:00 in Asia/Bangkok (UTC+07:00) — a Tuesday.
  const now = Date.parse("2026-11-03T00:00:00+07:00");

  it("returns null when the key never resets", () => {
    expect(nextResetInfo({ resetMode: "none", resetDay: null, now })).toBeNull();
    expect(describeNextReset(null)).toBeNull();
  });

  it("computes the next monthly boundary and its label", () => {
    const info = nextResetInfo({ resetMode: "monthly", resetDay: 3, now });
    expect(info.at).toBe("2026-12-02T17:00:00.000Z");
    expect(info.days).toBe(30);
    expect(info.dateLabel).toBe("3 Dec 2026");
    expect(describeNextReset(info)).toBe("Resets in 30 days, 3 Dec 2026");
  });

  it("computes the next weekly boundary", () => {
    const info = nextResetInfo({ resetMode: "weekly", resetDay: 1, now });
    expect(info.at).toBe("2026-11-08T17:00:00.000Z");
    expect(info.days).toBe(6);
    expect(describeNextReset(info)).toBe("Resets in 6 days, 9 Nov 2026");
  });

  it("does not throw on an incomplete configuration mid-edit", () => {
    expect(nextResetInfo({ resetMode: "monthly", resetDay: "", now })).toBeNull();
  });
});

describe("input sanitising", () => {
  it("keeps token counts digits-only and USD one decimal point", () => {
    expect(digitsOnly("12a3.4 ")).toBe("1234");
    expect(digitsOnly("")).toBe("");
    expect(decimalOnly("1.2.3")).toBe("1.23");
    expect(decimalOnly("$1,50")).toBe("150");
    expect(decimalOnly("0.5")).toBe("0.5");
  });

  it("offers the right reset-day options per mode", () => {
    expect(resetDayOptions("none")).toEqual([]);
    expect(resetDayOptions("monthly")).toHaveLength(31);
    expect(resetDayOptions("weekly").map((o) => o.value)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(resetDayOptions("weekly")[0].label).toBe("Sunday");
  });
});

describe("limits sheet wiring", () => {
  it("PATCHes /api/keys/[id] with the built limits payload on save", () => {
    expect(modalSource).toContain("method: \"PATCH\"");
    expect(modalSource).toContain("fetch(`/api/keys/${apiKey.id}`");
    expect(modalSource).toContain("JSON.stringify(body)");
    expect(modalSource).toContain("send(buildLimitsPayload(values))");
    // The card is updated in place, then the sheet closes.
    expect(modalSource).toContain("onSaved(updated)");
    expect(modalSource).toContain("onClose()");
  });

  it("asks for confirmation before PATCHing resetUsage", () => {
    expect(modalSource).toContain("onRequestReset(");
    expect(modalSource).toContain("send(buildResetUsagePayload())");
    // The page owns the confirmation dialog and only then runs the reset.
    expect(pageSource).toContain("<KeyLimitsModal");
    expect(pageSource).toContain("Reset the usage counters for");
    expect(pageSource).toContain("await run();");
    expect(pageSource).toContain("handleLimitsSaved");
    expect(pageSource).toContain("setKeys((prev) => prev.map((k) => (k.id === id ? { ...k, ...updatedKey } : k)))");
  });

  it("renders the API's validation error inline", () => {
    expect(modalSource).toContain("data.error ||");
    expect(modalSource).toContain("setError(err.message)");
    expect(modalSource).toContain("role=\"alert\"");
    expect(modalSource).toContain("{error &&");
    // A rejected PATCH must not close the sheet or update the card.
    expect(modalSource).toContain("if (!res.ok) {");
  });

  it("labels every input and uses numeric keyboards", () => {
    expect(fieldsSource).toContain("inputMode=\"numeric\"");
    expect(fieldsSource).toContain("inputMode=\"decimal\"");
    expect(fieldsSource).toContain("aria-label=\"Token limit\"");
    expect(fieldsSource).toContain("aria-label=\"USD cost limit\"");
    expect(fieldsSource).toContain("htmlFor={`${idPrefix}-reset-mode`}");
    expect(fieldsSource).toContain("htmlFor={`${idPrefix}-reset-day`}");
    expect(fieldsSource).toContain("htmlFor={`${idPrefix}-reset-mode`}");
  });

  it("is a bottom sheet on mobile with its own scroll container", () => {
    expect(modalSource).toContain("fixed inset-0 z-50 flex items-end");
    expect(modalSource).toContain("sm:items-center");
    expect(modalSource).toContain("max-h-[90dvh]");
    expect(modalSource).toContain("overflow-y-auto");
    expect(modalSource).toContain("role=\"dialog\"");
    expect(modalSource).toContain("aria-modal=\"true\"");
    // 44px targets: h-11 on the close button, both actions and the toggle.
    expect(modalSource).toContain("h-11 w-11");
    expect(modalSource).toContain('size="lg"');
    expect(summarySource).toContain("h-11");
    // No fixed widths that could push a 390px viewport sideways.
    for (const source of [modalSource, fieldsSource, summarySource]) {
      expect(source).not.toMatch(/w-\[\d{3,}px\]/);
    }
  });

  it("shows usage against each cap, with 'Unlimited' and no bar for 0", () => {
    expect(summarySource).toContain("getKeyLimitStats");
    expect(summarySource).toContain("· Unlimited");
    expect(summarySource).toContain("usage.unlimited ?");
    expect(summarySource).toContain("!usage.unlimited &&");
    expect(summarySource).toContain("% left");
    expect(summarySource).toContain("At limit");
    expect(summarySource).toContain("role=\"progressbar\"");
    expect(summarySource).toContain("No reset scheduled");
  });

  it("keeps the create-key flow and its one-time secret copy intact", () => {
    expect(pageSource).toContain("buildCreateKeyPayload(newKeyName.trim(), newKeyLimits)");
    expect(pageSource).toContain("<KeyLimitsFields");
    expect(pageSource).toContain('onClick={() => copy(createdKey, "created_key")}');
    expect(pageSource).toContain("setCreatedKey(data.key)");
  });

  it("imports only bundle-safe reset math", () => {
    // keyReset.js must stay dependency-free for the client bundle to import it.
    expect(resetModuleSource).not.toMatch(/^\s*import\s/m);
    expect(resetModuleSource).not.toContain("require(");
  });
});
