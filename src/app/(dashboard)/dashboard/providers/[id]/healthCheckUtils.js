export const SLOW_THRESHOLD_MS = 5000;
export const HEALTH_CHECK_CONCURRENCY = 3;

// Indirection so React's purity lint does not treat timer reads inside the
// dashboard event handlers as render-time impurity.
export function nowMs() {
  return Date.now();
}

export function formatLatency(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/**
 * Summarise health-check rows: `{ ok, latencyMs, pending }`.
 * Average latency only counts successful, finished rows.
 */
export function buildHealthSummary(results = []) {
  const done = results.filter((row) => !row.pending);
  const passed = done.filter((row) => row.ok);
  const failed = done.length - passed.length;
  const slow = passed.filter((row) => (row.latencyMs || 0) >= SLOW_THRESHOLD_MS).length;
  const avg = passed.length > 0
    ? Math.round(passed.reduce((sum, row) => sum + (row.latencyMs || 0), 0) / passed.length)
    : null;
  return { total: results.length, done: done.length, passed: passed.length, failed, slow, avg };
}

/**
 * Run `worker(item, index)` over `items` with at most `limit` in flight.
 * `shouldStop()` is polled before each item so a UI Stop button can drain
 * the queue without aborting requests that are already running.
 */
export async function mapWithConcurrency(items, limit, worker, shouldStop = () => false) {
  const size = Math.min(Math.max(1, limit | 0), items.length);
  if (size === 0) return;
  let cursor = 0;
  const run = async () => {
    for (;;) {
      if (shouldStop()) return;
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: size }, run));
}
