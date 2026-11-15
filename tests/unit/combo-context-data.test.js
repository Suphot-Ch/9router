import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, afterAll, beforeEach, it, expect, vi } from 'vitest';

const oldDataDir = process.env.DATA_DIR;
let dir, db, repo;
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/home/user/.hermes/cache/scratch', 'combo-context-'));
  process.env.DATA_DIR = dir;
  delete global._dbAdapter;
  vi.resetModules();
  repo = await import('@/lib/db/repos/combosRepo.js');
  db = await (await import('@/lib/db/driver.js')).getAdapter();
});
beforeEach(() => db.run('DELETE FROM combos'));
afterAll(() => {
  db?.close?.();
  delete global._dbAdapter;
  fs.rmSync(dir, { recursive: true, force: true });
  if (oldDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = oldDataDir;
});

it('persists explicit contextLength and retains it on unrelated updates', async () => {
  const combo = await repo.createCombo({ name: 'configured', models: ['cx/gpt-5'], contextLength: 500000 });
  expect(await repo.getComboById(combo.id)).toMatchObject({ contextLength: 500000 });
  await repo.updateCombo(combo.id, { models: ['cx/gpt-5.1'] });
  expect(await repo.getComboById(combo.id)).toMatchObject({ contextLength: 500000 });
});

it('persists independent maxOutputTokens and retains it when omitted on updates', async () => {
  const combo = await repo.createCombo({ name: 'output', contextLength: 500000, maxOutputTokens: 90000 });
  expect(await repo.getComboById(combo.id)).toMatchObject({ contextLength: 500000, maxOutputTokens: 90000 });
  await repo.updateCombo(combo.id, { contextLength: 100000 });
  expect(await repo.getComboByName('output')).toMatchObject({ contextLength: 100000, maxOutputTokens: 90000 });
  await repo.updateCombo(combo.id, { maxOutputTokens: null });
  expect((await repo.getComboById(combo.id)).maxOutputTokens).toBeNull();
});

it('rejects nonfinite and unsafe repository writes and accepts the safe integer boundary', async () => {
  const combo = await repo.createCombo({ name: 'boundary', contextLength: Number.MAX_SAFE_INTEGER });
  expect((await repo.getComboById(combo.id)).contextLength).toBe(Number.MAX_SAFE_INTEGER);
  for (const contextLength of [NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, -1, 1.1, true, '1']) {
    await expect(repo.createCombo({ name: 'invalid', contextLength })).rejects.toMatchObject({ status: 400 });
    await expect(repo.updateCombo(combo.id, { contextLength })).rejects.toMatchObject({ status: 400 });
  }
  expect((await repo.getComboById(combo.id)).contextLength).toBe(Number.MAX_SAFE_INTEGER);
});

it('public models GET advertises both persisted nested limits and restores Auto independently', async () => {
  await repo.createCombo({ name: 'inner', models: ['cx/gpt-5'], contextLength: 800000 });
  await repo.createCombo({ name: 'outer', models: ['inner'] });
  const route = await import('@/app/api/v1/models/route.js');
  const get = async () => (await (await route.GET(new Request('http://localhost/api/v1/models'))).json()).data;
  let models = await get();
  const baselineOutput = models.find(m => m.id === 'inner').max_completion_tokens;
  expect(baselineOutput).toBeGreaterThan(0);
  for (const id of ['inner','outer']) expect(models.find(m => m.id === id)).toMatchObject({
    context_length: 800000, capabilities: { contextWindow: 800000 }, max_completion_tokens: baselineOutput,
  });
  const inner = await repo.getComboByName('inner');
  await repo.updateCombo(inner.id, { maxOutputTokens: 750000 });
  models = await get();
  for (const id of ['inner', 'outer']) expect(models.find(m => m.id === id)).toMatchObject({
    context_length: 800000, max_completion_tokens: 750000,
    capabilities: { contextWindow: 800000, maxOutput: 750000 },
  });
  await repo.updateCombo(inner.id, { contextLength: null, maxOutputTokens: null });
  models = await get();
  expect(models.find(m => m.id === 'outer').context_length).not.toBe(800000);
  expect(models.find(m => m.id === 'outer').max_completion_tokens).toBe(baselineOutput);
}, 15000);

const request = (method, data) => new Request('http://localhost/api/combos', {
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
});
it('export/import and adapter reopen retain ctx while older backups restore Auto atomically', async () => {
  const all = await import('@/lib/db/index.js');
  const combo = await repo.createCombo({ name: 'backup', contextLength: 750000 });
  const legacy = await repo.createCombo({ name: 'auto' });
  expect(legacy.contextLength).toBeNull();
  const backup = JSON.parse(JSON.stringify(await all.exportDb()));
  expect(backup.combos.find(c => c.id === combo.id).contextLength).toBe(750000);
  await all.importDb(backup);
  expect((await repo.getComboById(combo.id)).contextLength).toBe(750000);
  const invalid = structuredClone(backup);
  invalid.combos[0].contextLength = -1;
  await expect(all.importDb(invalid)).rejects.toMatchObject({ status: 400 });
  expect((await repo.getComboById(combo.id)).contextLength).toBe(750000);
  db.close(); delete global._dbAdapter; vi.resetModules();
  db = await (await import('@/lib/db/driver.js')).getAdapter();
  repo = await import('@/lib/db/repos/combosRepo.js');
  expect((await repo.getComboById(combo.id)).contextLength).toBe(750000);
  expect(db.get('PRAGMA integrity_check').integrity_check).toBe('ok');
  delete backup.combos[0].contextLength;
  await (await import('@/lib/db/index.js')).importDb(backup);
  expect((await repo.getComboById(combo.id)).contextLength).toBeNull();
});
it('export/import and reopen preserve both limits and reject invalid output atomically', async () => {
  const all = await import('@/lib/db/index.js');
  const combo = await repo.createCombo({ name: 'output-backup', contextLength: 750000, maxOutputTokens: 180000 });
  const backup = JSON.parse(JSON.stringify(await all.exportDb()));
  expect(backup.combos[0]).toMatchObject({ contextLength: 750000, maxOutputTokens: 180000 });
  await all.importDb(backup);
  expect(await repo.getComboById(combo.id)).toMatchObject({ contextLength: 750000, maxOutputTokens: 180000 });
  const invalid = structuredClone(backup);
  invalid.combos[0].maxOutputTokens = -1;
  await expect(all.importDb(invalid)).rejects.toMatchObject({ status: 400 });
  expect(await repo.getComboById(combo.id)).toMatchObject({ contextLength: 750000, maxOutputTokens: 180000 });
  db.close(); delete global._dbAdapter; vi.resetModules();
  db = await (await import('@/lib/db/driver.js')).getAdapter();
  repo = await import('@/lib/db/repos/combosRepo.js');
  expect(await repo.getComboById(combo.id)).toMatchObject({ contextLength: 750000, maxOutputTokens: 180000 });
  delete backup.combos[0].maxOutputTokens;
  await (await import('@/lib/db/index.js')).importDb(backup);
  expect(await repo.getComboById(combo.id)).toMatchObject({ contextLength: 750000, maxOutputTokens: null });
  expect(db.get('PRAGMA integrity_check').integrity_check).toBe('ok');
});

it('CRUD independently validates max output, retains omitted values and resets Auto', async () => {
  const collection = await import('@/app/api/combos/route.js');
  const item = await import('@/app/api/combos/[id]/route.js');
  const response = await collection.POST(request('POST', { name: 'output-api', contextLength: 1000000, maxOutputTokens: 200000 }));
  expect(response.status).toBe(201);
  const created = await response.json();
  const params = { params: Promise.resolve({ id: created.id }) };
  expect(created).toMatchObject({ maxOutputTokens: 200000 });
  expect(await (await item.GET(request('GET'), params)).json()).toMatchObject({ maxOutputTokens: 200000 });
  expect((await (await collection.GET()).json()).combos[0].maxOutputTokens).toBe(200000);
  expect(await (await item.PUT(request('PUT', { name: 'output-renamed' }), params)).json()).toMatchObject({ maxOutputTokens: 200000 });
  for (const maxOutputTokens of [-1, 1.5, '128000', true, {}, [], Number.MAX_SAFE_INTEGER + 1]) {
    expect((await collection.POST(request('POST', { name: 'invalid-output', maxOutputTokens }))).status).toBe(400);
    expect((await item.PUT(request('PUT', { name: 'must-not-change', maxOutputTokens }), params)).status).toBe(400);
    expect(await repo.getComboById(created.id)).toMatchObject({ name: 'output-renamed', contextLength: 1000000, maxOutputTokens: 200000 });
  }
  for (const maxOutputTokens of [null, '', '  ', 0]) {
    expect(await (await item.PUT(request('PUT', { maxOutputTokens }), params)).json()).toMatchObject({ contextLength: 1000000, maxOutputTokens: null });
    expect((await repo.getComboById(created.id)).maxOutputTokens).toBeNull();
  }
  for (const maxOutputTokens of [NaN, Infinity, -Infinity, -1, 0.1, true, '1', Number.MAX_SAFE_INTEGER + 1]) {
    await expect(repo.createCombo({ name: 'invalid', maxOutputTokens })).rejects.toMatchObject({ status: 400 });
    await expect(repo.updateCombo(created.id, { maxOutputTokens })).rejects.toMatchObject({ status: 400 });
  }
  await repo.updateCombo(created.id, { maxOutputTokens: Number.MAX_SAFE_INTEGER });
  expect((await repo.getComboById(created.id)).maxOutputTokens).toBe(Number.MAX_SAFE_INTEGER);
});

it('CRUD exposes ctx, preserves omitted PUT, normalizes Auto and rejects invalid values without writes', async () => {
  const collection = await import('@/app/api/combos/route.js');
  const item = await import('@/app/api/combos/[id]/route.js');
  const res = await collection.POST(request('POST', { name: 'api', contextLength: 1000000 }));
  expect(res.status).toBe(201);
  const created = await res.json();
  expect(created.contextLength).toBe(1000000);
  const params = { params: Promise.resolve({ id: created.id }) };
  expect(await (await item.GET(request('GET'), params)).json()).toMatchObject({ contextLength: 1000000 });
  expect((await (await collection.GET()).json()).combos[0].contextLength).toBe(1000000);
  expect(await (await item.PUT(request('PUT', { name: 'renamed' }), params)).json()).toMatchObject({ contextLength: 1000000 });
  for (const contextLength of [-1, 1.5, '128000', true, {}, [], Number.MAX_SAFE_INTEGER + 1]) {
    expect((await collection.POST(request('POST', { name: 'invalid', contextLength }))).status).toBe(400);
    expect((await item.PUT(request('PUT', { name: 'must-not-change', contextLength }), params)).status).toBe(400);
    expect(await repo.getComboById(created.id)).toMatchObject({ name: 'renamed', contextLength: 1000000 });
  }
  for (const contextLength of [null, '', '  ', 0]) {
    expect(await (await item.PUT(request('PUT', { contextLength }), params)).json()).toMatchObject({ contextLength: null });
    expect((await repo.getComboById(created.id)).contextLength).toBeNull();
  }
  expect((await item.DELETE(request('DELETE'), params)).status).toBe(200);
  expect(await repo.getComboById(created.id)).toBeNull();
});
