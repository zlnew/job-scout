import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { after } from 'node:test';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const PREPARE = join(ROOT, 'cli/prepare.mjs');
const APPLY = join(ROOT, 'cli/apply.mjs');
const FIXTURE = pathToFileURL(join(ROOT, 'fixtures/application.html')).href;
const ID = '1234567890';

const scratch = mkdtempSync(join(tmpdir(), 'job-apply-cli-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const env = { ...process.env, JOB_APPLY_PROFILE: join(scratch, 'profile') };

function storePath(name) {
  return join(scratch, `${name}.json`);
}

function eventsPath(name) {
  return join(scratch, `${name}.events.jsonl`);
}

function writeStore(path, records) {
  writeFileSync(path, `${JSON.stringify({ updated: '2026-11-09', applications: records }, null, 2)}\n`);
}

function run(script, args) {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      cwd: ROOT,
      env,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return {
      status: error.status ?? 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    };
  }
}

const fields = {
  'Full name': 'Maulana Aprizqy Sumaryanto',
  Email: 'aprizqymaulana@gmail.com',
  'Phone number': '+62 813-8379-4949',
  'Work authorization': 'Yes, Indonesian citizen',
  'Willing to relocate': true,
  'Cover letter': 'Fixture cover letter text.',
};

const record = (overrides = {}) => ({
  company: 'Fixture Co',
  role: 'Backend Engineer',
  status: 'prepared',
  url: `https://www.linkedin.com/jobs/view/${ID}`,
  applyUrl: FIXTURE,
  applyKind: 'ats',
  identityKey: 'fixture-record',
  fields,
  questions: [],
  blocked: [],
  missing: [],
  ...overrides,
});

test('prepare without arguments exits 2 with usage', () => {
  const result = run(PREPARE, []);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage: node cli\/prepare\.mjs --id/);
});

test('prepare names an unknown LinkedIn id and exits 2', () => {
  const store = storePath('unknown');
  writeStore(store, [record()]);

  const result = run(PREPARE, ['--id', '9999999999', '--store', store]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /9999999999/);
});

test('apply refuses a record that is not prepared and exits 3', () => {
  const store = storePath('shortlisted');
  writeStore(store, [record({ status: 'shortlisted' })]);

  const result = run(APPLY, ['--id', ID, '--store', store, '--headless']);

  assert.equal(result.status, 3);
  assert.match(result.stderr, /shortlisted.*not "prepared"/);
});

test('apply --dry-run fills and guards a fixture form without touching the record', () => {
  const store = storePath('dry-run');
  const events = eventsPath('dry-run');
  const initial = record();
  writeStore(store, [initial]);

  const result = run(APPLY, ['--id', ID, '--store', store, '--events', events, '--dry-run', '--headless']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /dry run: filled 6 fields, guard passed/);
  assert.deepEqual(JSON.parse(readFileSync(store, 'utf8')).applications, [initial]);
  assert.equal(existsSync(events), false, 'dry-run appends no event');
});

test('apply refuses when checkSubmission reports a blocked question', () => {
  const store = storePath('blocked');
  const initial = record({
    blocked: [{ label: 'Religion', key: 'answers.religion', reason: 'blockedTopics: religion' }],
  });
  writeStore(store, [initial]);

  const result = run(APPLY, ['--id', ID, '--store', store, '--headless']);

  assert.equal(result.status, 3);
  assert.match(result.stderr, /guard refused: blocked questions: Religion/);
  assert.deepEqual(JSON.parse(readFileSync(store, 'utf8')).applications, [initial]);
});

test('apply --dry-run --json prints a machine-readable result with the optional warning', () => {
  const store = storePath('json-dry');
  const events = eventsPath('json-dry');
  writeStore(store, [record({ missing: [{ field: 'Job Vacancy to Apply', required: false }] })]);

  const result = run(APPLY, ['--id', ID, '--store', store, '--events', events, '--dry-run', '--headless', '--json']);

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.code, 'dry-run-clean');
  assert.equal(payload.value.id, ID);
  assert.deepEqual(payload.reasons, []);
  assert.equal(payload.warnings[0].code, 'optional-unmatched');
  assert.match(payload.warnings[0].fix, /review/i);
});

test('apply --json prints a coded refusal and keeps exit code 3', () => {
  const store = storePath('json-refused');
  writeStore(store, [record({ status: 'shortlisted' })]);

  const result = run(APPLY, ['--id', ID, '--store', store, '--headless', '--json']);

  assert.equal(result.status, 3);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'not-prepared');
  assert.match(payload.fix, /prepare/);
});

test('prepare --json prints the structured result without prose', () => {
  const store = storePath('json-prepare');
  writeStore(store, [
    record({
      status: 'shortlisted',
      applyUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      coverLetter: 'Fixture cover letter text.',
    }),
  ]);

  const result = run(PREPARE, ['--id', ID, '--store', store, '--json']);

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.code, 'prepared');
  assert.equal(payload.value.id, ID);
  assert.equal(payload.value.adapter, 'greenhouse');
  assert.ok(Array.isArray(payload.value.fields));
  assert.ok(Array.isArray(payload.reasons));
  assert.equal(result.status, 0, result.stderr);
});

test('prepare --json reports a missing record on stdout with exit code 2', () => {
  const store = storePath('json-unknown');
  writeStore(store, [record()]);

  const result = run(PREPARE, ['--id', '9999999999', '--store', store, '--json']);

  assert.equal(result.status, 2);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'record-not-found');
  assert.match(payload.message, /9999999999/);
  assert.match(payload.fix, /scan/);
});
