import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { after } from 'node:test';
import { identityKey, loadProfile } from '../core/guard.mjs';
import { appendRevision } from '../core/letters.mjs';
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
    lettersRoot: join(dir, 'letters'),
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

// ---- new screens ---------------------------------------------------------

const daysAgo = (days) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

const writeEvents = (paths, events) => {
  writeFileSync(paths.eventsPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
};

test('/api/today lists a blocked record and a submitted record whose follow-up is due', () => {
  const blocked = record({ company: 'Blocked Co', status: 'blocked', blockedReason: 'screening question has no usable answer', linkedinId: '11' });
  const due = record({ company: 'Due Co', status: 'submitted', applied: daysAgo(10), linkedinId: '12' });
  const fresh = record({ company: 'Fresh Co', status: 'submitted', applied: daysAgo(1), linkedinId: '13' });
  const paths = fixture([blocked, due, fresh]);
  const handlers = createHandlers(paths);

  const response = handlers.handle({ method: 'GET', path: '/api/today' });
  assert.equal(response.status, 200);
  const today = JSON.parse(response.body);
  assert.ok(today.needsYou.some((row) => row.company === 'Blocked Co' && row.kind === 'blocked'));
  assert.ok(today.needsYou.every((row) => row.action && row.action.label), 'every need carries one action');
  assert.deepEqual(today.followUpsDue.map((row) => row.company), ['Due Co']);
  assert.ok(!today.followUpsDue.some((row) => row.company === 'Fresh Co'), 'a recent submit is not due yet');
  assert.ok(Array.isArray(today.sessions) && today.sessions.length > 0, 'session health is part of Today');
  assert.ok(Array.isArray(today.recent));
});

test('/api/postings filters by score and status and keeps score arithmetic in each row', () => {
  const paths = fixture([
    record({ company: 'High', status: 'shortlisted', score: 9, posted: '2026-01-02' }),
    record({ company: 'Low', status: 'shortlisted', score: 4, posted: '2026-01-01', notes: 'IT vendor (-1)' }),
    record({ company: 'Unscored', status: 'discovered', score: null, posted: '2026-01-03' }),
    record({ company: 'Sent', status: 'submitted', score: 7, applied: '2026-01-01' }),
  ]);
  const handlers = createHandlers(paths);

  const filtered = handlers.handle({ method: 'GET', path: '/api/postings?minScore=7' });
  assert.equal(filtered.status, 200);
  const high = JSON.parse(filtered.body);
  assert.deepEqual(high.rows.map((row) => row.company), ['High', 'Sent']);

  const byStatus = JSON.parse(handlers.handle({ method: 'GET', path: '/api/postings?status=shortlisted' }).body);
  assert.deepEqual(byStatus.rows.map((row) => row.company), ['High', 'Low']);
  assert.equal(byStatus.sources.length, 1);
  assert.equal(byStatus.counts.submitted, 1);

  const low = byStatus.rows.find((row) => row.company === 'Low');
  assert.deepEqual(low.scoreBreakdown.chips[0], { label: 'IT vendor', points: -1, source: 'notes' });
  assert.equal(low.scoreBreakdown.equals, true, 'the other chip names the remainder so the arithmetic adds up');
  assert.equal(low.scoreBreakdown.total, 4, 'the visible arithmetic adds up to the stored score');
  assert.equal(low.scoreBreakdown.chips.at(-1).label, 'other recorded points');
  assert.equal(low.scoreBreakdown.chips.at(-1).points, 5);
  for (const row of byStatus.rows) assert.ok(Array.isArray(row.scoreBreakdown.chips), 'every row carries its arithmetic');
});

test('/api/application returns ordered timeline, answers with provenance, and the current letter', () => {
  const target = record({ company: 'Acme', role: 'Backend Engineer', status: 'submitted', applied: '2026-11-01', linkedinId: '321' });
  const key = target.identityKey;
  const paths = fixture([target]);
  writeEvents(paths, [
    { action: 'prepared', key, ts: '2026-11-01T08:00:00.000Z' },
    { action: 'applied', key, ts: '2026-11-01T09:00:00.000Z', screenshot: 'screenshots/acme.png', letterRevision: 1 },
  ]);
  appendRevision(key, { text: 'Dear team', origin: 'generated' }, { root: paths.lettersRoot, company: 'Acme', role: 'Backend Engineer' });
  const handlers = createHandlers(paths);

  const response = handlers.handle({ method: 'GET', path: `/api/application/${key}` });
  assert.equal(response.status, 200);
  const detail = JSON.parse(response.body);
  assert.deepEqual(detail.timeline.map((step) => step.action), ['prepared', 'applied']);
  assert.equal(detail.timeline.at(-1).evidence.letterRevision, 1);
  assert.ok(detail.answers.length > 0);
  for (const answer of detail.answers) {
    assert.ok(['confirmed', 'derived'].includes(answer.provenance.kind));
    assert.match(answer.provenance.text, /confirmed by Maul|derived from career\.json/);
  }
  assert.equal(detail.letter.current.revision, 1);
  assert.equal(detail.letter.current.text, 'Dear team');
  assert.equal(detail.letter.revisions.length, 1);
  assert.equal(detail.lastRun.action, 'applied');
  assert.ok(Array.isArray(detail.lastRun.refusals));
});

test('POST /api/letter appends an edited revision and GET returns the new current', () => {
  const target = record({ company: 'Acme', status: 'shortlisted', linkedinId: '654' });
  const key = target.identityKey;
  const paths = fixture([target]);
  appendRevision(key, { text: 'Dear team', origin: 'generated' }, { root: paths.lettersRoot, company: 'Acme' });
  const handlers = createHandlers(paths);

  const rejected = handlers.handle({ method: 'POST', path: `/api/letter/${key}`, body: { text: '   ' } });
  assert.equal(rejected.status, 400);
  const refused = JSON.parse(rejected.body);
  assert.equal(refused.code, 'letter-empty');
  assert.equal(typeof refused.message, 'string');
  assert.equal(typeof refused.fix, 'string');

  const saved = handlers.handle({ method: 'POST', path: `/api/letter/${key}`, body: { text: 'Dear team, edited', note: 'tightened' } });
  assert.equal(saved.status, 201);
  assert.equal(JSON.parse(saved.body).revision, 2);

  const current = JSON.parse(handlers.handle({ method: 'GET', path: `/api/letter/${key}` }).body);
  assert.equal(current.current, 2);
  assert.equal(current.text, 'Dear team, edited');
  assert.equal(current.revisions.length, 2);
  assert.equal(current.revisions.at(-1).origin, 'edited');
  assert.equal(current.revisions.at(-1).note, 'tightened');
});

test('unknown application and letter keys return 404 with code, message, and fix', () => {
  const handlers = createHandlers(fixture([]));
  for (const path of ['/api/application/missing-key', '/api/letter/missing-key']) {
    const response = handlers.handle({ method: 'GET', path });
    assert.equal(response.status, 404);
    const body = JSON.parse(response.body);
    assert.equal(body.code, 'record-not-found');
    assert.equal(typeof body.message, 'string');
    assert.equal(typeof body.fix, 'string');
  }
});

test('/api/stream writes frames for a job transition', async () => {
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => child.emit('close', 0));
    return child;
  };
  const target = record({ company: 'Acme', status: 'prepared', linkedinId: '999' });
  const paths = fixture([target]);
  const handlers = createHandlers({ ...paths, spawn });

  const frames = [];
  const headers = [];
  handlers.openStream({
    writeHead: (status, values) => headers.push({ status, values }),
    write: (frame) => frames.push(String(frame)),
    on: () => {},
  });

  const started = handlers.handle({ method: 'POST', path: '/api/prepare', body: { id: '999' } });
  assert.equal(started.status, 202);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));

  assert.equal(headers[0].status, 200);
  assert.match(headers[0].values['content-type'], /^text\/event-stream/);
  assert.ok(frames.some((frame) => frame.includes('event: hello')));
  assert.ok(frames.some((frame) => frame.includes('event: job')));
  assert.ok(frames.some((frame) => frame.includes('"state":"done"')), 'the finished job is pushed, not polled');
});
