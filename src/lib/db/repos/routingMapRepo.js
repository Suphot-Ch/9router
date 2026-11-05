import { getAdapter } from "../driver.js";
import { aggregateRoutingMap } from "../routingMapAggregation.js";

const PERIODS = new Set(["today", "24h", "7d", "30d", "60d", "all"]);
const PARAMETERS = new Set(["period", "key", "provider", "routeKind", "limit", "offset"]);
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+~-]{0,255}$/;

export class RoutingMapValidationError extends Error {}

function invalid(field) {
  throw new RoutingMapValidationError(`Invalid ${field}`);
}

export function parseRoutingMapQuery(searchParams) {
  const values = {};
  for (const [field, value] of searchParams) {
    if (!PARAMETERS.has(field) || Object.hasOwn(values, field)) invalid("query parameters");
    values[field] = value;
  }
  const period = values.period ?? "7d";
  if (!PERIODS.has(period)) invalid("period");
  if (values.key !== undefined && (!KEY_ID.test(values.key) || /\bsk[-_]/i.test(values.key))) invalid("key");
  if (values.provider !== undefined && !PROVIDER_ID.test(values.provider)) invalid("provider");
  if (values.routeKind !== undefined && !["direct", "combo", "unknown"].includes(values.routeKind)) invalid("routeKind");
  const integer = (field, fallback, min, max) => {
    if (values[field] === undefined) return fallback;
    if (!/^\d+$/.test(values[field])) invalid(field);
    const value = Number(values[field]);
    if (!Number.isSafeInteger(value) || value < min || value > max) invalid(field);
    return value;
  };
  return { period, ...(values.key !== undefined ? { key: values.key } : {}),
    ...(values.provider !== undefined ? { provider: values.provider } : {}),
    ...(values.routeKind !== undefined ? { routeKind: values.routeKind } : {}),
    limit: integer("limit", 200, 1, 1000), offset: integer("offset", 0, 0, Number.MAX_SAFE_INTEGER) };
}

// Calendar days use the server-local timezone, just like the Usage page.
// setDate (rather than subtracting milliseconds) preserves DST boundaries.
export function routingMapTimeBounds(period, now = Date.now()) {
  if (!PERIODS.has(period)) invalid("period");
  if (period === "all") return { start: null, end: null };
  const end = new Date(now).toISOString();
  if (period === "24h") return { start: new Date(now - 86400000).toISOString(), end };
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (period !== "today") start.setDate(start.getDate() - (Number.parseInt(period, 10) - 1));
  return { start: start.toISOString(), end };
}

export async function getRoutingMap(options = {}) {
  // Keep validation at the repository boundary as well as the HTTP boundary.
  const validated = parseRoutingMapQuery(new URLSearchParams(Object.entries(options).map(([key, value]) => [key, String(value)])));
  const { start, end } = routingMapTimeBounds(validated.period);
  const db = await getAdapter();
  // No hidden event limit: pagination applies only after filtered aggregation.
  // Raw keys remain server-side solely for an exact current-key lookup.
  const rows = db.all(`SELECT id, timestamp, provider, model, apiKey, promptTokens, completionTokens, cost, meta
    FROM usageHistory${start ? " WHERE timestamp >= ? AND timestamp <= ?" : ""} ORDER BY id ASC`, start ? [start, end] : []);
  const apiKeys = db.all("SELECT id, key, name FROM apiKeys");
  return aggregateRoutingMap(rows, apiKeys, validated);
}
