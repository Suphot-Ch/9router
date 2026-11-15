// No secrets, reservations or durable state. One controller per JS process,
// shared by HMR/route bundles via globalThis. Replicas require a shared limiter.
const WINDOW_MS = 60_000;
const GLOBAL_KEY = Symbol.for("9router.keyRateLimits.v1");
const validCount = n => Number.isSafeInteger(n) && n >= 0;
const cap = n => validCount(n) ? n : 0;

export function createKeyRateController({ now = Date.now, maxKeys = 1024, maxBuckets = 4096, maxEvents = 8192 } = {}) {
  const startedAt = now();
  const states = new Map();
  function prune(s, time) {
    s.buckets = s.buckets.filter(b => b.time > time - WINDOW_MS);
    for (const [id, timeSeen] of s.events) if (timeSeen <= time - WINDOW_MS) s.events.delete(id);
  }
  function cleanup() {
    const time = now();
    for (const [id, s] of states) {
      prune(s, time);
      if (!s.buckets.length && s.inFlight === 0) states.delete(id);
    }
  }
  function state(id, create = false) {
    const time = now();
    let s = states.get(id);
    if (s) prune(s, time);
    if (!s && create) {
      cleanup();
      if (states.size >= maxKeys) return null;
      s = { buckets: [], events: new Map(), inFlight: 0 };
      states.set(id, s);
    }
    return s;
  }
  function bucket(s) {
    const time = now();
    let b = s.buckets.at(-1);
    if (b?.time === time) return b;
    if (s.buckets.length >= maxBuckets) return null;
    b = { time, rpm: 0, tokens: 0, actual: 0, unknown: 0, unsupported: 0, tokenRequests: 0 };
    s.buckets.push(b);
    return b;
  }
  const sum = (s, field) => s?.buckets.reduce((total, b) => total + b[field], 0) || 0;
  function denial(code, resetAt, status = 429) {
    const retryAfter = Math.max(1, Math.ceil((resetAt - now()) / 1000));
    return { allowed: false, status, code, error: code === "key_rpm_limit" ? "API key RPM limit exceeded" : code === "key_tpm_limit" ? "API key soft TPM limit exceeded" : "API key rate controller capacity exceeded", retryAfter, resetAt,
      headers: { "Retry-After": String(retryAfter), "X-Key-Rate-Reset": new Date(resetAt).toISOString() } };
  }
  function admit(key, { tokenBased = true } = {}) {
    const keyId = key?.id;
    if (!keyId) return { allowed: true, finish() {} };
    const finite = cap(key.rpmLimit) > 0 || cap(key.tpmLimit) > 0;
    const s = state(keyId, true);
    if (!s) return finite ? denial("key_rate_capacity", now() + WINDOW_MS, 503) : { allowed: true, finish() {} };
    if (tokenBased && cap(key.tpmLimit) && s.saturatedUntil > now()) return denial("key_rate_capacity", s.saturatedUntil, 503);
    const rpm = sum(s, "rpm");
    if (cap(key.rpmLimit) && rpm >= key.rpmLimit) {
      let remaining = rpm;
      const reset = s.buckets.find(b => { remaining -= b.rpm; return remaining < key.rpmLimit; });
      return denial("key_rpm_limit", reset.time + WINDOW_MS);
    }
    const tokens = sum(s, "tokens");
    if (tokenBased && cap(key.tpmLimit) && tokens >= key.tpmLimit) {
      let remaining = tokens;
      const reset = s.buckets.find(b => { remaining -= b.tokens; return remaining < key.tpmLimit; });
      return denial("key_tpm_limit", reset.time + WINDOW_MS);
    }
    const b = bucket(s);
    if (!b) return finite ? denial("key_rate_capacity", s.buckets[0].time + WINDOW_MS, 503) : { allowed: true, finish() {} };
    b.rpm++;
    if (!tokenBased) b.unsupported++;
    else b.tokenRequests++;
    s.inFlight++;
    let finished = false;
    return { allowed: true, keyId, finish({ unknown = false } = {}) {
      if (finished) return;
      finished = true;
      s.inFlight = Math.max(0, s.inFlight - 1);
      // No secret-bearing policy record is retained by this closure.
      if (unknown && tokenBased) { const warning = bucket(s) || s.buckets.at(-1); if (warning) warning.unknown++; }
    } };
  }
  function record(keyId, tokens, eventId, options = {}) {
    if (typeof keyId !== "string" || !keyId || keyId.length > 256) return false;
    const s = state(keyId, true);
    if (!s) return false;
    const id = eventId == null ? null : String(eventId);
    if (id && s.events.has(id)) return false;
    // Saturation never evicts live dedupe IDs and silently double-counts.
    const saturated = !id || id.length > 256 || s.events.size >= maxEvents;
    if (!saturated) s.events.set(id, now());
    else s.saturatedUntil = now() + WINDOW_MS;
    let b = bucket(s);
    if (!b) { b = s.buckets.at(-1); b.time = now(); b.unknown++; }
    let count = null;
    if (!options.estimated && !options.unknown && !tokens?.estimated) {
      if (validCount(tokens)) count = tokens;
      else if (tokens && typeof tokens === "object") {
        const prompt = tokens.prompt_tokens ?? tokens.input_tokens;
        const completion = tokens.completion_tokens ?? tokens.output_tokens;
        if (validCount(prompt) && validCount(completion) && validCount(prompt + completion)) count = prompt + completion;
      }
    }
    if (count === null || saturated) b.unknown++;
    else { b.tokens += count; b.actual++; }
    return !saturated;
  }
  function status(keyId, policy = {}) {
    const s = state(keyId);
    const actual = sum(s, "actual"), unknown = sum(s, "unknown"), unsupported = sum(s, "unsupported");
    const tracked = sum(s, "tokens"), used = sum(s, "rpm");
    return {
      windowSeconds: 60, scope: "single-process", soft: true,
      warmingUp: now() - startedAt < WINDOW_MS, startedAt: new Date(startedAt).toISOString(),
      restartContinuity: false, concurrencyBounded: false, outputBounded: false, overshootBounded: false,
      limitation: "Single process only; restart loses minute history. In-flight and missing usage can overshoot without a bound; no concurrency or output caps are enforced.",
      inFlight: s?.inFlight || 0,
      capacityWarning: (s?.saturatedUntil || 0) > now(),
      coverageNote: "Usage events are not correlated to logical requests; complete per-request coverage cannot be proven, even when actual token totals are observed.",
      rpm: { used, limit: cap(policy.rpmLimit), remaining: cap(policy.rpmLimit) ? Math.max(0, policy.rpmLimit - used) : null },
      tpm: { used: actual ? tracked : null, trackedTokens: tracked, limit: cap(policy.tpmLimit), remaining: actual && cap(policy.tpmLimit) ? Math.max(0, policy.tpmLimit - tracked) : null,
        coverage: unknown || sum(s, "tokenRequests") > 0 ? "incomplete" : actual ? "observed" : unsupported ? "not_applicable" : "unknown", unknownEvents: unknown, unsupportedRequests: unsupported },
      resetAt: s?.buckets.length ? new Date(s.buckets[0].time + WINDOW_MS).toISOString() : null,
    };
  }
  return { admit, record, status, cleanup, stats: () => ({ keys: states.size }) };
}

