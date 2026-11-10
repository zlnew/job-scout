/**
 * Submission invariants. Pure and I/O-free apart from loading a profile file,
 * so every rule can be tested without a browser.
 *
 * S2: an answer is only usable when it carries provenance. There is no
 * `assumed` source — an answer without provenance blocks the submission.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CodedError, reason } from './result.mjs';

const VALID_SOURCES = new Set(['confirmed', 'derived']);

/** Walk a profile and yield every `{ value, source }` answer with its dotted key. */
function* answerLeaves(node, path = '') {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) yield* answerLeaves(node[i], `${path}[${i}]`);
    return;
  }
  if (!node || typeof node !== 'object') return;

  if (Object.hasOwn(node, 'value')) {
    yield { key: path || 'profile', source: node.source };
    return; // the value payload is data, not another answer
  }
  for (const [key, child] of Object.entries(node)) {
    yield* answerLeaves(child, path ? `${path}.${key}` : key);
  }
}

function assertProvenance(profile) {
  for (const { key, source } of answerLeaves(profile)) {
    if (source === 'assumed') {
      throw new CodedError('provenance-invalid', {
        message: `profile answer "${key}" uses the forbidden source "assumed"`,
        detail: key,
      });
    }
    if (!VALID_SOURCES.has(source)) {
      throw new CodedError('provenance-invalid', {
        message: `profile answer "${key}" has invalid source ${JSON.stringify(source ?? null)}; expected "confirmed" or "derived"`,
        detail: key,
      });
    }
  }
}

/** Parse and validate data/profile.json. Throws naming the offending key. */
export function loadProfile(path) {
  const profile = JSON.parse(readFileSync(path, 'utf8'));
  assertProvenance(profile);
  return profile;
}

/** Split `missed` into the entries the form requires and the ones it does not.
 * `fillForm` sends `{ field, required }`; older callers send bare labels, and a
 * bare label carries no proof of being optional, so it stays required.
 */
function splitMissed(missed) {
  const required = [];
  const optional = [];
  for (const entry of missed) {
    const field = typeof entry === 'string' ? entry : String(entry?.field ?? '');
    if (typeof entry !== 'string' && entry?.required === false) optional.push(field);
    else required.push(field);
  }
  return { required, optional };
}

/**
 * Refuse a submission that a human has not been able to verify.
 *
 * `reasons` refuse and carry a stable code; `warnings` record optional controls
 * the map could not fill and never change `ok`.
 *
 * `answers` is optional: callers that have no provenance-carrying map (the
 * plain `--fields` CLI) omit it instead of passing raw values, which would
 * fail every time by design.
 */
export function checkSubmission({
  kind = 'ats',
  identityKey: key = null,
  priorRecords = [],
  missed = [],
  requiredEmpty = [],
  blockedQuestions = [],
  answers = null,
} = {}) {
  const reasons = [];
  const warnings = [];

  const missedFields = splitMissed(missed);

  if (kind === 'easy-apply') {
    reasons.push(reason('easy-apply', {
      message: 'easy-apply is never automated: LinkedIn Easy Apply stays manual because it risks the account',
    }));
  }
  if (missedFields.required.length > 0) {
    reasons.push(reason('required-unfilled', { message: `unfilled fields: ${missedFields.required.join(', ')}` }));
  }
  // An optional control the map could not fill is worth a human look, but it
  // never blocks a submission the form would accept without it.
  if (missedFields.optional.length > 0) {
    warnings.push(reason('optional-unmatched', { message: `unmatched optional fields: ${missedFields.optional.join(', ')}` }));
  }
  if (requiredEmpty.length > 0) {
    reasons.push(reason('required-empty', { message: `required fields empty: ${requiredEmpty.join(', ')}` }));
  }
  if (blockedQuestions.length > 0) {
    reasons.push(reason('blocked-question', { message: `blocked questions: ${blockedQuestions.join(', ')}` }));
  }

  if (key && priorRecords.some((record) => record?.identityKey === key && record?.status === 'submitted')) {
    reasons.push(reason('duplicate-application', { message: `duplicate application: identity ${key} is already submitted` }));
  }

  if (answers) {
    for (const { key: answerKey, source } of answerLeaves(answers)) {
      if (!VALID_SOURCES.has(source)) {
        reasons.push(reason('provenance-invalid', {
          message: `answer without provenance: ${answerKey} (source ${JSON.stringify(source ?? null)})`,
          field: answerKey,
        }));
      }
    }
  }

  return { ok: reasons.length === 0, code: reasons[0]?.code, reasons, warnings };
}

const normalise = (value) => String(value ?? '').toLowerCase().replaceAll(/\s+/g, ' ').trim();

/**
 * Stable idempotency key for one posting. Case and whitespace are ignored so
 * the same employer/role yields the same key across sweeps and runs.
 */
/**
 * One key per real application. `source` is deliberately excluded: a posting seen on two
 * boards must stay one record (boards/index.mjs dedupes first), and a board's own job URL is
 * stable across re-scans.
 */
export function identityKey({ company = '', role = '', applyUrl = null, linkedinId = null } = {}) {
  const parts = [normalise(company), normalise(role), normalise(applyUrl), normalise(linkedinId)];
  return createHash('sha1').update(parts.join('|')).digest('hex');
}
