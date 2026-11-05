// Pure aggregation of retained billing events. Never reconstruct routes from policy.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function routingMetadata(value) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    const routing = parsed?.routing;
    return routing && routing.version === 1 ? routing : null;
  } catch {
    return null;
  }
}

function metric(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function accumulator() {
  return { requests: new Set(), attempts: new Set(), tokens: 0, estimatedUsd: 0, unknownCostEvents: 0 };
}

function addEvent(target, row, requestId, attemptId, costKnown) {
  target.requests.add(requestId);
  target.attempts.add(attemptId);
  target.tokens += metric(row.promptTokens) + metric(row.completionTokens);
  // Historical zero may mean missing pricing, not a free model. Only the
  // writer's explicit costKnown=true establishes that a stored zero is known.
  if (typeof row.cost === "number" && Number.isFinite(row.cost) && row.cost >= 0 && costKnown !== false && (row.cost > 0 || costKnown === true)) {
    target.estimatedUsd += row.cost;
  } else {
    target.unknownCostEvents += 1;
  }
}

function metrics(target) {
  return { requests: target.requests.size, attempts: target.attempts.size, tokens: target.tokens,
    estimatedUsd: target.estimatedUsd, unknownCostEvents: target.unknownCostEvents };
}

/** Options are validated by the repository; fixtures can call this without a DB. */
export function aggregateRoutingMap(rows, apiKeys, options = {}) {
  const { period = "7d", key: keyFilter, provider: providerFilter, routeKind, limit = 200, offset = 0 } = options;
  const secrets = new Set([...apiKeys.map((key) => key.key), ...rows.map((row) => row.apiKey)]
    .filter((key) => typeof key === "string" && key.length > 0));
  // Even display fields are untrusted: reject credentials, masked keys and emails.
  const safeText = (value) => {
    if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\x00-\x1f\x7f@*<>]/.test(value) || /\bBearer\s|\bsk[-_]/i.test(value)) return null;
    for (const secret of secrets) {
      if (value === secret || (secret.length >= 8 && value.includes(secret))) return null;
    }
    return value.trim();
  };
  const validKeyId = (value) => typeof value === "string" && SAFE_ID.test(value)
    && value !== "local" && value !== "unresolved" && safeText(value) !== null;
  const currentById = new Map(apiKeys.filter((key) => validKeyId(key.id)).map((key) => [key.id, key]));
  const currentBySecret = new Map(apiKeys.filter((key) => validKeyId(key.id)).map((key) => [key.key, key]));
  function resolveKey(row, routing) {
    if (validKeyId(routing?.keyId)) {
      const current = currentById.get(routing.keyId);
      return { id: routing.keyId, label: current ? safeText(current.name) || `Key ${routing.keyId}` : "Deleted / unresolved key" };
    }
    if (row.apiKey == null || row.apiKey === "") return { id: "local", label: "Local / No Key" };
    const current = currentBySecret.get(row.apiKey);
    if (current) return { id: current.id, label: safeText(current.name) || `Key ${current.id}` };
    // No persisted secret is created to fingerprint old credentials. Explicitly
    // combine unresolved raw keys instead of hashing or grouping masked prefixes.
    return { id: "unresolved", label: "Deleted / unresolved keys (combined)" };
  }

  const groups = new Map();
  const totals = accumulator();
  let events = 0;
  let attributedEvents = 0;
  let earliestTimestamp = null;
  let latestTimestamp = null;
  for (const [index, row] of rows.entries()) {
    const routing = routingMetadata(row.meta);
    const requested = safeText(routing?.requestedModel);
    const path = routing?.comboPath;
    const tracked = routing && typeof routing.requestId === "string" && routing.requestId.length > 0
      && typeof routing.attemptId === "string" && routing.attemptId.length > 0
      && ["direct", "combo"].includes(routing.routeKind) && requested
      && Array.isArray(path) && path.every((name) => safeText(name));
    const key = resolveKey(row, routing);
    const providerName = safeText(row.provider) || "unknown";
    const modelName = safeText(row.model) || "unknown";
    const provider = { id: providerName, label: providerName };
    const model = { id: JSON.stringify([provider.id, modelName]), label: modelName };
    const kind = tracked ? routing.routeKind : "unknown";
    const route = tracked
      ? { id: JSON.stringify([kind, requested, path]), label: requested, kind, ...(kind === "combo" ? { comboPath: [...path] } : {}) }
      : { id: "unknown", label: "Legacy / route unknown", kind: "unknown" };
    if ((keyFilter && key.id !== keyFilter) || (providerFilter && provider.id !== providerFilter) || (routeKind && kind !== routeKind)) continue;

    // Legacy rows each count as their own unknown request and provider attempt.
    const legacyId = JSON.stringify(["legacy", row.id ?? index]);
    const requestId = tracked ? JSON.stringify(["tracked", routing.requestId]) : legacyId;
    const attemptId = tracked ? JSON.stringify(["tracked", routing.requestId, routing.attemptId]) : legacyId;
    const id = JSON.stringify([key.id, route.id, provider.id, model.id]);
    if (!groups.has(id)) groups.set(id, { id, key, route, provider, model, counters: accumulator() });
    addEvent(groups.get(id).counters, row, requestId, attemptId, routing?.costKnown);
    addEvent(totals, row, requestId, attemptId, routing?.costKnown);
    events += 1;
    if (tracked) attributedEvents += 1;
    const timestamp = new Date(row.timestamp).getTime();
    if (Number.isFinite(timestamp)) {
      const iso = new Date(timestamp).toISOString();
      if (earliestTimestamp === null || iso < earliestTimestamp) earliestTimestamp = iso;
      if (latestTimestamp === null || iso > latestTimestamp) latestTimestamp = iso;
    }
  }
  const sorted = [...groups.values()].map(({ counters, ...group }) => ({ ...group, ...metrics(counters), synthetic: false }))
    .sort((a, b) => b.requests - a.requests || b.tokens - a.tokens || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const routes = sorted.slice(offset, offset + limit);
  const omittedRoutes = sorted.length - routes.length;
  return { period, routes, totals: metrics(totals), coverage: {
    source: "retained-usage-history", events, attributedEvents, legacyEvents: events - attributedEvents,
    earliestTimestamp, latestTimestamp, truncated: omittedRoutes > 0,
    totalRoutes: sorted.length, returnedRoutes: routes.length, omittedRoutes,
    note: "Filtered retained usage history only; no lifetime rollups or unrecorded failures. Requests are distinct logical IDs, not summed paths; legacy rows count separately. Missing/invalid stored costs and ambiguous historical zeros are unknown, not repriced; a free zero requires writer costKnown=true. Deleted keys without stable IDs are combined as unresolved; local/no-key calls are separate. Pagination omits routes, not filtered totals.",
  } };
}
