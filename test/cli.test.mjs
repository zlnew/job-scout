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
