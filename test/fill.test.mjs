import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const PROFILE = mkdtempSync(join(tmpdir(), 'profile-'));
const env = { ...process.env, JOB_APPLY_PROFILE: PROFILE };
const FIXTURE = pathToFileURL(join(ROOT, 'fixtures/application.html')).href;

test('fills every matched field, reports misses, and never submits', () => {
  const out = mkdtempSync(join(tmpdir(), 'job-apply-'));
  const reportPath = join(out, 'report.json');
  const shotPath = join(out, 'shot.png');

  let status = 0;
  try {
    execFileSync(
      process.execPath,
      [
        join(ROOT, 'scripts/fill.mjs'),
        '--url',
        FIXTURE,
        '--fields',
        join(ROOT, 'fixtures/fields.test.json'),
        '--report',
        reportPath,
        '--shot',
        shotPath,
        '--headless',
      ],
      { cwd: ROOT, stdio: 'pipe', encoding: 'utf8', env },
    );
  } catch (error) {
    status = error.status ?? 1;
  }

  // A missed field must fail loudly so a human sees NEEDS_REVIEW.
  assert.equal(status, 1, 'exit code is 1 when a field could not be filled');

  const report = JSON.parse(readFileSync(reportPath, 'utf8'));

  assert.deepEqual(
    report.filled.map((entry) => entry.field).sort(),
    [
      'Email',
      'Full name',
      'Phone number',
      'Resume/CV',
      'Work authorization',
      'Willing to relocate',
      'cover_letter',
    ].sort(),
  );
  assert.deepEqual(report.missed, ['Nonexistent field']);

  // The submit button must never be clicked by the filler.
  assert.equal(report.submitted, null, 'form was not submitted');
  assert.equal(readFileSync(shotPath).subarray(1, 4).toString(), 'PNG');
});
