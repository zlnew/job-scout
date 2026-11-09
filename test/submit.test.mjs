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

const run = (argv) => {
  try {
    return { status: 0, stdout: execFileSync(process.execPath, argv, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8', env }), stderr: '' };
  } catch (error) {
    return { status: error.status ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
};

test('--submit clicks the real submit control once every field is filled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'submit-'));
  const report = join(dir, 'report.json');
  const { status } = run([
    join(ROOT, 'scripts/fill.mjs'),
    '--url', FIXTURE,
    '--fields', join(ROOT, 'fixtures/fields.ok.json'),
    '--report', report,
    '--shot', join(dir, 'shot.png'),
    '--submit',
    '--headless',
  ]);

  assert.equal(status, 0, 'complete form submits cleanly');
  const written = JSON.parse(readFileSync(report, 'utf8'));
  assert.equal(written.submitClicked, true, 'submit control was clicked');
  assert.equal(written.submitted, '1', 'the page confirms submission happened');
  assert.deepEqual(written.missed, []);
});

test('--submit refuses when any field could not be filled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'submit-'));
  const report = join(dir, 'report.json');
  const { status } = run([
    join(ROOT, 'scripts/fill.mjs'),
    '--url', FIXTURE,
    '--fields', join(ROOT, 'fixtures/fields.test.json'),
    '--report', report,
    '--shot', join(dir, 'shot.png'),
    '--submit',
    '--headless',
  ]);

  assert.equal(status, 3, 'run fails as blocked-submission, not as a silent skip');
  const written = JSON.parse(readFileSync(report, 'utf8'));
  assert.equal(written.submitClicked, undefined, 'nothing was submitted');
  assert.notEqual(written.submitted, '1', 'page was never submitted');
  assert.match(written.submitBlocked, /unfilled fields/);
});

test('--submit is refused outright on linkedin.com', () => {
  const dir = mkdtempSync(join(tmpdir(), 'submit-'));
  const report = join(dir, 'report.json');
  const result = run([
    join(ROOT, 'scripts/fill.mjs'),
    '--url', 'https://www.linkedin.com/jobs/view/4440204415',
    '--fields', join(ROOT, 'fixtures/fields.ok.json'),
    '--report', report,
    '--submit',
    '--headless',
  ]);

  assert.equal(result.status, 2, 'blocked before launching a browser');
  assert.match(result.stderr, /refusing --submit on linkedin\.com/);
});
