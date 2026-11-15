import { describe, expect, it, vi, afterEach } from "vitest";
import * as rates from "@/sse/services/keyRateLimits.js";

afterEach(() => vi.useRealTimers());
describe("single-process rolling key admission", () => {
  it("atomically admits a burst once per logical request and expires at exactly 60 seconds", () => {
    let now = 100000;
    const c = rates.createKeyRateController({ now: () => now });
    const key = { id: "public-id", rpmLimit: 2 };
    expect(c.admit(key).allowed).toBe(true);
    expect(c.admit(key).allowed).toBe(true);
    expect(c.admit(key)).toMatchObject({ allowed: false, code: "key_rpm_limit", retryAfter: 60 });
    now += 59999;
    expect(c.admit(key).retryAfter).toBe(1);
    now++;
    expect(c.admit(key).allowed).toBe(true);
  });
  it("uses actual prompt+completion only, dedupes attempts, preserves counters on policy edits", () => {
    let now = 100000;
    const c = rates.createKeyRateController({ now: () => now });
    const key = { id: "k", rpmLimit: 0, tpmLimit: 10 };
    c.admit(key);
    c.record("k", { prompt_tokens: 6, completion_tokens: 4, cached_tokens: 100, reasoning_tokens: 100 }, "attempt-1");
    c.record("k", { prompt_tokens: 6, completion_tokens: 4 }, "attempt-1");
    expect(c.status("k", key).tpm.used).toBe(10);
    expect(c.admit(key).code).toBe("key_tpm_limit");
    expect(c.admit({ ...key, tpmLimit: 20 }).allowed).toBe(true);
    expect(c.status("k", key).rpm.used).toBe(2);
    now += 60000;
    expect(c.admit(key).allowed).toBe(true);
  });
  it("reports unknown/estimated usage and restart warmup without claiming a bounded overshoot", () => {
    let now = 0;
    const c = rates.createKeyRateController({ now: () => now });
    c.record("k", null, "missing");
    c.record("k", { prompt_tokens: 999, completion_tokens: 9, estimated: true }, "estimate");
    expect(c.status("k", {}).tpm).toMatchObject({ used: null, coverage: "incomplete", unknownEvents: 2 });
    expect(c.status("k", {})).toMatchObject({ warmingUp: true, scope: "single-process", overshootBounded: false, concurrencyBounded: false, outputBounded: false });
    now = 60000;
    expect(c.status("k", {}).warmingUp).toBe(false);
  });
  it("bounds state without evicting live quota and cleans expired entries", () => {
    let now = 0;
    const c = rates.createKeyRateController({ now: () => now, maxKeys: 2, maxBuckets: 2, maxEvents: 2 });
    c.admit({ id: "a" }).finish(); c.admit({ id: "b" }).finish();
    expect(c.admit({ id: "c", rpmLimit: 1 })).toMatchObject({ allowed: false, status: 503, code: "key_rate_capacity" });
    c.record("a", 3, "one"); c.record("a", 3, "two"); c.record("a", 3, "three");
    expect(c.status("a", {}).tpm.coverage).toBe("incomplete");
    expect(c.stats().keys).toBe(2);
    now = 60000;
    c.cleanup();
    expect(c.stats().keys).toBe(0);
  });
  it("fails closed for finite TPM when dedupe capacity cannot track new events", () => {
    let now = 0;
    const c = rates.createKeyRateController({ now: () => now, maxEvents: 1 });
    c.record("k", 1, "one"); c.record("k", 1, "two");
    expect(c.status("k", {}).tpm.trackedTokens).toBe(1);
    expect(c.admit({ id: "k", tpmLimit: 100 })).toMatchObject({ allowed: false, status: 503, code: "key_rate_capacity" });
    now = 60000;
    expect(c.admit({ id: "k", tpmLimit: 100 }).allowed).toBe(true);
  });
  it("does not impose a new cap on unlimited keys when telemetry storage is full", () => {
    const c = rates.createKeyRateController({ maxKeys: 1 });
    c.admit({ id: "finite", rpmLimit: 1 });
    expect(c.admit({ id: "unlimited", rpmLimit: 0, tpmLimit: 0 }).allowed).toBe(true);
  });
  it("excludes unsupported media from TPM while retaining shared RPM", () => {
    const c = rates.createKeyRateController();
    const key = { id: "media", rpmLimit: 2, tpmLimit: 1 };
    c.record(key.id, 100, "chat-attempt");
    expect(c.admit(key).code).toBe("key_tpm_limit");
    expect(c.admit(key, { tokenBased: false }).allowed).toBe(true);
    expect(c.status(key.id, key).rpm.used).toBe(1);
  });
  it("shares the production controller across module reloads", async () => {
    const key = { id: `hmr-${Date.now()}`, rpmLimit: 1 };
    rates.admitKeyRateLimit(key);
    vi.resetModules();
    const reloaded = await import("@/sse/services/keyRateLimits.js");
    expect(reloaded.admitKeyRateLimit(key).code).toBe("key_rpm_limit");
    expect(reloaded.getKeyRateStatus(key.id, key).rpm.used).toBe(1);
  });
});
