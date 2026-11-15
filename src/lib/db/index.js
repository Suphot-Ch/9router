// Public API barrel — all DB functions
import { getAdapter } from "./driver.js";
import { stringifyJson, parseJson } from "./helpers/jsonCol.js";
import { keyAccessFromColumns, keyAccessToColumns, validateKeyAccessInput } from "@/shared/utils/keyAccess.js";
import { KEY_ACCESS_UNRESTRICTED } from "@/shared/constants/keyAccess.js";
import { resolveKeyPolicy, saveKeyPolicy } from '@/shared/utils/keyPolicy.js';
import { getApiKeys } from './repos/apiKeysRepo.js';
import { requireAccessGroup } from './repos/accessGroupsRepo.js';
import { normalizeComboContextLength, normalizeComboMaxOutputTokens } from '@/shared/utils/comboContext.js';

// Settings
export {
  getSettings, updateSettings, isCloudEnabled, getCloudUrl, exportSettings,
} from "./repos/settingsRepo.js";

// Provider connections
export {
  getProviderConnections, getProviderConnectionById,
  createProviderConnection, updateProviderConnection,
  deleteProviderConnection, deleteProviderConnectionsByProvider,
  reorderProviderConnections, cleanupProviderConnections,
} from "./repos/connectionsRepo.js";

// Provider nodes
export {
  getProviderNodes, getProviderNodeById,
  createProviderNode, updateProviderNode, deleteProviderNode,
} from "./repos/nodesRepo.js";

// Proxy pools
export {
  getProxyPools, getProxyPoolById,
  createProxyPool, updateProxyPool, deleteProxyPool,
} from "./repos/proxyPoolsRepo.js";

// API keys
export {
  getApiKeys, getApiKeyById, getApiKeyByKey, createApiKey, updateApiKey, deleteApiKey, validateApiKey,
  addApiKeyUsage, resetApiKeyUsage, applyDueKeyReset, ApiKeyValidationError,
} from "./repos/apiKeysRepo.js";

// Governance
export { getAccessGroups, getAccessGroupById, createAccessGroup, updateAccessGroup, deleteAccessGroup, getEffectiveKeyAccess } from './repos/accessGroupsRepo.js';
export { getKeyAlerts, acknowledgeKeyAlert } from './repos/keyAlertsRepo.js';

// Combos
export {
  getCombos, getComboById, getComboByName,
  createCombo, updateCombo, deleteCombo,
} from "./repos/combosRepo.js";

// Aliases (model + custom + mitm)
export {
  getModelAliases, setModelAlias, deleteModelAlias,
  getCustomModels, addCustomModel, deleteCustomModel,
  getMitmAlias, setMitmAliasAll,
} from "./repos/aliasRepo.js";

// Pricing
export {
  getPricing, getPricingForModel, updatePricing, resetPricing, resetAllPricing,
} from "./repos/pricingRepo.js";

// Disabled models
export {
  getDisabledModels, getDisabledByProvider, disableModels, enableModels,
} from "./repos/disabledModelsRepo.js";

// Usage
export {
  statsEmitter, trackPendingRequest, getActiveRequests,
  saveRequestUsage, getUsageHistory, getUsageStats, getChartData,
  appendRequestLog, getRecentLogs,
} from "./repos/usageRepo.js";

// Request details
export {
  saveRequestDetail, getRequestDetails, getRequestDetailById, getDistinctProviders,
} from "./repos/requestDetailsRepo.js";

