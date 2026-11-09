import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import generic from '../adapters/generic.mjs';
import { describe, resolveQuestion, SCREENING } from '../core/screening.mjs';
import { loadProfile } from '../core/guard.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const PROFILE = loadProfile(join(ROOT, 'data/profile.json'));
const BANK = readFileSync(join(ROOT, 'data/screening.md'), 'utf8');
const SCRATCH = mkdtempSync(join(tmpdir(), 'screening-'));

test.after(() => rmSync(SCRATCH, { recursive: true, force: true }));

/** Does a dotted/bracketed path reach a value? Mirrors the registry's traversal. */
function hasLeaf(profile, path) {
  const steps = path.split(/\.|\[(\d+)\]/).filter((step) => step !== '' && step !== undefined);
  let node = profile;
  for (const step of steps) {
    if (node && typeof node === 'object' && Object.hasOwn(node, 'value')) node = node.value;
    if (node === null || node === undefined) return false;
    node = node[step];
  }
  return node !== undefined;
}

test('a confirmed or derived key resolves to an answer', () => {
  const result = resolveQuestion('Notice Period', PROFILE);

  assert.equal(result.status, 'answer');
  assert.equal(result.key, 'work.noticePeriod');
  assert.equal(result.value, '1 month');
});

test('blockedTopics keys resolve to blocked, never to a value', () => {
  const birthDate = resolveQuestion('Birth Date', PROFILE);
  assert.equal(birthDate.status, 'answer', 'an answered question resolves to a value');
  assert.equal(birthDate.value, '2002-04-03');

  const gender = resolveQuestion('Gender', PROFILE);
  assert.equal(gender.status, 'answer', 'a confirmed EEO answer resolves to a value');
  assert.equal(gender.value, 'Male');

  const disability = resolveQuestion('Disability Status', PROFILE);
  assert.equal(disability.status, 'blocked');
  assert.equal(disability.key, 'answers.disabilityStatus');
  assert.match(disability.reason, /no answer/i);

  const expected = resolveQuestion('Expected monthly salary', PROFILE);
  assert.equal(expected.status, 'blocked');
  assert.equal(expected.key, 'answers.expectedSalaryNumeric');
  assert.equal('value' in expected, false, 'a blocked question carries no value');
});

test('a label the registry does not know is unknown, not guessed', () => {
  const result = resolveQuestion('What is your favourite colour?', PROFILE);

  assert.equal(result.status, 'unknown');
  assert.match(result.reason, /no screening rule matches/);
  assert.equal('value' in result, false);
});

test('a profile leaf with an unusable source resolves to blocked', () => {
  const path = join(SCRATCH, 'junk-profile.json');
  writeFileSync(
    path,
    JSON.stringify({
      work: { noticePeriod: { value: '1 month', source: 'assumed', scope: 'all' } },
      blockedTopics: [],
    }),
  );
  const profile = JSON.parse(readFileSync(path, 'utf8'));

  const result = resolveQuestion('Notice Period', profile);

  assert.equal(result.status, 'blocked');
  assert.equal(result.key, 'work.noticePeriod');
  assert.match(result.reason, /"assumed".*not confirmed or derived/);
  assert.equal('value' in result, false);
});

test('describe lists the open questions and drops resolved ones', () => {
  const gaps = describe(PROFILE);
  const keys = gaps.map((gap) => gap.key);

  assert.ok(!keys.includes('answers.birthDate'), 'an answered question is no longer a gap');
  assert.ok(keys.includes('answers.expectedSalaryNumeric'), 'expected salary is still open');
  assert.ok(keys.includes('answers.expectedSalaryNumeric'), 'expected salary is still open');
  assert.ok(!keys.includes('work.noticePeriod'), 'a resolved answer is not a gap');

  for (const gap of gaps) {
    assert.equal(typeof gap.label, 'string');
    assert.equal(typeof gap.key, 'string');
    assert.equal(typeof gap.reason, 'string');
    assert.ok(['blocked', 'unknown'].includes(gap.status));
  }

  // The answer bank is generated from describe(), so every open question has to
  // be in it with the keys a human must fill.
  for (const gap of gaps) {
    assert.ok(BANK.includes(`## ${gap.label}`), `${gap.label} is in data/screening.md`);
    assert.ok(BANK.includes(`\`${gap.key}\``), `${gap.key} is in data/screening.md`);
  }

  // And nothing stale may remain: a resolved question must drop out of the bank.
  const headings = [...BANK.matchAll(/^## (.+)$/gm)].map((match) => match[1].trim());
  assert.deepEqual(headings.sort(), gaps.map((gap) => gap.label).sort(), 'data/screening.md matches describe()');
});

test('every registry key exists in the profile or is a blocked topic', () => {
  const blocked = new Set((PROFILE.blockedTopics ?? []).map((entry) => entry.key));

  for (const entry of SCREENING) {
    assert.ok(
      blocked.has(entry.key) || hasLeaf(PROFILE, entry.key),
      `${entry.key} is a real profile path or a blocked topic (no typos in the registry)`,
    );
  }
});

test('the generic adapter routes recognised questions through the registry', () => {
  const map = generic.buildMap(PROFILE, { controls: ['Notice Period', 'Birth Date', 'Disability Status'] });

  assert.deepEqual(
    map.fields,
    { 'Notice Period': '1 month', 'Birth Date': '2002-04-03' },
    'only answers with provenance are filled',
  );
  assert.deepEqual(map.blocked, [], 'the generic adapter never auto-submits, so blocked stays implicit');
  assert.deepEqual(map.questions.map((question) => question.key), ['unrecognisedControls']);
  assert.match(map.questions[0].reason, /Disability Status .*disabilityStatus/, 'the blocked question is named in the reason');
});
