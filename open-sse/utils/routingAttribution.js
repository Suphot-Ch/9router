import { randomUUID } from "node:crypto";

// This context belongs to the router, never to body.metadata or client headers.
// Copy on each branch/attempt; frozen paths cannot be mutated by sibling routes.
function freezeAttribution(value) {
  return Object.freeze({
    version: 1,
    requestId: value.requestId,
    attemptId: value.attemptId,
    keyId: typeof value.keyId === "string" ? value.keyId : null,
    requestedModel: value.requestedModel,
    routeKind: value.routeKind,
    comboPath: Object.freeze([...value.comboPath]),
  });
}

export function createRoutingAttribution(requestedModel, keyId = null) {
  return freezeAttribution({
    requestId: randomUUID(), attemptId: null, keyId, requestedModel,
    routeKind: "direct", comboPath: [],
  });
}

export function withRoutingAttribution(clientRawRequest, attribution) {
  const raw = { ...clientRawRequest };
  // Non-enumerable so raw-request logging / JSON serialization cannot include it.
  Object.defineProperty(raw, "routingAttribution", {
    value: freezeAttribution(attribution), enumerable: false, writable: false, configurable: false,
  });
  return raw;
}

export function withRoutingAttempt(clientRawRequest) {
  return withRoutingAttribution(clientRawRequest, {
    ...clientRawRequest.routingAttribution, attemptId: randomUUID(),
  });
}

export function withComboRouting(clientRawRequest, comboName) {
  const attribution = clientRawRequest.routingAttribution;
  return withRoutingAttribution(clientRawRequest, {
    ...attribution, routeKind: "combo", comboPath: [...attribution.comboPath, comboName],
  });
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Validate at the persistence boundary and project only allowed fields. Optional
// writer-owned fields (such as costKnown) must never be accepted from callers.
export function sanitizeRoutingAttribution(value) {
  if (!value || value.version !== 1
    || typeof value.requestId !== "string" || !UUID_V4.test(value.requestId)
    || typeof value.attemptId !== "string" || !UUID_V4.test(value.attemptId)
    || typeof value.requestedModel !== "string" || !value.requestedModel
    || !(value.keyId == null || (typeof value.keyId === "string" && value.keyId.length > 0))
    || !["direct", "combo"].includes(value.routeKind)
    || !Array.isArray(value.comboPath)
    || !Array.from(value.comboPath).every(name => typeof name === "string" && name.length > 0)
    || (value.routeKind === "direct" ? value.comboPath.length !== 0 : value.comboPath.length === 0)) return null;
  return freezeAttribution(value);
}