// Export/import full DB
export async function exportDb() {
  const db = await getAdapter();
  const { exportSettings } = await import("./repos/settingsRepo.js");

  const out = {
    settings: await exportSettings(),
    providerConnections: db.all(`SELECT * FROM providerConnections`).map((r) => ({ ...parseJson(r.data, {}), id: r.id, provider: r.provider, authType: r.authType, name: r.name, email: r.email, priority: r.priority, isActive: r.isActive === 1, createdAt: r.createdAt, updatedAt: r.updatedAt })),
    providerNodes: db.all(`SELECT * FROM providerNodes`).map((r) => ({ ...parseJson(r.data, {}), id: r.id, type: r.type, name: r.name, createdAt: r.createdAt, updatedAt: r.updatedAt })),
    proxyPools: db.all(`SELECT * FROM proxyPools`).map((r) => ({ ...parseJson(r.data, {}), id: r.id, isActive: r.isActive === 1, testStatus: r.testStatus, createdAt: r.createdAt, updatedAt: r.updatedAt })),
    apiKeys: await getApiKeys(),
    accessGroups: db.all('SELECT * FROM accessGroups'),
    keyAlertEvents: db.all('SELECT * FROM keyAlertEvents'),
    keyAlertOutbox: db.all('SELECT * FROM keyAlertOutbox'),
    combos: db.all(`SELECT * FROM combos`).map((r) => ({ id: r.id, name: r.name, kind: r.kind, contextLength: r.contextLength ?? null, maxOutputTokens: r.maxOutputTokens ?? null, models: parseJson(r.models, []), createdAt: r.createdAt, updatedAt: r.updatedAt })),
    modelAliases: {},
    customModels: [],
    mitmAlias: {},
    pricing: {},
  };

  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'modelAliases'`)) out.modelAliases[r.key] = parseJson(r.value);
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'customModels'`)) out.customModels.push(parseJson(r.value));
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'mitmAlias'`)) out.mitmAlias[r.key] = parseJson(r.value);
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'pricing'`)) out.pricing[r.key] = parseJson(r.value);

  return out;
}

