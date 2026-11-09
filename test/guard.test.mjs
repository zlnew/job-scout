import assert from 'node:assert/strict';
import test from 'node:test';
import { checkSubmission, identityKey } from '../core/guard.mjs';

const reasons = (input) => checkSubmission(input).reasons.join('; ');

test('rule 1: easy-apply is refused', () => {
  const result = checkSubmission({ kind: 'easy-apply' });
  assert.equal(result.ok, false);
  assert.match(reasons({ kind: 'easy-apply' }), /easy-apply/);
});

test('rule 2: missed fields are named', () => {
  const result = checkSubmission({ missed: ['Email', 'Phone'] });
  assert.equal(result.ok, false);
  assert.match(result.reasons.join('; '), /unfilled fields: Email, Phone/);
});

test('rule 3: blank required controls are named', () => {
  const result = checkSubmission({ requiredEmpty: ['resume', 'country'] });
  assert.equal(result.ok, false);
  assert.match(result.reasons.join('; '), /required fields empty: resume, country/);
});

test('rule 4: blocked questions are named', () => {
  const result = checkSubmission({ blockedQuestions: ['Expected salary', 'Birth date'] });
  assert.equal(result.ok, false);
  assert.match(result.reasons.join('; '), /blocked questions: Expected salary, Birth date/);
});

test('rule 5: a prior submitted record with the same identity key is a duplicate', () => {
  const key = identityKey({ company: 'Acme', role: 'Backend Engineer', applyUrl: 'https://acme.test/apply' });
  const priorRecords = [
    { identityKey: key, status: 'prepared' },
    { identityKey: key, status: 'submitted' },
  ];
  const result = checkSubmission({ identityKey: key, priorRecords });
  assert.equal(result.ok, false);
  assert.match(result.reasons.join('; '), /duplicate application/);

  assert.equal(checkSubmission({ identityKey: key, priorRecords: [{ identityKey: key, status: 'prepared' }] }).ok, true);
});

test('rule 6: answers without confirmed/derived provenance are refused', () => {
  const missing = checkSubmission({ answers: { identity: { email: { value: 'a@b.c', scope: 'all' } } } });
  assert.equal(missing.ok, false);
  assert.match(missing.reasons.join('; '), /answer without provenance: identity\.email/);

  const assumed = checkSubmission({
    answers: { work: { relocate: { value: false, source: 'assumed', scope: 'all' } } },
  });
  assert.equal(assumed.ok, false);
  assert.match(assumed.reasons.join('; '), /answer without provenance: work\.relocate/);

  const valid = checkSubmission({
    answers: {
      identity: { email: { value: 'a@b.c', source: 'confirmed', scope: 'all' } },
      skills: { value: ['Go'], source: 'derived', scope: 'all' },
    },
  });
  assert.equal(valid.ok, true);
});

test('rule 1-6 together produce one reason each and ok is false', () => {
  const key = identityKey({ company: 'Acme', role: 'Backend Engineer', applyUrl: null });
  const result = checkSubmission({
    kind: 'easy-apply',
    missed: ['Email'],
    requiredEmpty: ['resume'],
    blockedQuestions: ['Gender'],
    identityKey: key,
    priorRecords: [{ identityKey: key, status: 'submitted' }],
    answers: { identity: { email: { value: 'a@b.c', scope: 'all' } } },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reasons.length, 6);
});

test('identityKey ignores case and whitespace and stays stable across runs', () => {
  const base = identityKey({ company: 'Acme Corp', role: 'Backend Engineer', applyUrl: 'https://acme.test/apply', linkedinId: '123' });
  const noisy = identityKey({ company: '  acme   corp ', role: 'BACKEND   engineer', applyUrl: ' HTTPS://ACME.TEST/APPLY ', linkedinId: ' 123 ' });

  assert.equal(base, noisy);
  assert.equal(base, identityKey({ company: 'Acme Corp', role: 'Backend Engineer', applyUrl: 'https://acme.test/apply', linkedinId: '123' }));
  assert.match(base, /^[0-9a-f]{40}$/);
});

test('identityKey separates different apply urls and tolerates a null one', () => {
  const a = identityKey({ company: 'Acme', role: 'Backend Engineer', applyUrl: 'https://acme.test/a' });
  const b = identityKey({ company: 'Acme', role: 'Backend Engineer', applyUrl: 'https://acme.test/b' });
  assert.notEqual(a, b);
  assert.match(identityKey({ company: 'Acme', role: 'Backend Engineer', applyUrl: null }), /^[0-9a-f]{40}$/);
});
