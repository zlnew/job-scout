import assert from 'node:assert/strict';
import test from 'node:test';
import { checkSubmission, identityKey } from '../core/guard.mjs';

// Reasons are objects now (S5). Tests read `.message` to pin the human prose and
// `.code` to pin what the UI branches on; neither may drift on its own.
const messages = (input) => checkSubmission(input).reasons.map((entry) => entry.message).join('; ');
const codes = (input) => checkSubmission(input).reasons.map((entry) => entry.code);

test('rule 1: easy-apply is refused', () => {
  const result = checkSubmission({ kind: 'easy-apply' });
  assert.equal(result.ok, false);
  assert.deepEqual(codes({ kind: 'easy-apply' }), ['easy-apply']);
  assert.match(messages({ kind: 'easy-apply' }), /easy-apply/);
  assert.match(result.reasons[0].fix, /by hand/);
});

test('rule 2: missed fields are named', () => {
  const result = checkSubmission({ missed: ['Email', 'Phone'] });
  assert.equal(result.ok, false);
  assert.deepEqual(codes({ missed: ['Email', 'Phone'] }), ['required-unfilled']);
  assert.match(messages({ missed: ['Email', 'Phone'] }), /unfilled fields: Email, Phone/);
});

test('rule 2: an object miss marked required still refuses and warns about nothing', () => {
  const result = checkSubmission({ missed: [{ field: 'Email', required: true }] });
  assert.equal(result.ok, false);
  assert.match(messages({ missed: [{ field: 'Email', required: true }] }), /unfilled fields: Email/);
  assert.deepEqual(result.warnings, []);
});

test('rule 2: an optional unmatched control warns and does not refuse', () => {
  const result = checkSubmission({ missed: [{ field: 'Job Vacancy to Apply', required: false }] });
  assert.equal(result.ok, true);
  assert.equal(result.code, undefined);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.warnings[0].code, 'optional-unmatched');
  assert.match(result.warnings.map((entry) => entry.message).join('; '), /Job Vacancy to Apply/);
});

test('rule 2: a legacy bare-string miss stays required, never permissive', () => {
  const result = checkSubmission({ missed: ['Job Vacancy to Apply'] });
  assert.equal(result.ok, false);
  assert.match(result.reasons.map((entry) => entry.message).join('; '), /unfilled fields: Job Vacancy to Apply/);
  assert.deepEqual(result.warnings, []);
});

test('rule 2: mixed misses refuse for the required one and warn about the optional one', () => {
  const result = checkSubmission({
    missed: [{ field: 'Email', required: true }, { field: 'Job Vacancy to Apply', required: false }],
  });
  assert.equal(result.ok, false);
  assert.match(result.reasons.map((entry) => entry.message).join('; '), /unfilled fields: Email$/);
  assert.match(result.warnings.map((entry) => entry.message).join('; '), /unmatched optional fields: Job Vacancy to Apply/);
});

test('rule 3: blank required controls are named', () => {
  const result = checkSubmission({ requiredEmpty: ['resume', 'country'] });
  assert.equal(result.ok, false);
  assert.deepEqual(result.reasons.map((entry) => entry.code), ['required-empty']);
  assert.match(result.reasons.map((entry) => entry.message).join('; '), /required fields empty: resume, country/);
  assert.match(result.reasons[0].fix, /fill/);
});

test('rule 4: blocked questions are named', () => {
  const result = checkSubmission({ blockedQuestions: ['Expected salary', 'Birth date'] });
  assert.equal(result.ok, false);
  assert.deepEqual(result.reasons.map((entry) => entry.code), ['blocked-question']);
  assert.match(result.reasons.map((entry) => entry.message).join('; '), /blocked questions: Expected salary, Birth date/);
  assert.match(result.reasons[0].fix, /blocked topic/);
});

test('rule 5: a prior submitted record with the same identity key is a duplicate', () => {
  const key = identityKey({ company: 'Acme', role: 'Backend Engineer', applyUrl: 'https://acme.test/apply' });
  const priorRecords = [
    { identityKey: key, status: 'prepared' },
    { identityKey: key, status: 'submitted' },
  ];
  const result = checkSubmission({ identityKey: key, priorRecords });
  assert.equal(result.ok, false);
  assert.deepEqual(result.reasons.map((entry) => entry.code), ['duplicate-application']);
  assert.match(result.reasons.map((entry) => entry.message).join('; '), /duplicate application/);
  assert.match(result.reasons[0].fix, /Postings/);

  assert.equal(checkSubmission({ identityKey: key, priorRecords: [{ identityKey: key, status: 'prepared' }] }).ok, true);
});

test('rule 6: answers without confirmed/derived provenance are refused', () => {
  const missing = checkSubmission({ answers: { identity: { email: { value: 'a@b.c', scope: 'all' } } } });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.reasons.map((entry) => entry.code), ['provenance-invalid']);
  assert.match(missing.reasons.map((entry) => entry.message).join('; '), /answer without provenance: identity\.email/);
  assert.equal(missing.reasons[0].field, 'identity.email');

  const assumed = checkSubmission({
    answers: { work: { relocate: { value: false, source: 'assumed', scope: 'all' } } },
  });
  assert.equal(assumed.ok, false);
  assert.deepEqual(assumed.reasons.map((entry) => entry.code), ['provenance-invalid']);
  assert.match(assumed.reasons.map((entry) => entry.message).join('; '), /work\.relocate.*assumed/);
});

test('rule 7: a clean submission is ok with no code and no reasons', () => {
  const result = checkSubmission({ missed: [], requiredEmpty: [], blockedQuestions: [], priorRecords: [] });
  assert.deepEqual(result, { ok: true, code: undefined, reasons: [], warnings: [] });
});

test('every refusal reason carries the field, message and fix the UI renders', () => {
  const result = checkSubmission({
    kind: 'easy-apply',
    missed: ['Email'],
    requiredEmpty: ['resume'],
    blockedQuestions: ['Religion'],
    identityKey: 'k',
    priorRecords: [{ identityKey: 'k', status: 'submitted' }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, result.reasons[0].code);
  assert.equal(result.reasons.length, 5);
  for (const reason of result.reasons) {
    assert.equal(typeof reason.code, 'string');
    assert.ok(reason.message.length > 0);
    assert.ok(reason.fix.length > 0);
  }
});
