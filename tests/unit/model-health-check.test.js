import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  HEALTH_CHECK_CONCURRENCY,
  SLOW_THRESHOLD_MS,
  buildHealthSummary,
  formatLatency,
  mapWithConcurrency,
} from "../../src/app/(dashboard)/dashboard/providers/[id]/healthCheckUtils.js";

const page = readFileSync(
  new URL("../../src/app/(dashboard)/dashboard/providers/[id]/page.js", import.meta.url),
  "utf8"
);
const modal = readFileSync(
  new URL("../../src/app/(dashboard)/dashboard/providers/[id]/HealthCheckModal.js", import.meta.url),
  "utf8"
);
const modelRow = readFileSync(
  new URL("../../src/app/(dashboard)/dashboard/providers/[id]/ModelRow.js", import.meta.url),
  "utf8"
);

describe("model health check — formatting", () => {
  it("renders sub-second and multi-second latencies", () => {
    expect(formatLatency(0)).toBe("0ms");
    expect(formatLatency(312)).toBe("312ms");
    expect(formatLatency(1499)).toBe("1.5s");
    expect(formatLatency(1500)).toBe("1.5s");
  });

  it("returns a placeholder for unknown latency", () => {
    expect(formatLatency(null)).toBe("—");
    expect(formatLatency(undefined)).toBe("—");
    expect(formatLatency(-1)).toBe("—");
  });
});

describe("model health check — summary", () => {
  it("counts passed, failed, slow and pending rows", () => {
    const summary = buildHealthSummary([
      { ok: true, latencyMs: 120 },
      { ok: true, latencyMs: SLOW_THRESHOLD_MS + 500 },
      { ok: false, latencyMs: 900, error: "HTTP 500" },
      { pending: true, ok: false, latencyMs: null },
    ]);
    expect(summary).toEqual({ total: 4, done: 3, passed: 2, failed: 1, slow: 1, avg: 2810 });
  });

  it("never counts a pending row as failed or slow", () => {
    const summary = buildHealthSummary([{ pending: true }, { pending: true }]);
    expect(summary).toMatchObject({ total: 2, done: 0, passed: 0, failed: 0, slow: 0, avg: null });
  });
});

describe("model health check — concurrency", () => {
  it("never runs more than the configured number of pings at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const seen = [];

    await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], HEALTH_CHECK_CONCURRENCY, async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      seen.push(item);
      inFlight -= 1;
    });

    expect(peak).toBeLessThanOrEqual(HEALTH_CHECK_CONCURRENCY);
    expect(peak).toBeGreaterThan(1);
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("drains the queue when the Stop flag is set", async () => {
    let done = 0;
    let stop = false;

    await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 2, async () => {
      done += 1;
      if (done === 2) stop = true;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }, () => stop);

    expect(done).toBeLessThan(8);
  });

  it("is a no-op for an empty list", async () => {
    let calls = 0;
    await mapWithConcurrency([], 3, async () => { calls += 1; });
    expect(calls).toBe(0);
  });
});

describe("model health check — dashboard wiring", () => {
  it("pings each active model through the existing model test route", () => {
    expect(page).toContain("/api/models/test");
    expect(page).toContain("handleHealthCheck");
    expect(page).toContain("mapWithConcurrency");
    expect(page).toContain("HEALTH_CHECK_CONCURRENCY");
    expect(page).toContain("Health Check");
    expect(page).toContain("<HealthCheckModal");
  });

  it("skips disabled models and includes custom model rows", () => {
    expect(page).toContain("disabledModelIds");
    expect(page).toContain("getProviderCustomModelRows");
    expect(page).toContain("const disabled = new Set(disabledModelIds)");
  });

  it("supports stop and re-run from the summary modal", () => {
    expect(page).toContain("stopHealthCheckRef");
    expect(page).toContain("handleStopHealthCheck");
    expect(modal).toContain("Re-run failed");
    expect(modal).toContain("Re-run all");
    expect(modal).toContain("onStop");
    expect(modal).toContain("Copy");
  });

  it("shows per-model latency inline without breaking legacy string status", () => {
    expect(modelRow).toContain('testStatus === "ok"');
    expect(modelRow).toContain("testStatus?.ok");
    expect(modelRow).toContain("latencyLabel");
  });
});
