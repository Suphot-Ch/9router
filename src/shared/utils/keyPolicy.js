import { validateKeyAccessInput } from './keyAccess.js';

export const GOVERNANCE_FIELDS = ['rpmLimit', 'tpmLimit', 'accessMode', 'accessGroupId', 'alertsEnabled', 'alertThresholds'];
export class KeyPolicyError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function resolveKeyPolicy(data = {}, current = {}) {
  const policy = {
    rpmLimit: current.rpmLimit ?? 0, tpmLimit: current.tpmLimit ?? 0,
    accessMode: current.accessMode ?? 'local', accessGroupId: current.accessGroupId ?? null,
    alertsEnabled: current.alertsEnabled ?? true, alertThresholds: current.alertThresholds ?? [80, 90, 100],
  };
  for (const field of GOVERNANCE_FIELDS) if (data[field] !== undefined) policy[field] = data[field];
  for (const field of ['rpmLimit', 'tpmLimit']) {
    if (!Number.isSafeInteger(policy[field]) || policy[field] < 0) throw new KeyPolicyError(`${field} must be a nonnegative safe integer`);
  }
  if (!['local', 'group', 'intersection'].includes(policy.accessMode)) throw new KeyPolicyError('accessMode must be local, group or intersection');
  if (policy.accessGroupId !== null && (typeof policy.accessGroupId !== 'string' || !policy.accessGroupId.trim())) throw new KeyPolicyError('accessGroupId must be a nonempty ID or null');
  if (policy.accessMode !== 'local' && !policy.accessGroupId) throw new KeyPolicyError('accessGroupId is required for group access');
  if (typeof policy.alertsEnabled !== 'boolean') throw new KeyPolicyError('alertsEnabled must be boolean');
  if (!Array.isArray(policy.alertThresholds) || !policy.alertThresholds.length || policy.alertThresholds.length > 100 || policy.alertThresholds.some(t => !Number.isInteger(t) || t < 1 || t > 100)) throw new KeyPolicyError('alertThresholds must be a nonempty integer array within 1..100');
  policy.alertThresholds = [...new Set(policy.alertThresholds)].sort((a,b) => a-b);
  if (data.access !== undefined) {
    const checked = validateKeyAccessInput(data.access);
    if (!checked.ok) throw new KeyPolicyError(checked.error);
    policy.access = checked.value;
  }
  if (policy.accessMode === 'intersection' && !(policy.access ?? current.access)?.restricted) throw new KeyPolicyError('intersection requires restricted local access');
  return policy;
}
export function keyPolicyFromRow(row) {
  let thresholds;
  try { thresholds = JSON.parse(row.alertThresholds); } catch {}
  return {
    rpmLimit: row.rpmLimit ?? 0, tpmLimit: row.tpmLimit ?? 0,
    accessMode: row.accessMode || 'local', accessGroupId: row.accessGroupId || null,
    alertsEnabled: row.alertsEnabled == null || row.alertsEnabled === 1,
    alertThresholds: Array.isArray(thresholds) ? thresholds : [80,90,100],
    budgetEpochId: row.budgetEpochId || `legacy:${row.id}`,
    alertPolicyVersion: row.alertPolicyVersion ?? 1,
    unknownCostCount: row.unknownCostCount ?? 0,
    costCoverage: row.unknownCostCount > 0 ? 'incomplete' : 'known-subtotal',
  };
}
export function saveKeyPolicy(db, id, policy) {
  db.run(`UPDATE apiKeys SET rpmLimit=?, tpmLimit=?, accessMode=?, accessGroupId=?, alertsEnabled=?, alertThresholds=? WHERE id=?`, [policy.rpmLimit,policy.tpmLimit,policy.accessMode,policy.accessGroupId,policy.alertsEnabled ? 1 : 0,JSON.stringify(policy.alertThresholds),id]);
}
