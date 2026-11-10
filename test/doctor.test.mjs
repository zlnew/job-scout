import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { after } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');
const DOCTOR = join(ROOT, 'cli/doctor.mjs');

const scratch = mkdtempSync(join(tmpdir(), 'job-apply-doctor-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** A healthy store, profile and session marker in a throwaway tree. */
function healthyTree(name) {
  const dir = mkdtempSync(join(scratch, `${name}-`));
  const store = join(dir, 'applications.json');
  const profile = join(dir, 'profile.json');
  const browserProfile = join(dir, 'browser-profile');
  writeFileSync(store, `${JSON.stringify({ schemaVersion: 2, updated: '2026-11-10', applications: [] }, null, 2)}\n`);
  writeFileSync(profile, readFileSync(join(ROOT, 'data/profile.json')));
  mkdirSync(join(browserProfile, 'Default'), { recursive: true });
  writeFileSync(join(browserProfile, 'Default', 'Cookies'), 'sqlite');
  return { dir, store, profile, browserProfile, backups: join(dir, 'backups') };
}

function runDoctor(paths, extra = []) {
  try {
    const stdout = execFileSync(process.execPath, [
      DOCTOR,
      '--store',
      paths.store,
      '--profile',
      paths.profile,
      '--backups',
      paths.backups,
      ...extra,
    ], {
      cwd: ROOT,
      env: { ...process.env, JOB_APPLY_PROFILE: paths.browserProfile },
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return { status: error.status ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

test('doctor prints a table and exits 0 when the tree is healthy', () => {
  const paths = healthyTree('healthy');
  const result = runDoctor(paths);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const row of ['store', 'schemaVersion', 'profile', 'backups', 'adapters', 'linkedin', 'hook']) {
    assert.match(result.stdout, new RegExp(`^${row}\\b`, 'm'), `${row} row is printed`);
  }
  assert.match(result.stdout, /ok\s+.*applications\.json/);
});

test('doctor exits 6 and names the fix when the store is not valid JSON', () => {
  const paths = healthyTree('corrupt');
  writeFileSync(paths.store, '{"applications": [');
  const result = runDoctor(paths);

  assert.equal(result.status, 6);
  assert.match(result.stdout, /^store\s+fail/m);
  assert.match(result.stdout, /not valid JSON/);
  assert.match(result.stdout, /fix: .*backup/);
});

test('doctor exits 6 when profile provenance is invalid', () => {
  const paths = healthyTree('provenance');
  const profile = JSON.parse(readFileSync(paths.profile, 'utf8'));
  profile.identity.email.source = 'assumed';
  writeFileSync(paths.profile, `${JSON.stringify(profile, null, 2)}\n`);
  const result = runDoctor(paths);

  assert.equal(result.status, 6);
  assert.match(result.stdout, /^profile\s+fail/m);
  assert.match(result.stdout, /assumed/);
});