function shared() {
  if (!globalThis[GLOBAL_KEY]) {
    const controller = createKeyRateController();
    const timer = setInterval(() => controller.cleanup(), 60_000);
    timer.unref?.();
    globalThis[GLOBAL_KEY] = { controller, requests: new WeakMap() };
  }
  return globalThis[GLOBAL_KEY];
}
export function admitKeyRateLimit(key, options = {}) { return shared().controller.admit(key, options); }
export function recordKeyTokenUsage(keyId, tokens, eventId, options = {}) { return shared().controller.record(keyId, tokens, eventId, options); }
export function getKeyRateStatus(keyId, policy = {}) {
  return { ...shared().controller.status(keyId, policy), deploymentConfigured: process.env.KEY_RATE_LIMIT_MODE === "single-process" };
}

// The request object is server-created, not a client-provided idempotency key.
export function attachKeyRateAdmission(request, admission) { if (request && admission.allowed) shared().requests.set(request, admission); }
export async function withKeyRateLifecycle(request, handler) {
  let response;
  try { response = await handler(); }
  catch (error) { shared().requests.get(request)?.finish(); shared().requests.delete(request); throw error; }
  const admission = shared().requests.get(request);
  shared().requests.delete(request);
  if (!admission) return response;
  if (!response?.body || response.status >= 400) { admission.finish({ unknown: response?.status >= 400 }); return response; }
  const reader = response.body.getReader();
  // Pull-based: do not eagerly drain/buffer an admitted stream. Never re-check
  // caps midstream, including after policy changes or new usage arrives.
  const body = new ReadableStream({
    async pull(controller) {
      try { const result = await reader.read(); if (result.done) { admission.finish(); controller.close(); } else controller.enqueue(result.value); }
      catch (error) { admission.finish({ unknown: true }); controller.error(error); }
    },
    async cancel(reason) { admission.finish({ unknown: true }); await reader.cancel(reason); },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
