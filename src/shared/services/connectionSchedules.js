// Connection schedules: apply the weekly enable/disable window of every account.
//
// The pure math lives in ./connectionSchedule.js; this module only reads the
// stored schedules, compares the desired `isActive` with the stored one and
// writes when they differ. It never re-enables an account whose schedule is
// switched off, so removing a schedule hands control back to the user.
import { getProviderConnections, updateProviderConnection } from "@/lib/localDb";
import { CONNECTION_SCHEDULE_CONFIG } from "@/shared/constants/config";
import { evaluateConnectionSchedule, normalizeConnectionSchedule } from "@/shared/services/connectionSchedule";

const C = CONNECTION_SCHEDULE_CONFIG;
const LOG = "[ConnSchedule]";

// Survive Next.js hot reload and keep one scheduler per server process.
const g = (global.__connectionSchedules ??= {
  interval: null,
  running: false,
  failures: new Map(),
});

function createDefaultDeps() {
  return { getProviderConnections, updateProviderConnection };
}

// Log a failure once per distinct message; a repeating upstream/DB error must not
// flood the console every 60s.
function reportFailure(state, key, error) {
  const message = error?.message || String(error);
  if (state.failures.get(key) === message) return;
  state.failures.set(key, message);
  console.warn(`${LOG} ${key}: ${message}`);
}

async function applyScheduleToConnection(connection, deps, nowMs) {
  const schedule = normalizeConnectionSchedule(connection.schedule);
  if (!schedule) return { applied: false };

  const evaluation = evaluateConnectionSchedule(schedule, nowMs);
  if (!evaluation) return { applied: false };

  const desiredActive = evaluation.active;
  // Writing the same value every tick would churn updatedAt and defeat the
  // rotation order, so an already-correct row is left alone.
  if (connection.isActive === desiredActive) return { applied: false, active: desiredActive };

  await deps.updateProviderConnection(connection.id, {
    isActive: desiredActive,
    schedule: {
      ...schedule,
      lastAppliedState: desiredActive ? "active" : "disabled",
      lastAppliedAt: new Date(nowMs).toISOString(),
    },
  });
  console.log(`${LOG} ${connection.id}: ${desiredActive ? "enabled" : "disabled"} by schedule`);
  return { applied: true, active: desiredActive };
}

// One pass over the stored connections. Throws only for a failure of the initial
// read; a single broken row is counted and logged instead of aborting the pass.
export async function applyConnectionSchedules(deps = createDefaultDeps(), nowMs = Date.now(), state = g) {
  const connections = await deps.getProviderConnections();
  const targets = connections.filter((connection) => normalizeConnectionSchedule(connection.schedule) !== null);

  // Cheap early exit: no account opted in, so no evaluation and no writes.
  if (targets.length === 0) {
    return { checked: connections.length, targets: 0, applied: 0 };
  }

  let applied = 0;
  for (const connection of targets) {
    try {
      const result = await applyScheduleToConnection(connection, deps, nowMs);
      if (result.applied) applied += 1;
      state.failures.delete(connection.id);
    } catch (error) {
      reportFailure(state, connection.id, error);
    }
  }

  return { checked: connections.length, targets: targets.length, applied };
}

// Interval body. Guarded against overlap and never throws.
export async function runConnectionScheduleTick(deps = createDefaultDeps(), nowMs = Date.now(), state = g) {
  if (state.running) return { skipped: true, reason: "running" };

  state.running = true;
  try {
    const report = await applyConnectionSchedules(deps, nowMs, state);
    // Nothing left to automate → stop waking up every minute. Saving a schedule
    // starts the scheduler again through the API route.
    if (report.targets === 0) stopConnectionSchedules(state);
    return report;
  } catch (error) {
    reportFailure(state, "tick", error);
    return { skipped: true, reason: "error" };
  } finally {
    state.running = false;
  }
}

export function startConnectionSchedules({ deps = createDefaultDeps(), state = g } = {}) {
  if (state.interval) return;
  state.interval = setInterval(() => {
    runConnectionScheduleTick(deps, Date.now(), state).catch(() => {});
  }, C.tickIntervalMs);
  if (state.interval.unref) state.interval.unref();
  console.log(`${LOG} scheduler started`);
  runConnectionScheduleTick(deps, Date.now(), state).catch(() => {});
}

export function stopConnectionSchedules(state = g) {
  if (!state.interval) return;
  clearInterval(state.interval);
  state.interval = null;
  console.log(`${LOG} scheduler stopped`);
}
