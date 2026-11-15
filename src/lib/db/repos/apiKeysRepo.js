import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { keyAccessFromColumns, keyAccessToColumns } from "@/shared/utils/keyAccess.js";
import { KEY_ACCESS_UNRESTRICTED } from "@/shared/constants/keyAccess.js";
import { resolveKeyPolicy, keyPolicyFromRow, saveKeyPolicy } from "@/shared/utils/keyPolicy.js";
import { requireAccessGroup } from "./accessGroupsRepo.js";
import { accountKeyUsage, reconcileKeyAlerts } from "./keyAlertsRepo.js";
import {
  RESET_MODES,
  DEFAULT_RESET_DAY,
  isValidResetMode,
  isValidResetDay,
  getDueResetBoundary,
} from "../keyReset.js";

// Thrown by create/update validation; routes map `.status` straight to the
// HTTP response so bad input is a 400 instead of a 500.
export class ApiKeyValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ApiKeyValidationError";
    this.status = 400;
  }
}

const num = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    // Spending limits. NULL / absent (a row created before these columns
    // existed) reads as 0 = unlimited.
    tokenLimit: row.tokenLimit != null ? num(row.tokenLimit) : 0,
    costLimit: row.costLimit != null ? num(row.costLimit) : 0,
    usedTokens: row.usedTokens != null ? num(row.usedTokens) : 0,
    usedCost: row.usedCost != null ? num(row.usedCost) : 0,
    resetMode: row.resetMode || "none",
    resetDay: row.resetDay != null ? Number(row.resetDay) : null,
    lastResetAt: row.lastResetAt || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt || null,
    access: keyAccessFromColumns(row.accessRestricted, row.accessAllow),
    ...keyPolicyFromRow(row),
  };
}

function parseLimit(value, field) {
  if (value === null || value === undefined || value === "") return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new ApiKeyValidationError(`${field} must be a finite number >= 0`);
  }
  return n;
}

function parseResetMode(value) {
  if (value === null || value === undefined || value === "") return "none";
  if (!isValidResetMode(value)) {
    throw new ApiKeyValidationError(`resetMode must be one of ${RESET_MODES.join(", ")}`);
  }
  return value;
}

function parseResetDay(resetMode, value) {
  if (resetMode === "none") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || !isValidResetDay(resetMode, n)) {
    throw new ApiKeyValidationError(
      resetMode === "monthly" ? "resetDay must be an integer 1..31 for monthly" : "resetDay must be an integer 0..6 for weekly"
    );
  }
  return n;
}

// Merge the incoming limit fields over the current row and validate them as a
// consistent set (resetDay depends on the effective resetMode).
function resolveLimitFields(data = {}, current = {}) {
  const tokenLimit = data.tokenLimit !== undefined ? parseLimit(data.tokenLimit, "tokenLimit") : num(current.tokenLimit, 0);
  const costLimit = data.costLimit !== undefined ? parseLimit(data.costLimit, "costLimit") : num(current.costLimit, 0);
  const resetMode = data.resetMode !== undefined ? parseResetMode(data.resetMode) : (current.resetMode || "none");

  let resetDay;
  if (resetMode === "none") {
    resetDay = null;
  } else if (data.resetDay !== undefined) {
    resetDay = parseResetDay(resetMode, data.resetDay);
  } else if (current.resetMode === resetMode && current.resetDay != null) {
    resetDay = parseResetDay(resetMode, current.resetDay);
  } else {
    resetDay = DEFAULT_RESET_DAY[resetMode];
  }

  return { tokenLimit, costLimit, resetMode, resetDay };
}

export async function getApiKeys() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`);
  return rows.map(rowToKey);
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return rowToKey(row);
}

// Used by the /v1 handlers to read the presented key's access settings.
export async function getApiKeyByKey(key) {
  if (!key) return null;
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE key = ?`, [key]);
  return rowToKey(row);
}

export async function createApiKey(name, machineId, options = {}) {
  if (!machineId) throw new Error("machineId is required");
  const db = await getAdapter();
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);
  const now = new Date().toISOString();
  const { tokenLimit, costLimit, resetMode, resetDay } = resolveLimitFields(options || {});
  const policy = resolveKeyPolicy(options);
  const access = policy.access || KEY_ACCESS_UNRESTRICTED;
  const apiKey = {
    id: uuidv4(),
    name,
    key: result.key,
    machineId,
    isActive: true,
    tokenLimit,
    costLimit,
    usedTokens: 0,
    usedCost: 0,
    resetMode,
    resetDay,
    // Baseline for lazy resets: the window starts when the key is created.
    lastResetAt: now,
    createdAt: now,
    updatedAt: now,
    access,
  };
  const cols = keyAccessToColumns(access);
  db.transaction(() => {
  requireAccessGroup(db, policy);
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, tokenLimit, costLimit, usedTokens, usedCost, resetMode, resetDay, lastResetAt, createdAt, updatedAt, accessRestricted, accessAllow) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      apiKey.id,
      apiKey.key,
      apiKey.name,
      apiKey.machineId,
      1,
      apiKey.tokenLimit,
      apiKey.costLimit,
      0,
      0,
      apiKey.resetMode,
      apiKey.resetDay,
      apiKey.lastResetAt,
      apiKey.createdAt,
      apiKey.updatedAt,
      cols.accessRestricted,
      cols.accessAllow,
    ]
  );
  saveKeyPolicy(db, apiKey.id, policy);
  db.run('UPDATE apiKeys SET budgetEpochId=? WHERE id=?', [uuidv4(), apiKey.id]);
  });
  return rowToKey(db.get(`SELECT * FROM apiKeys WHERE id = ?`, [apiKey.id]));
}

