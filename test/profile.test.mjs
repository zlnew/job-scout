import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { loadProfile } from '../core/guard.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const PROFILE = join(ROOT, 'data/profile.json');

/** Every answer node is an object with a `value`; its payload is plain data. */
function* answerLeaves(node, path = '') {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) yield* answerLeaves(node[i], `${path}[${i}]`);
    return;
  }
  if (!node || typeof node !== 'object') return;
  if (Object.hasOwn(node, 'value')) {
    yield { key: path, node };
    return;
  }
  for (const [key, child] of Object.entries(node)) {
    yield* answerLeaves(child, path ? `${path}.${key}` : key);
  }
}

const profile = loadProfile(PROFILE);

test('every answer leaf carries a valid source and none is assumed', () => {
  let count = 0;
  for (const { key, node } of answerLeaves(profile)) {
    count += 1;
    assert.ok(['confirmed', 'derived'].includes(node.source), `${key} has source ${JSON.stringify(node.source)}`);
    assert.notEqual(node.source, 'assumed', `${key} must not be assumed`);
    assert.equal(node.scope, 'all', `${key} has an explicit scope`);
  }
  assert.ok(count > 20, 'the profile is non-trivial');
});

test('blockedTopics names the numeric salary and EEO questions with no provenance', () => {
  const blocked = new Set(profile.blockedTopics.map((entry) => entry.key));
  for (const key of ['answers.expectedSalaryNumeric', 'answers.salaryHistory', 'answers.gender', 'answers.religion', 'answers.maritalStatus', 'answers.disabilityStatus']) {
    assert.ok(blocked.has(key), `${key} is blocked`);
  }
  for (const entry of profile.blockedTopics) {
    assert.equal(typeof entry.reason, 'string', `${entry.key} explains why it is blocked`);
  }
});

test('meta names both generation sources', () => {
  assert.deepEqual(profile.meta.generatedFrom, [
    'job-apply/answers.md',
    'repo/neo-portfolio/content/career.json',
  ]);
  assert.equal(profile.meta.generatedAt, '2026-11-09');
});

test('loadProfile throws naming the leaf when a source is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'profile-'));
  const path = join(dir, 'missing-source.json');
  writeFileSync(path, JSON.stringify({ identity: { email: { value: 'x', scope: 'all' } } }));

  assert.throws(() => loadProfile(path), /identity\.email.*invalid source/);
});

test('loadProfile throws naming the leaf when a source is assumed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'profile-'));
  const path = join(dir, 'assumed.json');
  writeFileSync(path, JSON.stringify({ work: { relocate: { value: false, source: 'assumed', scope: 'all' } } }));

  assert.throws(() => loadProfile(path), /work\.relocate.*assumed/);
});