export async function importDb(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid database payload");
  }
  const db = await getAdapter();

  db.transaction(() => {
    // Wipe all tables (keep _meta)
    db.run(`DELETE FROM settings`);
    db.run(`DELETE FROM providerConnections`);
    db.run(`DELETE FROM providerNodes`);
    db.run(`DELETE FROM proxyPools`);
    db.run(`DELETE FROM apiKeys`);
    db.run('DELETE FROM accessGroups');
    db.run('DELETE FROM keyAlertEvents');
    db.run('DELETE FROM keyAlertOutbox');
    db.run(`DELETE FROM combos`);
    db.run(`DELETE FROM kv WHERE scope IN ('modelAliases', 'customModels', 'mitmAlias', 'pricing')`);

    // Settings
    if (payload.settings) {
      db.run(`INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`, [stringifyJson(payload.settings)]);
    }

    for (const c of payload.providerConnections || []) {
      const { id, provider, authType, name, email, priority, isActive, createdAt, updatedAt, ...rest } = c;
      db.run(
        `INSERT OR REPLACE INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, provider, authType || "oauth", name || null, email || null, priority || null, isActive === false ? 0 : 1, stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
      );
    }
    for (const n of payload.providerNodes || []) {
      const { id, type, name, createdAt, updatedAt, ...rest } = n;
      db.run(
        `INSERT OR REPLACE INTO providerNodes(id, type, name, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [id, type || null, name || null, stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
      );
    }
    for (const p of payload.proxyPools || []) {
      const { id, isActive, testStatus, createdAt, updatedAt, ...rest } = p;
      db.run(
        `INSERT OR REPLACE INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [id, isActive === false ? 0 : 1, testStatus || "unknown", stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
      );
    }
    for (const g of payload.accessGroups || []) {
      let access;
      try { access = typeof g.access === 'string' ? JSON.parse(g.access) : g.access; } catch { throw new Error('Invalid group access'); }
      const checked = validateKeyAccessInput(access);
      if (!checked.ok || typeof g.name !== 'string' || !g.name.trim()) throw new Error('Invalid group');
      db.run('INSERT INTO accessGroups(id,name,access,createdAt,updatedAt) VALUES(?,?,?,?,?)', [g.id,g.name,stringifyJson(checked.value),g.createdAt || new Date().toISOString(),g.updatedAt || new Date().toISOString()]);
    }
    for (const k of payload.apiKeys || []) {
      // Per-key access: a backup without `access` (older version) restores
      // unrestricted, exactly as before; a malformed `access` is refused.
      let access = KEY_ACCESS_UNRESTRICTED;
      if (k.access !== undefined) {
        const checked = validateKeyAccessInput(k.access);
        if (!checked.ok) throw new Error(`apiKeys ${k.id}: ${checked.error}`);
        access = checked.value;
      }
      const cols = keyAccessToColumns(access);
      db.run(
        `INSERT OR REPLACE INTO apiKeys(id, key, name, machineId, isActive, createdAt, accessRestricted, accessAllow) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
        [k.id, k.key, k.name || null, k.machineId || null, k.isActive === false ? 0 : 1, k.createdAt || new Date().toISOString(), cols.accessRestricted, cols.accessAllow]
      );
      const policy = resolveKeyPolicy(k);
      requireAccessGroup(db, policy);
      saveKeyPolicy(db, k.id, policy);
      const budget = ['tokenLimit','costLimit','usedTokens','usedCost','unknownCostCount'];
      for (const field of budget) {
        if (k[field] !== undefined && (typeof k[field] !== 'number' || !Number.isFinite(k[field]) || k[field] < 0)) throw new Error(`Invalid ${field}`);
        db.run(`UPDATE apiKeys SET ${field}=? WHERE id=?`, [k[field] ?? 0,k.id]);
      }
      if (k.resetMode !== undefined && !['none','weekly','monthly'].includes(k.resetMode)) throw new Error('Invalid resetMode');
      db.run('UPDATE apiKeys SET resetMode=?,resetDay=?,lastResetAt=?,budgetEpochId=?,alertPolicyVersion=?,updatedAt=? WHERE id=?', [k.resetMode || 'none',k.resetDay ?? null,k.lastResetAt ?? null,k.budgetEpochId || `legacy:${k.id}`,k.alertPolicyVersion ?? 1,k.updatedAt ?? null,k.id]);
    }
    for (const a of payload.keyAlertEvents || []) {
      db.run('INSERT INTO keyAlertEvents(id,keyId,metric,threshold,used,limitValue,period,policyVersion,createdAt,acknowledgedAt,unknownCostCount) VALUES(?,?,?,?,?,?,?,?,?,?,?)', [a.id,a.keyId,a.metric,a.threshold,a.used,a.limitValue,a.period,a.policyVersion,a.createdAt,a.acknowledgedAt ?? null,a.unknownCostCount ?? 0]);
    }
    for (const o of payload.keyAlertOutbox || []) {
      db.run('INSERT INTO keyAlertOutbox(id,eventId,state,createdAt) VALUES(?,?,?,?)', [o.id,o.eventId,'inbox',o.createdAt]);
    }
    for (const c of payload.combos || []) {
      db.run(
        `INSERT OR REPLACE INTO combos(id, name, kind, contextLength, maxOutputTokens, models, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
        [c.id, c.name, c.kind || null, normalizeComboContextLength(c.contextLength), normalizeComboMaxOutputTokens(c.maxOutputTokens), stringifyJson(c.models || []), c.createdAt || new Date().toISOString(), c.updatedAt || new Date().toISOString()]
      );
    }
    for (const [a, m] of Object.entries(payload.modelAliases || {})) {
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('modelAliases', ?, ?)`, [a, stringifyJson(m)]);
    }
    for (const m of payload.customModels || []) {
      const k = `${m.providerAlias}|${m.id}|${m.type || "llm"}`;
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('customModels', ?, ?)`, [k, stringifyJson(m)]);
    }
    for (const [tool, mappings] of Object.entries(payload.mitmAlias || {})) {
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('mitmAlias', ?, ?)`, [tool, stringifyJson(mappings || {})]);
    }
    for (const [provider, models] of Object.entries(payload.pricing || {})) {
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('pricing', ?, ?)`, [provider, stringifyJson(models || {})]);
    }
  });

  return await exportDb();
}

// Eager init helper (optional)
export async function initDb() {
  await getAdapter();
}
