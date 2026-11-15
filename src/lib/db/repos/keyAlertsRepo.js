import { v4 as uuidv4 } from 'uuid';
import { getAdapter } from '../driver.js';
import { keyPolicyFromRow, KeyPolicyError } from '@/shared/utils/keyPolicy.js';

function alertFromRow(row) {
  if (!row) return null;
  const { id,keyId,metric,threshold,used,limitValue,period,policyVersion,createdAt,acknowledgedAt,unknownCostCount } = row;
  return { id,keyId,metric,threshold,used,limit:limitValue,period,policyVersion,createdAt,acknowledgedAt,unknownCostCount,
    costCoverage: unknownCostCount > 0 ? 'incomplete' : 'known-subtotal', deliveryState:'inbox' };
}
/** Synchronous: callers include this in the canonical accounting transaction. */
export function reconcileKeyAlerts(db, row) {
  if (!row) return;
  const policy = keyPolicyFromRow(row);
  if (!policy.alertsEnabled) return;
  const now = new Date().toISOString();
  for (const [metric,used,limit] of [['tokens',row.usedTokens,row.tokenLimit],['cost',row.usedCost,row.costLimit]]) {
    if (!(limit > 0) || !(used >= 0)) continue;
    for (const threshold of policy.alertThresholds) {
      if (!Number.isInteger(threshold) || threshold < 1 || threshold > 100 || used / limit * 100 < threshold) continue;
      const id = uuidv4();
      const saved = db.run(`INSERT OR IGNORE INTO keyAlertEvents(id,keyId,metric,threshold,used,limitValue,period,policyVersion,createdAt,unknownCostCount) VALUES(?,?,?,?,?,?,?,?,?,?)`, [id,row.id,metric,threshold,used,limit,policy.budgetEpochId,policy.alertPolicyVersion,now,policy.unknownCostCount]);
      if ((saved?.changes ?? 0) > 0) db.run(`INSERT INTO keyAlertOutbox(id,eventId,state,createdAt) VALUES(?,?,?,?)`, [id,id,'inbox',now]);
    }
  }
}
/** Update budget + unknown pricing coverage + inbox as one transaction. */
export function accountKeyUsage(db, key, { tokens = 0, cost = 0, costKnown = true } = {}) {
  if (typeof key !== 'string' || !key) return null;
  const row = db.get('SELECT * FROM apiKeys WHERE key=?',[key]);
  if (!row) return null;
  const t = Number.isFinite(tokens) && tokens > 0 ? tokens : 0;
  const c = Number.isFinite(cost) && cost > 0 ? cost : 0;
  db.run(`UPDATE apiKeys SET usedTokens=COALESCE(usedTokens,0)+?,usedCost=COALESCE(usedCost,0)+?,unknownCostCount=COALESCE(unknownCostCount,0)+?,updatedAt=? WHERE id=?`, [t,c,costKnown === false ? 1 : 0,new Date().toISOString(),row.id]);
  reconcileKeyAlerts(db,db.get('SELECT * FROM apiKeys WHERE id=?',[row.id]));
  return row.id;
}
export async function getKeyAlerts({ keyId, limit = 100 } = {}) {
  const n = typeof limit === 'string' && /^\d+$/.test(limit) ? Number(limit) : limit;
  if (!Number.isInteger(n) || n < 1 || n > 500) throw new KeyPolicyError('limit must be an integer 1..500');
  const db = await getAdapter();
  db.transaction(() => { for (const row of db.all('SELECT * FROM apiKeys')) reconcileKeyAlerts(db,row); });
  return db.all(`SELECT * FROM keyAlertEvents ${keyId ? 'WHERE keyId=?' : ''} ORDER BY createdAt DESC, id DESC LIMIT ?`, keyId ? [keyId,n] : [n]).map(alertFromRow);
}
export async function acknowledgeKeyAlert(id) {
  const db = await getAdapter();
  db.run('UPDATE keyAlertEvents SET acknowledgedAt=COALESCE(acknowledgedAt,?) WHERE id=?',[new Date().toISOString(),id]);
  return alertFromRow(db.get('SELECT * FROM keyAlertEvents WHERE id=?',[id]));
}