export async function updateApiKey(id, data = {}) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const current = rowToKey(row);
    const policy = resolveKeyPolicy(data, current);
    if (data.accessGroupId !== undefined || data.accessMode !== undefined) requireAccessGroup(db, policy);
    const merged = { ...current, ...data };
    const { tokenLimit, costLimit, resetMode, resetDay } = resolveLimitFields(data, current);
    const cols = keyAccessToColumns(policy.access || merged.access || KEY_ACCESS_UNRESTRICTED);
    const updatedAt = new Date().toISOString();
    db.run(
      `UPDATE apiKeys SET key = ?, name = ?, machineId = ?, isActive = ?, tokenLimit = ?, costLimit = ?, resetMode = ?, resetDay = ?, updatedAt = ?, accessRestricted = ?, accessAllow = ? WHERE id = ?`,
      [
        merged.key,
        merged.name,
        merged.machineId,
        merged.isActive ? 1 : 0,
        tokenLimit,
        costLimit,
        resetMode,
        resetDay,
        updatedAt,
        cols.accessRestricted,
        cols.accessAllow,
        id,
      ]
    );
    saveKeyPolicy(db, id, policy);
    if (policy.alertsEnabled !== current.alertsEnabled || JSON.stringify(policy.alertThresholds) !== JSON.stringify(current.alertThresholds)) {
      db.run('UPDATE apiKeys SET alertPolicyVersion=COALESCE(alertPolicyVersion,1)+1 WHERE id=?', [id]);
    }
    reconcileKeyAlerts(db, db.get('SELECT * FROM apiKeys WHERE id=?', [id]));
    result = rowToKey(db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]));
  });
  return result;
}

/**
 * Zero a key's counters. `lastResetAt` defaults to now (manual reset); the lazy
 * reset path stamps the boundary that was actually crossed.
 */
export async function resetApiKeyUsage(id, options = {}) {
  if (!id) return null;
  const db = await getAdapter();
  const now = new Date().toISOString();
  const lastResetAt = options.lastResetAt || now;
  db.transaction(() => {
  db.run(
    `UPDATE apiKeys SET usedTokens = 0, usedCost = 0, unknownCostCount = 0, budgetEpochId = ?, lastResetAt = ?, updatedAt = ? WHERE id = ?`,
    [uuidv4(), lastResetAt, now, id]
  );
  });
  return rowToKey(db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]));
}

/**
 * Account tokens + cost against a key in ONE atomic UPDATE. A no-op when there
 * is nothing to add or the key is unknown (usage rows can outlive a deleted key).
 * @param {string} key - the raw API key value
 * @param {{tokens?: number, cost?: number}} usage
 */
export async function addApiKeyUsage(key, { tokens = 0, cost = 0, costKnown = true } = {}) {
  if (!key || typeof key !== "string") return;
  const t = Number(tokens) || 0;
  const c = Number(cost) || 0;
  if (!Number.isFinite(t) || !Number.isFinite(c)) return;
  if (t <= 0 && c <= 0 && costKnown !== false) return;
  const db = await getAdapter();
  db.transaction(() => accountKeyUsage(db, key, { tokens: t, cost: c, costKnown }));
}

/**
 * Apply a due lazy reset (if any) and return the fresh record. Called by the
 * quota gate and safe to call on every request: when no boundary has passed
 * this is a pure read.
 */
export async function applyDueKeyReset(keyRecord, now = Date.now()) {
  if (!keyRecord) return keyRecord;
  const db = await getAdapter();
  let current;
  db.transaction(() => {
    current = rowToKey(db.get('SELECT * FROM apiKeys WHERE id=?', [keyRecord.id]));
    if (!current) return;
    const boundary = getDueResetBoundary(current, now);
    if (!boundary) return;
    db.run('UPDATE apiKeys SET usedTokens=0,usedCost=0,unknownCostCount=0,budgetEpochId=?,lastResetAt=?,updatedAt=? WHERE id=?', [uuidv4(),boundary,new Date().toISOString(),current.id]);
    current = rowToKey(db.get('SELECT * FROM apiKeys WHERE id=?', [current.id]));
  });
  return current || keyRecord;
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

export async function validateApiKey(key) {
  const db = await getAdapter();
  const row = db.get(`SELECT isActive FROM apiKeys WHERE key = ?`, [key]);
  if (!row) return false;
  return row.isActive === 1 || row.isActive === true;
}
