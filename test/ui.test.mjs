import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { after } from 'node:test';
import { identityKey, loadProfile } from '../core/guard.mjs';
import { createHandlers } from '../ui/handlers.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const scratch = mkdtempSync(join(tmpdir(), 'job-apply-ui-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

function fixture(records) {
  const dir = mkdtempSync(join(scratch, 'case-'));
  const paths = {
    storePath: join(dir, 'applications.json'),
    profilePath: join(dir, 'profile.json'),
    eventsPath: join(dir, 'events.jsonl'),
  };
  writeFileSync(paths.storePath, `${JSON.stringify({ updated: '2026-11-10', applications: records }, null, 2)}\n`);
  writeFileSync(paths.profilePath, readFileSync(join(ROOT, 'data/profile.json')));
  writeFileSync(paths.eventsPath, '');
  return paths;
}

const record = (overrides = {}) => {
  const value = { company: 'Acme', role: 'Backend Engineer', status: 'shortlisted', ...overrides };
  return { ...value, identityKey: identityKey(value) };
};

test('board returns records sorted by score then posted date, with counts and gaps', () => {
  const paths = fixture([
    record({ company: 'A', score: 5, posted: '2026-01-01', status: 'shortlisted' }),
    record({ company: 'B', score: 9, posted: '2026-01-01', status: 'submitted' }),
    record({ company: 'C', score: 9, posted: '2026-02-01', status: 'shortlisted' }),
    record({ company: 'D', score: null, posted: '2026-03-01', status: 'discovered' }),
  ]);
  const handlers = createHandlers(paths);

  const response = handlers.handle({ method: 'GET', path: '/api/board' });
  assert.equal(response.status, 200);

  const board = JSON.parse(response.body);
  assert.deepEqual(board.records.map((item) => item.company), ['C', 'B', 'A', 'D']);
  assert.equal(board.counts.shortlisted, 2);
  assert.equal(board.counts.submitted, 1);
  assert.equal(board.counts.discovered, 1);
  assert.ok(board.gaps.some((gap) => gap.key === 'answers.age'), 'unanswered questions are reported');
});

test('answers writes confirmed provenance, removes the blocked topic, and rejects unknown keys', () => {
  const paths = fixture([]);
  const handlers = createHandlers(paths);

  const beforeAnyWrite = readFileSync(paths.profilePath, 'utf8');
  const nonScalar = handlers.handle({
    method: 'POST',
    path: '/api/answers',
    body: { key: 'answers.race', value: { guessed: true } },
  });
  assert.equal(nonScalar.status, 400);
  assert.equal(readFileSync(paths.profilePath, 'utf8'), beforeAnyWrite, 'a non-scalar value never touches disk');

  const accepted = handlers.handle({
    method: 'POST',
    path: '/api/answers',
    body: { key: 'answers.age', value: 30 },
  });
  assert.equal(accepted.status, 200);

  const profile = loadProfile(paths.profilePath);
  assert.deepEqual(profile.answers.age, { value: 30, source: 'confirmed', scope: 'all' });
  assert.ok(!profile.blockedTopics.some((entry) => entry.key === 'answers.age'));
  assert.doesNotThrow(() => JSON.parse(readFileSync(paths.profilePath, 'utf8')));
  assert.ok(!JSON.parse(accepted.body).gaps.some((gap) => gap.key === 'answers.age'));

  const unchanged = readFileSync(paths.profilePath, 'utf8');
  const rejected = handlers.handle({
    method: 'POST',
    path: '/api/answers',
    body: { key: 'work.notARegistryKey', value: 'x' },
  });
  assert.equal(rejected.status, 400);
  assert.equal(readFileSync(paths.profilePath, 'utf8'), unchanged, 'a rejected key never touches disk');
});

