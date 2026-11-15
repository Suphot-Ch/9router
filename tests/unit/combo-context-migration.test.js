import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { it, expect, vi } from 'vitest';

async function isolated(run) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/home/user/.hermes/cache/scratch', 'combo-migration-'));
  const old = process.env.DATA_DIR;
  let db;
  try {
    process.env.DATA_DIR = dir;
    delete global._dbAdapter; vi.resetModules();
    await run(dir, async () => {
      db = await (await import('@/lib/db/driver.js')).getAdapter();
      return db;
    });
  } finally {
    db?.close?.(); delete global._dbAdapter;
    if (old === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = old;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

it('additively upgrades v4 combos to Auto with pre-change backup and preserves governance rows', async () => {
  await isolated(async (dir, open) => {
    const { TABLES, buildCreateTableSql } = await import('@/lib/db/schema.js');
    fs.mkdirSync(path.join(dir, 'db'), { recursive: true });
    const sql = new DatabaseSync(path.join(dir, 'db/data.sqlite'));
    for (const [name, def] of Object.entries(TABLES)) {
      const old = structuredClone(def);
      if (name === 'combos') { delete old.columns.contextLength; delete old.columns.maxOutputTokens; }
      sql.exec(buildCreateTableSql(name, old));
    }
    sql.exec(`INSERT INTO _meta VALUES('schemaVersion','1'),('backupSchemaVersion','4');
      INSERT INTO combos(id,name,models,createdAt,updatedAt) VALUES('old','legacy','["cx/gpt-5"]','before','before');
      INSERT INTO apiKeys(id,key,name,createdAt,accessMode,accessGroupId,rpmLimit,tpmLimit) VALUES('key','fixture-secret','fixture','before','group','group',2,300);
      INSERT INTO accessGroups VALUES('group','group','{"restricted":true,"allow":["legacy"]}','before','before');`);
    const beforeKey = sql.prepare('SELECT * FROM apiKeys').get();
    const beforeGroup = sql.prepare('SELECT * FROM accessGroups').get();
    sql.close();
    const db = await open();
    expect((await (await import('@/lib/db/repos/combosRepo.js')).getComboById('old')).contextLength).toBeNull();
    expect(db.get('SELECT * FROM apiKeys')).toEqual(beforeKey);
    expect(db.get('SELECT * FROM accessGroups')).toEqual(beforeGroup);
    expect(db.get("SELECT value FROM _meta WHERE key='backupSchemaVersion'").value).toBe('6');
    expect(fs.readdirSync(path.join(dir, 'db/backups')).some(p => p.includes('schema-4-to-6'))).toBe(true);
    expect(db.get('PRAGMA integrity_check').integrity_check).toBe('ok');
  });
}, 15000);

it('upgrades ctx-only v5 databases without losing configured ctx and backs up before adding output', async () => {
  await isolated(async (dir, open) => {
    const { TABLES, buildCreateTableSql } = await import('@/lib/db/schema.js');
    fs.mkdirSync(path.join(dir, 'db'), { recursive: true });
    const sql = new DatabaseSync(path.join(dir, 'db/data.sqlite'));
    for (const [name, def] of Object.entries(TABLES)) {
      const old = structuredClone(def);
      if (name === 'combos') delete old.columns.maxOutputTokens;
      sql.exec(buildCreateTableSql(name, old));
    }
    sql.exec(`INSERT INTO _meta VALUES('schemaVersion','1'),('backupSchemaVersion','5');
      INSERT INTO combos(id,name,contextLength,models,createdAt,updatedAt) VALUES('ctx','ctx-only',500000,'[]','before','before');`);
    sql.close();
    const db = await open();
    expect(await (await import('@/lib/db/repos/combosRepo.js')).getComboById('ctx')).toMatchObject({ contextLength: 500000, maxOutputTokens: null });
    expect(fs.readdirSync(path.join(dir, 'db/backups')).some(p => p.includes('schema-5-to-6'))).toBe(true);
    expect(db.get('PRAGMA integrity_check').integrity_check).toBe('ok');
  });
}, 15000);

it('legacy JSON migration preserves both configured limits and missing values become Auto', async () => {
  await isolated(async (dir, open) => {
    fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ combos: [
      { id: 'ctx', name: 'configured', models: [], contextLength: 500000, maxOutputTokens: 50000 },
      { id: 'auto', name: 'automatic', models: [] },
    ] }));
    await open();
    const repo = await import('@/lib/db/repos/combosRepo.js');
    expect(await repo.getComboById('ctx')).toMatchObject({ contextLength: 500000, maxOutputTokens: 50000 });
    expect(await repo.getComboById('auto')).toMatchObject({ contextLength: null, maxOutputTokens: null });
  });
}, 15000);
