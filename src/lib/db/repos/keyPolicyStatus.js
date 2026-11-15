import { getEffectiveKeyAccess } from './accessGroupsRepo.js';
import { getKeyRateStatus } from '@/sse/services/keyRateLimits.js';

export async function withKeyPolicyStatus(key) {
  if (!key) return key;
  return { ...key, effectiveAccess: await getEffectiveKeyAccess(key), rateStatus: getKeyRateStatus(key.id, key) };
}
export const KEY_EDIT_FIELDS = ['name','isActive','access','tokenLimit','costLimit','resetMode','resetDay','rpmLimit','tpmLimit','accessMode','accessGroupId','alertsEnabled','alertThresholds'];
export function keyEditFields(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('body must be an object'),{status:400});
  if (body.isActive !== undefined && typeof body.isActive !== 'boolean') throw Object.assign(new Error('isActive must be boolean'),{status:400});
  if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 200)) throw Object.assign(new Error('name must be 1..200 characters'),{status:400});
  if (body.resetUsage !== undefined && typeof body.resetUsage !== 'boolean') throw Object.assign(new Error('resetUsage must be boolean'),{status:400});
  return Object.fromEntries(KEY_EDIT_FIELDS.filter(f => body[f] !== undefined).map(f=>[f,body[f]]));
}
