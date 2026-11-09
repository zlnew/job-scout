/**
 * Application ledger: the state machine, idempotent upsert, and the append-only
 * event log. Pure functions keep every rule testable; the small fs wrappers
 * only serialise the same shapes.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { identityKey } from './guard.mjs';

export const STATES = Object.freeze([
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

// `submitted` is the point of no return: it can only move forward to an
// outcome. `blocked` may return to a pre-submission state once the blocker is
// cleared; `applyTransition` checks the recorded source state for that.
const NEXT = Object.freeze({
  discovered: Object.freeze(['scored', 'blocked', 'skipped']),
  scored: Object.freeze(['shortlisted', 'blocked', 'skipped']),
  shortlisted: Object.freeze(['resolved', 'blocked', 'skipped']),
  resolved: Object.freeze(['prepared', 'blocked', 'skipped']),
  prepared: Object.freeze(['submitted', 'blocked', 'skipped']),
  submitted: Object.freeze(['interview', 'rejected', 'offer', 'blocked', 'skipped']),
  blocked: Object.freeze(['discovered', 'scored', 'shortlisted', 'resolved', 'prepared']),
  interview: Object.freeze([]),
  rejected: Object.freeze([]),
  offer: Object.freeze([]),
  skipped: Object.freeze([]),
});

const DUPLICATE_STATES = new Set(['submitted', 'interview', 'offer']);

const keyOf = (record) => record?.identityKey ?? identityKey(record);

export function canTransition(from, to) {
  return Boolean(NEXT[from]?.includes(to));
}

/**
 * Insert or merge one record, matched by the guard's identity key. Existing
 * records keep their position and unknown fields; the input array is untouched.
 */
export function upsertRecord(records, record) {
  const incoming = keyOf(record);
  const index = records.findIndex((existing) => keyOf(existing) === incoming);
  if (index === -1) return [...records, { ...record }];

  const next = [...records];
  next[index] = { ...records[index], ...record };
  return next;
}

function transitionError(from, to) {
  const known = STATES.includes(from) ? '' : ` (unknown state "${from}")`;
  return new Error(`illegal transition: ${from} -> ${to}${known}`);
}

/**
 * Move the record identified by `key` to `to`. `extra` is merged into the
 * record, so a blocked/skipped reason lives beside the state it explains.
 * An illegal edge throws, which is what stops a double submission.
 */
export function applyTransition(records, key, to, extra = {}) {
  const index = records.findIndex((record) => keyOf(record) === key);
  if (index === -1) throw new Error(`no record with identity key ${key}`);

  const current = records[index];
  const from = current.status;
  if (!canTransition(from, to)) throw transitionError(from, to);

  // A blocked record may only resume the exact state it was blocked from.
  if (from === 'blocked' && current.blockedFrom && current.blockedFrom !== to) {
    throw new Error(`illegal transition: blocked -> ${to} (blocked from ${current.blockedFrom})`);
  }

  const next = { ...current, ...extra, status: to };

  if (to === 'blocked') {
    next.blockedFrom = from;
    if (extra.reason !== undefined && next.blockedReason === undefined) next.blockedReason = extra.reason;
  } else {
    delete next.blockedFrom;
    delete next.blockedReason;
  }
  if (to === 'skipped' && extra.reason !== undefined && next.skippedReason === undefined) {
    next.skippedReason = extra.reason;
  }

  const copy = [...records];
  copy[index] = next;
  return { records: copy, record: next };
}

/** The already-applied record for this candidate, or null when it is novel. */
export function duplicateOf(records, candidate) {
  const incoming = keyOf(candidate);
  return records.find((record) => DUPLICATE_STATES.has(record.status) && keyOf(record) === incoming) ?? null;
}

export function readStore(path) {
  const store = JSON.parse(readFileSync(path, 'utf8'));
  if (Array.isArray(store)) return store;
  return store.applications ?? [];
}

/** 2-space JSON with `updated` first and one trailing newline; record order is preserved. */
export function writeStore(path, records) {
  const store = { updated: new Date().toISOString().slice(0, 10), applications: records };
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`);
}

/** Append one audit line. `action` and `key` are required; `ts` is filled in. */
export function appendEvent(eventsPath, event) {
  if (!event || typeof event !== 'object') throw new Error('event must be an object');
  for (const field of ['action', 'key']) {
    if (!Object.hasOwn(event, field) || event[field] === undefined || event[field] === null || event[field] === '') {
      throw new Error(`event is missing required "${field}"`);
    }
  }

  const line = { ...event, ts: event.ts ?? new Date().toISOString() };
  appendFileSync(eventsPath, `${JSON.stringify(line)}\n`);
  return line;
}
