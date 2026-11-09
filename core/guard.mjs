/**
 * Submission invariants. Pure and I/O-free apart from loading a profile file,
 * so every rule can be tested without a browser.
 *
 * S2: an answer is only usable when it carries provenance. There is no
 * `assumed` source — an answer without provenance blocks the submission.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

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
      throw new Error(`profile answer "${key}" uses the forbidden source "assumed"`);
    }
    if (!VALID_SOURCES.has(source)) {
      throw new Error(
        `profile answer "${key}" has invalid source ${JSON.stringify(source ?? null)}; expected "confirmed" or "derived"`,
      );
    }
  }
}

/** Parse and validate data/profile.json. Throws naming the offending key. */
export function loadProfile(path) {
  const profile = JSON.parse(readFileSync(path, 'utf8'));
  assertProvenance(profile);
  return profile;
}

/**
 * Refuse a submission that a human has not been able to verify.
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

  if (kind === 'easy-apply') {
    reasons.push('easy-apply is never automated: LinkedIn Easy Apply stays manual because it risks the account');
  }
  if (missed.length > 0) reasons.push(`unfilled fields: ${missed.join(', ')}`);
  if (requiredEmpty.length > 0) reasons.push(`required fields empty: ${requiredEmpty.join(', ')}`);
  if (blockedQuestions.length > 0) reasons.push(`blocked questions: ${blockedQuestions.join(', ')}`);

  if (key && priorRecords.some((record) => record?.identityKey === key && record?.status === 'submitted')) {
    reasons.push(`duplicate application: identity ${key} is already submitted`);
  }

  if (answers) {
    for (const { key: answerKey, source } of answerLeaves(answers)) {
      if (!VALID_SOURCES.has(source)) {
        reasons.push(`answer without provenance: ${answerKey} (source ${JSON.stringify(source ?? null)})`);
      }
    }
  }

  return { ok: reasons.length === 0, reasons };
}

const normalise = (value) => String(value ?? '').toLowerCase().replaceAll(/\s+/g, ' ').trim();

/**
 * Stable idempotency key for one posting. Case and whitespace are ignored so
 * the same employer/role yields the same key across sweeps and runs.
 */
export function identityKey({ company = '', role = '', applyUrl = null, linkedinId = null } = {}) {
  const parts = [normalise(company), normalise(role), normalise(applyUrl), normalise(linkedinId)];
  return createHash('sha1').update(parts.join('|')).digest('hex');
}
