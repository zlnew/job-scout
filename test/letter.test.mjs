// Cover-letter tests. The template may only say what profile.json supports, and
// lintLetter is the guardrail that proves it: every violation names the offending
// fragment so a letter that drifts out of the facts is caught before it is sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildLetter, lintLetter } from '../lib/letter.mjs';

const profile = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL('../data/profile.json', import.meta.url)), 'utf8'),
);

const posting = {
  title: 'Backend Engineer (Payments)',
  company: 'Ajaib',
  city: 'Jakarta',
  remote: true,
  url: 'https://fungsi.id/backend-engineer-ajaib',
  description: 'Own the payments ledger in Go.',
};

test('letter names the posting role/company and the candidate facts from profile.json', () => {
  const letter = buildLetter(posting, profile, {});
  assert.match(letter, /Backend Engineer \(Payments\)/);
  assert.match(letter, /Ajaib/);
  assert.match(letter, /Maulana Aprizqy Sumaryanto/);
  assert.match(letter, /aprizqymaulana@gmail\.com/);
  assert.match(letter, /1 month/);
  assert.match(letter, /PT Akasanet Bumi Nusantara \(YODU\)/);
});

test('template output passes its own linter, contains no em dash, and clears the word floor', () => {
  const letter = buildLetter(posting, profile, {});
  const lint = lintLetter(letter, profile);
  assert.deepEqual(lint.violations, []);
  assert.equal(lint.ok, true);
  assert.equal(letter.includes('\u2014'), false);
  assert.ok(letter.trim().split(/\s+/).length >= 120);
});

test('a fabricated letter produces at least three violations naming the offending fragment', () => {
  const bad = `Dear Hiring Team,

I have 7 years of Golang experience and I worked at Google for most of it. I am a Senior engineer who also uses Kubernetes and Terraform every day.

Thank you.`;

  const { ok, violations } = lintLetter(bad, profile);
  assert.equal(ok, false);
  assert.ok(violations.length >= 3, `expected >= 3 violations, got ${violations.length}: ${violations.join(' | ')}`);
  assert.ok(violations.some((v) => /7 years/.test(v)), violations.join(' | '));
  assert.ok(violations.some((v) => /Google/.test(v)), violations.join(' | '));
  assert.ok(violations.some((v) => /senior/i.test(v)), violations.join(' | '));
  assert.ok(violations.some((v) => /Kubernetes/.test(v)), violations.join(' | '));
});

test('a short letter fails the length check', () => {
  const short = 'Dear Hiring Team,\n\nI am interested in the role.\n\nSincerely,\nMaulana';
  const { ok, violations } = lintLetter(short, profile);
  assert.equal(ok, false);
  assert.ok(violations.some((v) => /below the 120-word minimum/.test(v)), violations.join(' | '));
});

test('an empty letter is reported as empty', () => {
  const { ok, violations } = lintLetter('   ', profile);
  assert.equal(ok, false);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /empty/);
});
