import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { it,expect,vi } from 'vitest';
it('additively migrates v3 preserving budgets, access and secret identity, backs up before schema change and survives reopen',async()=> {
  const root='/home/user/.hermes/cache/scratch/9router-governance-dev-data'; fs.mkdirSync(root,{recursive:true});
  const dir=fs.mkdtempSync(path.join(root,'migration-')), old=process.env.DATA_DIR;
  let adapter;
  try {
    fs.mkdirSync(path.join(dir,'db'),{recursive:true});
    const sql=new DatabaseSync(path.join(dir,'db/data.sqlite'));
    sql.exec(`CREATE TABLE _meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO _meta VALUES('schemaVersion','3'),('backupSchemaVersion','3');
      CREATE TABLE apiKeys(id TEXT PRIMARY KEY,key TEXT UNIQUE NOT NULL,name TEXT,machineId TEXT,isActive INTEGER DEFAULT 1,createdAt TEXT NOT NULL,tokenLimit INTEGER DEFAULT 0,costLimit REAL DEFAULT 0,usedTokens INTEGER DEFAULT 0,usedCost REAL DEFAULT 0,resetMode TEXT DEFAULT 'none',resetDay INTEGER,lastResetAt TEXT,updatedAt TEXT,accessRestricted INTEGER DEFAULT 0,accessAllow TEXT);
      INSERT INTO apiKeys(id,key,name,isActive,createdAt,tokenLimit,costLimit,usedTokens,usedCost,resetMode,accessRestricted,accessAllow) VALUES('legacy','fixture-secret','legacy',1,'2026-09-01',100,2,95,1.5,'none',1,'["cx/gpt-5"]');`);
    sql.close();
    process.env.DATA_DIR=dir; delete global._dbAdapter; vi.resetModules();
    let driver=await import('@/lib/db/driver.js'); adapter=await driver.getAdapter();
    let repo=await import('@/lib/db/repos/apiKeysRepo.js');
    const key=await repo.getApiKeyById('legacy');
    expect(key).toMatchObject({key:'fixture-secret',tokenLimit:100,costLimit:2,usedTokens:95,usedCost:1.5,access:{restricted:true,allow:['cx/gpt-5']},rpmLimit:0,tpmLimit:0,accessMode:'local'});
    expect(adapter.get('PRAGMA integrity_check').integrity_check).toBe('ok');
    const files=fs.readdirSync(dir,{recursive:true}); expect(files.some(p=>String(p).includes('backup'))).toBe(true);
    expect(adapter.get('SELECT COUNT(*) AS n FROM keyAlertEvents').n).toBe(2);
    const alerts=await import('@/lib/db/repos/keyAlertsRepo.js');
    expect(await alerts.getKeyAlerts({keyId:'legacy'})).toHaveLength(2);
    adapter.close(); delete global._dbAdapter; vi.resetModules();
    driver=await import('@/lib/db/driver.js'); adapter=await driver.getAdapter();
    expect(await (await import('@/lib/db/repos/keyAlertsRepo.js')).getKeyAlerts({keyId:'legacy'})).toHaveLength(2);
    repo=await import('@/lib/db/repos/apiKeysRepo.js'); expect((await repo.getApiKeyById('legacy')).usedTokens).toBe(95);
  } finally { adapter?.close?.(); delete global._dbAdapter; if(old===undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR=old; fs.rmSync(dir,{recursive:true,force:true}); }
});
