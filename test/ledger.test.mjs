import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { identityKey } from '../core/guard.mjs';
import {
  STATES,
  appendEvent,
  applyTransition,
  canTransition,
  duplicateOf,
  readStore,
  upsertRecord,
  writeStore,
} from '../core/ledger.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'job-apply-ledger-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const record = (overrides = {}) => ({
  company: 'Acme',
  role: 'Backend Engineer',
  status: 'discovered',
  ...overrides,
});

test('STATES is the frozen, ordered state list', () => {
  assert.deepEqual(STATES, [
    'discovered',
    'scored',
    'shortlisted',
    'resolved',
    'prepared',
    'submitted',
    'interview',
    'rejected',
    'offer',
    'blocked',
    'skipped',
  ]);
  assert.equal(Object.isFrozen(STATES), true);
});

test('every legal edge and every blocked/skipped edge is allowed', () => {
  const edges = [
    ['discovered', 'scored'],
    ['scored', 'shortlisted'],
    ['shortlisted', 'resolved'],
    ['resolved', 'prepared'],
    ['prepared', 'submitted'],
    ['submitted', 'interview'],
    ['submitted', 'rejected'],
    ['submitted', 'offer'],
  ];
  for (const [from, to] of edges) assert.equal(canTransition(from, to), true, `${from} -> ${to}`);

  for (const from of ['discovered', 'scored', 'shortlisted', 'resolved', 'prepared', 'submitted']) {
    assert.equal(canTransition(from, 'blocked'), true, `${from} -> blocked`);
    assert.equal(canTransition(from, 'skipped'), true, `${from} -> skipped`);
  }

  for (const previous of ['discovered', 'scored', 'shortlisted', 'resolved', 'prepared']) {
    assert.equal(canTransition('blocked', previous), true, `blocked -> ${previous}`);
  }
});

test('illegal edges are refused', () => {
  assert.equal(canTransition('prepared', 'offer'), false);
  assert.equal(canTransition('submitted', 'prepared'), false);
  assert.equal(canTransition('not-a-state', 'scored'), false);
  assert.equal(canTransition('scored', 'not-a-state'), false);
  assert.equal(canTransition('blocked', 'submitted'), false);
  assert.equal(canTransition('interview', 'offer'), false);
  assert.equal(canTransition('skipped', 'discovered'), false);
});

test('upsertRecord merges fields without mutating either input', () => {
  const original = record({ score: 7, notes: 'keep me' });
  const records = [original];
  const next = upsertRecord(records, record({ score: 9, channel: 'LinkedIn' }));

  assert.notEqual(next, records);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], original);
  assert.equal(next.length, 1);
  assert.equal(next[0].score, 9);
  assert.equal(next[0].notes, 'keep me');
  assert.equal(next[0].channel, 'LinkedIn');
  assert.notEqual(next[0], original);
});

test('upsertRecord appends a novel identity key', () => {
  const records = [record()];
  const next = upsertRecord(records, record({ role: 'Platform Engineer' }));
  assert.equal(next.length, 2);
  assert.deepEqual(records, [record()]);
});

test('applyTransition throws a message naming both states', () => {
  const current = record({ status: 'prepared' });
  const key = identityKey(current);
  assert.throws(
    () => applyTransition([current], key, 'offer'),
    (error) => {
      assert.match(error.message, /prepared/);
      assert.match(error.message, /offer/);
      return true;
    },
  );
});

test('applyTransition records a blocker and clears it on return', () => {
  const current = record({ status: 'prepared' });
  const key = identityKey(current);

  const blocked = applyTransition([current], key, 'blocked', { reason: 'missing answer' });
  assert.equal(blocked.record.status, 'blocked');
  assert.equal(blocked.record.blockedReason, 'missing answer');
  assert.equal(blocked.record.blockedFrom, 'prepared');
  assert.equal(current.status, 'prepared');

  const resumed = applyTransition(blocked.records, key, blocked.record.blockedFrom);
  assert.equal(resumed.record.status, 'prepared');
  assert.equal(resumed.record.blockedReason, undefined);
  assert.equal(resumed.record.blockedFrom, undefined);
});

test('duplicateOf finds a submitted identity and ignores a blocked one', () => {
  const candidate = record({ role: 'Backend Engineer' });
  const submitted = record({ role: 'Backend Engineer', status: 'submitted' });
  const blocked = record({ role: 'Backend Engineer', status: 'blocked' });

  assert.equal(duplicateOf([blocked], candidate), null);
  assert.deepEqual(duplicateOf([blocked, submitted], candidate), submitted);
  assert.equal(duplicateOf([submitted], record({ role: 'Other' })), null);
});

test('appendEvent requires action and key and appends one timestamped line', () => {
  const events = join(scratch, 'events.jsonl');

  assert.throws(() => appendEvent(events, { key: 'abc' }), /action/);
  assert.throws(() => appendEvent(events, { action: 'applied' }), /key/);

  appendEvent(events, { action: 'applied', key: 'abc', adapter: 'workable' });
  appendEvent(events, { action: 'blocked', key: 'abc', reason: 'missing answer' });

  const lines = readFileSync(events, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].action, 'applied');
  assert.equal(lines[0].key, 'abc');
  assert.match(lines[0].ts, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(lines[1].reason, 'missing answer');
});

test('writeStore keeps key order, record order, and round-trips', () => {
  const path = join(scratch, 'applications.json');
  const records = [
    record({ role: 'First', status: 'submitted' }),
    record({ role: 'Second', status: 'blocked' }),
  ];

  writeStore(path, records);
  const first = readFileSync(path, 'utf8');
  assert.ok(first.endsWith('\n'));
  assert.ok(first.startsWith('{\n  "updated": '));
  assert.deepEqual(Object.keys(JSON.parse(first)), ['updated', 'applications']);
  assert.deepEqual(readStore(path), records);

  writeStore(path, records);
  assert.equal(readFileSync(path, 'utf8'), first);
});
