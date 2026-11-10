import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import {
  MAX_BACKUPS,
  SCHEMA_VERSION,
  backupBeforeWrite,
  migrate,
  readJson,
  writeJsonAtomic,
  writeJsonSafe,
} from '../core/store.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'job-apply-store-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const caseDir = (name) => {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  return dir;
};

test('readJson parses a file and reports invalid JSON with a coded error', () => {
  const dir = caseDir('read');
  const path = join(dir, 'store.json');
  writeFileSync(path, '{"a":1}\n');
  assert.deepEqual(readJson(path), { a: 1 });

  writeFileSync(path, '{"a":');
  assert.throws(
    () => readJson(path),
    (error) => {
      assert.equal(error.code, 'store-corrupt');
      assert.match(error.message, /not valid JSON/);
      assert.match(error.fix, /backup/);
      return true;
    },
  );
});

test('writeJsonAtomic replaces the file and leaves no temp file behind', () => {
  const dir = caseDir('atomic');
  const path = join(dir, 'store.json');
  writeJsonAtomic(path, { schemaVersion: 2, applications: [] });

  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { schemaVersion: 2, applications: [] });
  assert.deepEqual(readdirSync(dir), ['store.json']);
});

test('backupBeforeWrite copies the previous file and keeps the newest MAX_BACKUPS', () => {
  const dir = caseDir('backup');
  const path = join(dir, 'applications.json');
  const backups = join(dir, 'backups');
  writeFileSync(path, '{"old":true}\n');

  const first = backupBeforeWrite(path, { backupDir: backups });
  assert.ok(first);
  assert.match(first, /applications\.\d{4}-\d{2}-\d{2}T.*\.json$/);
  assert.deepEqual(JSON.parse(readFileSync(first, 'utf8')), { old: true });

  // Pruning is by name, and the ISO timestamp sorts oldest first.
  for (let i = 0; i < MAX_BACKUPS + 5; i += 1) {
    writeFileSync(join(backups, `applications.2026-01-01T00-00-${String(i).padStart(2, '0')}.000Z.json`), '{}');
  }
  backupBeforeWrite(path, { backupDir: backups });

  const kept = readdirSync(backups).filter((name) => /^applications\..*\.json$/.test(name));
  assert.equal(kept.length, MAX_BACKUPS);
  // The newest existing backup survives; the oldest pad files are gone.
  assert.ok(!kept.includes('applications.2026-01-01T00-00-00.000Z.json'));
});

test('backupBeforeWrite does nothing when there is no previous file', () => {
  const dir = caseDir('no-previous');
  assert.equal(backupBeforeWrite(join(dir, 'missing.json'), { backupDir: join(dir, 'backups') }), null);
});

test('writeJsonSafe backs up the old content before replacing it', () => {
  const dir = caseDir('safe');
  const path = join(dir, 'profile.json');
  writeFileSync(path, '{"version":"old"}\n');

  writeJsonSafe(path, { version: 'new' }, { backupDir: join(dir, 'backups') });
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { version: 'new' });

  const [backup] = readdirSync(join(dir, 'backups'));
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'backups', backup), 'utf8')), { version: 'old' });
});

test('migrate wraps a v1 array store and reports the migration', () => {
  const { store, migrated } = migrate([{ role: 'Backend' }]);
  assert.equal(migrated, true);
  assert.equal(store.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(store.applications, [{ role: 'Backend' }]);
});

test('migrate stamps a v1 object store and leaves a current store alone', () => {
  const v1 = migrate({ updated: '2026-01-01', applications: [{ role: 'Backend' }] });
  assert.equal(v1.migrated, true);
  assert.equal(v1.store.schemaVersion, SCHEMA_VERSION);
  assert.equal(v1.store.updated, '2026-01-01');

  const current = { schemaVersion: SCHEMA_VERSION, updated: '2026-01-01', applications: [] };
  const v2 = migrate(current);
  assert.equal(v2.migrated, false);
  assert.deepEqual(v2.store, current);
});

test('migrate refuses a store written by a newer build', () => {
  assert.throws(
    () => migrate({ schemaVersion: SCHEMA_VERSION + 1, applications: [] }),
    (error) => {
      assert.equal(error.code, 'store-schema');
      assert.match(error.message, /newer/);
      return true;
    },
  );
});
