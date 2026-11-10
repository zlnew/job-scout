import assert from 'node:assert/strict';
import test from 'node:test';
import { CODES, CodedError, fail, ok, reason } from '../core/result.mjs';

// Every code the UI or a CLI is allowed to branch on. A code without a human
// message or without a fix would leave a screen with nothing to say (S2).
const REQUIRED = [
  'session-expired',
  'record-not-found',
  'illegal-transition',
  'blocked-question',
  'required-empty',
  'required-unfilled',
  'optional-unmatched',
  'easy-apply',
  'duplicate-application',
  'provenance-invalid',
  'adapter-unverified',
  'submit-unconfirmed',
  'source-failed',
  'store-corrupt',
  'store-schema',
  'usage',
];

test('every code carries a message and a fix naming an action or command', () => {
  for (const code of REQUIRED) {
    const entry = CODES[code];
    assert.ok(entry, `${code} exists`);
    assert.equal(typeof entry.message, 'string', `${code} has a message`);
    assert.ok(entry.message.length > 0, `${code} message is not empty`);
    assert.equal(typeof entry.fix, 'string', `${code} has a fix`);
    assert.ok(entry.fix.length > 0, `${code} fix is not empty`);
  }
});

test('ok fills the code message and fix and keeps the value', () => {
  const result = ok('prepared', { id: '1' });
  assert.equal(result.ok, true);
  assert.equal(result.code, 'prepared');
  assert.equal(result.message, CODES.prepared.message);
  assert.equal(result.fix, CODES.prepared.fix);
  assert.deepEqual(result.value, { id: '1' });
});

test('fail keeps the coded defaults unless the caller overrides them', () => {
  const plain = fail('record-not-found');
  assert.equal(plain.ok, false);
  assert.equal(plain.code, 'record-not-found');
  assert.equal(plain.message, CODES['record-not-found'].message);
  assert.equal(plain.fix, CODES['record-not-found'].fix);

  const detailed = fail('store-corrupt', { message: 'applications.json is not valid JSON', detail: 'line 1' });
  assert.equal(detailed.message, 'applications.json is not valid JSON');
  assert.equal(detailed.detail, 'line 1');
  assert.equal(detailed.fix, CODES['store-corrupt'].fix);
});

test('reason and CodedError share the same coded shape', () => {
  const entry = reason('blocked-question', { message: 'blocked questions: Religion' });
  assert.deepEqual(entry, {
    code: 'blocked-question',
    message: 'blocked questions: Religion',
    fix: CODES['blocked-question'].fix,
  });

  const error = new CodedError('illegal-transition', { message: 'illegal transition: prepared -> offer' });
  assert.ok(error instanceof Error);
  assert.equal(error.code, 'illegal-transition');
  assert.equal(error.message, 'illegal transition: prepared -> offer');
  assert.deepEqual(error.toResult(), fail('illegal-transition', { message: 'illegal transition: prepared -> offer' }));
});

test('an unknown code fails loudly instead of inventing a message', () => {
  assert.throws(() => fail('not-a-code'), /unknown result code/);
  assert.throws(() => new CodedError('not-a-code'), /unknown result code/);
});