test('status applies a legal transition and rejects an illegal one with 409', () => {
  const target = record({ company: 'Acme', linkedinId: '123', url: 'https://www.linkedin.com/jobs/view/123' });
  const paths = fixture([target]);
  const handlers = createHandlers(paths);

  const legal = handlers.handle({
    method: 'POST',
    path: '/api/status',
    body: { id: target.identityKey, status: 'resolved', note: 'apply target found' },
  });
  assert.equal(legal.status, 200);

  const store = JSON.parse(readFileSync(paths.storePath, 'utf8'));
  assert.equal(store.applications[0].status, 'resolved');
  const event = JSON.parse(readFileSync(paths.eventsPath, 'utf8').trim());
  assert.equal(event.action, 'status');
  assert.equal(event.status, 'resolved');
  assert.equal(event.note, 'apply target found');

  const illegal = handlers.handle({
    method: 'POST',
    path: '/api/status',
    body: { id: target.identityKey, status: 'offer' },
  });
  assert.equal(illegal.status, 409);
  assert.match(JSON.parse(illegal.body).error, /illegal transition/);
  assert.equal(
    JSON.parse(readFileSync(paths.storePath, 'utf8')).applications[0].status,
    'resolved',
    'a rejected transition leaves the store alone',
  );
});

test('a real apply without the exact confirm returns 400 and never spawns', () => {
  const calls = [];
  const spawn = (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      child.stdout.emit('data', 'submitted\n');
      child.emit('close', 0);
    });
    return child;
  };

  const target = record({
    company: 'Acme',
    role: 'Backend Engineer',
    status: 'prepared',
    linkedinId: '123',
    url: 'https://www.linkedin.com/jobs/view/123',
    applyUrl: 'https://acme.test/apply',
  });
  const paths = fixture([target]);
  const handlers = createHandlers({ ...paths, spawn });

  const missing = handlers.handle({
    method: 'POST',
    path: '/api/apply',
    body: { id: '123', dryRun: false },
  });
  assert.equal(missing.status, 400);
  assert.equal(calls.length, 0);

  const wrong = handlers.handle({
    method: 'POST',
    path: '/api/apply',
    body: { id: '123', dryRun: false, confirm: 'acme' },
  });
  assert.equal(wrong.status, 400);
  assert.equal(calls.length, 0);
});

test('apply defaults to dry-run and reports the queued job through /api/job/:id', async () => {
  const calls = [];
  const spawn = (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      child.stdout.emit('data', 'dry-run filled the form\n');
      child.emit('close', 0);
    });
    return child;
  };

  const target = record({
    company: 'Acme',
    status: 'prepared',
    linkedinId: '123',
    url: 'https://www.linkedin.com/jobs/view/123',
    applyUrl: 'https://acme.test/apply',
  });
  const paths = fixture([target]);
  const handlers = createHandlers({ ...paths, spawn });

  const started = handlers.handle({ method: 'POST', path: '/api/apply', body: { id: '123' } });
  assert.equal(started.status, 202);
  const { job } = JSON.parse(started.body);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes('--dry-run'), 'a real submit needs an explicit dryRun: false');

  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  const state = handlers.handle({ method: 'GET', path: `/api/job/${job}` });
  assert.equal(state.status, 200);
  assert.equal(JSON.parse(state.body).state, 'done');
  assert.match(JSON.parse(state.body).output, /dry-run filled the form/);
});

test('browser jobs share one slot so two browser profiles never run at once', () => {
  const children = [];
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    children.push(child);
    return child;
  };

  const paths = fixture([
    record({ company: 'Acme', status: 'prepared', linkedinId: '123' }),
    record({ company: 'Beta', status: 'prepared', linkedinId: '456' }),
  ]);
  const handlers = createHandlers({ ...paths, spawn });

  const first = JSON.parse(handlers.handle({ method: 'POST', path: '/api/prepare', body: { id: '123' } }).body).job;
  const second = JSON.parse(handlers.handle({ method: 'POST', path: '/api/prepare', body: { id: '456' } }).body).job;

  assert.equal(children.length, 1);
  assert.equal(JSON.parse(handlers.handle({ method: 'GET', path: `/api/job/${first}` }).body).state, 'running');
  assert.equal(JSON.parse(handlers.handle({ method: 'GET', path: `/api/job/${second}` }).body).state, 'queued');

  children[0].emit('close', 0);
  assert.equal(children.length, 2);
  assert.equal(JSON.parse(handlers.handle({ method: 'GET', path: `/api/job/${second}` }).body).state, 'running');
  children[1].emit('close', 0);
});

test('static route serves the page as text/html', () => {
  const handlers = createHandlers(fixture([]));

  const response = handlers.handle({ method: 'GET', path: '/' });
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /^text\/html/);
  assert.match(response.body.toLowerCase(), /<!doctype html>/);
});
