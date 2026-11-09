import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const GATE = pathToFileURL(join(ROOT, 'fixtures/apply-gate.html')).href;
const env = { ...process.env, JOB_APPLY_PROFILE: mkdtempSync(join(tmpdir(), 'profile-')) };

const run = (argv) => {
  try {
    return { status: 0, stderr: '' };
  } finally {
    // placeholder replaced below
  }
};

test('--click opens a gated form before filling', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-'));
  const report = join(dir, 'report.json');
  let status = 0;
  try {
    execFileSync(
      process.execPath,
      [join(ROOT, 'scripts/fill.mjs'), '--url', GATE, '--fields', join(ROOT, 'fixtures/fields.gate.json'), '--click', 'Apply for this job', '--report', report, '--shot', join(dir, 'shot.png'), '--headless'],
      { cwd: ROOT, stdio: 'pipe', env },
    );
  } catch (error) {
    status = error.status ?? 1;
  }
  assert.equal(status, 0, 'gated form fills cleanly');
  const written = JSON.parse(readFileSync(report, 'utf8'));
  assert.equal(written.filled.length, 3);
  assert.deepEqual(written.missed, []);
  assert.equal(written.clicked, 'Apply for this job');
  assert.equal(written.submitted, null, 'still never submits');
});

test('--click with no matching control fails loudly instead of filling nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-'));
  let status = 0;
  let stderr = '';
  try {
    execFileSync(
      process.execPath,
      [join(ROOT, 'scripts/fill.mjs'), '--url', GATE, '--fields', join(ROOT, 'fixtures/fields.gate.json'), '--click', 'Nonexistent button', '--report', join(dir, 'r.json'), '--shot', join(dir, 's.png'), '--headless'],
      { cwd: ROOT, stdio: 'pipe', env },
    );
  } catch (error) {
    status = error.status ?? 1;
    stderr = String(error.stderr ?? '');
  }
  assert.equal(status, 4);
  assert.match(stderr, /matched nothing/);
});
