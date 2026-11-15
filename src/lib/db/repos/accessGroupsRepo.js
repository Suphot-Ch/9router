import { v4 as uuidv4 } from 'uuid';
import { getAdapter } from '../driver.js';
import { validateKeyAccessInput } from '@/shared/utils/keyAccess.js';
import { KeyPolicyError } from '@/shared/utils/keyPolicy.js';

const DENY = { restricted: true, allow: [] };
export function groupFromRow(row) {
  if (!row) return null;
  let access;
  try { access = JSON.parse(row.access); } catch {}
  const checked = validateKeyAccessInput(access);
  return { id: row.id, name: row.name, access: checked.ok ? checked.value : { ...DENY }, corrupt: !checked.ok,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
    memberCount: row.memberCount ?? 0 };
}
function validate(data, current = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new KeyPolicyError('body must be an object');
  const name = data.name === undefined ? current.name : data.name;
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 200) throw new KeyPolicyError('name must be 1..200 characters');
  const checked = validateKeyAccessInput(data.access === undefined ? current.access : data.access);
  if (!checked.ok) throw new KeyPolicyError(checked.error);
  return { name: name.trim(), access: checked.value };
}
export function requireAccessGroup(db, policy) {
  if (!policy.accessGroupId) return;
  const group = groupFromRow(db.get('SELECT * FROM accessGroups WHERE id=?', [policy.accessGroupId]));
  if (!group || group.corrupt) throw new KeyPolicyError('accessGroupId must reference a valid access group');
}
export async function getAccessGroups() {
  const db = await getAdapter();
  return db.all(`SELECT g.*, (SELECT COUNT(*) FROM apiKeys k WHERE k.accessGroupId=g.id) AS memberCount FROM accessGroups g ORDER BY g.createdAt, g.id`).map(groupFromRow);
}
export async function getAccessGroupById(id) {
  const db = await getAdapter();
  return groupFromRow(db.get(`SELECT g.*, (SELECT COUNT(*) FROM apiKeys k WHERE k.accessGroupId=g.id) AS memberCount FROM accessGroups g WHERE g.id=?`, [id]));
}
export async function createAccessGroup(data) {
  const value = validate(data);
  const db = await getAdapter();
  const id = uuidv4(), now = new Date().toISOString();
  db.run('INSERT INTO accessGroups(id,name,access,createdAt,updatedAt) VALUES(?,?,?,?,?)', [id,value.name,JSON.stringify(value.access),now,now]);
  return getAccessGroupById(id);
}
export async function updateAccessGroup(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const current = groupFromRow(db.get('SELECT * FROM accessGroups WHERE id=?', [id]));
    if (!current) return;
    const value = validate(data, current);
    db.run('UPDATE accessGroups SET name=?,access=?,updatedAt=? WHERE id=?', [value.name,JSON.stringify(value.access),new Date().toISOString(),id]);
    result = groupFromRow(db.get('SELECT * FROM accessGroups WHERE id=?', [id]));
  });
  return result;
}
export async function deleteAccessGroup(id) {
  const db = await getAdapter();
  let deleted = false;
  db.transaction(() => {
    if (db.get('SELECT id FROM apiKeys WHERE accessGroupId=? LIMIT 1', [id])) throw new KeyPolicyError('Access group is referenced by API keys', 409);
    deleted = (db.run('DELETE FROM accessGroups WHERE id=?',[id])?.changes ?? 0) > 0;
  });
  return deleted;
}
/** A list of request-decision policies, never a raw-string intersection. */
export async function getEffectiveKeyAccess(record) {
  const mode = record.accessMode || 'local';
  const local = record.access || { restricted: false, allow: [] };
  if (mode === 'local') return { mode, source: 'local', ...local, policies: [local] };
  if (!['group','intersection'].includes(mode)) return { mode, source: 'invalid-policy', ...DENY, policies: [DENY] };
  if (mode === 'intersection' && !local.restricted) return { mode, source: 'invalid-intersection', ...DENY, policies: [DENY] };
  const group = await getAccessGroupById(record.accessGroupId);
  if (!group || group.corrupt) return { mode, source: 'missing-or-corrupt-group', groupId: record.accessGroupId, ...DENY, policies: [DENY] };
  const policies = mode === 'intersection' ? [group.access, local] : [group.access];
  return { mode, source: mode, groupId: group.id, groupName: group.name, restricted: policies.some(p => p.restricted), policies,
    // For composite policies allow is informational only; evaluators use policies.
    allow: mode === 'group' ? group.access.allow : null };
}
