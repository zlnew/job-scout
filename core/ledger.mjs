/**
 * Application ledger: the state machine, idempotent upsert, and the append-only
 * event log. Pure functions keep every rule testable; the small fs wrappers
 * only serialise the same shapes.
 */
import { appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { identityKey } from './guard.mjs';
import { CodedError } from './result.mjs';
import { SCHEMA_VERSION, readJson, migrate, backupBeforeWrite, writeJsonAtomic, writeJsonSafe } from './store.mjs';

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
  return new CodedError('illegal-transition', { message: `illegal transition: ${from} -> ${to}${known}` });
}

/**
 * Move the record identified by `key` to `to`. `extra` is merged into the
 * record, so a blocked/skipped reason lives beside the state it explains.
 * An illegal edge throws, which is what stops a double submission.
 */
export function applyTransition(records, key, to, extra = {}) {
  const index = records.findIndex((record) => keyOf(record) === key);
  if (index === -1) throw new CodedError('record-not-found', { message: `no record with identity key ${key}` });

  const current = records[index];
  const from = current.status;
  if (!canTransition(from, to)) throw transitionError(from, to);

  // A blocked record may only resume the exact state it was blocked from.
  if (from === 'blocked' && current.blockedFrom && current.blockedFrom !== to) {
    throw new CodedError('illegal-transition', { message: `illegal transition: blocked -> ${to} (blocked from ${current.blockedFrom})` });
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

const ROOT = resolve(import.meta.dirname, '..');
const DATA = join(ROOT, 'data');

/**
 * Where this file's backups live. Repo data rotates under data/backups; a
 * caller's own tree (tests, alternate roots) keeps backups inside itself so
 * nothing is ever written into the checkout from a scratch run.
 */
export function backupDirFor(path) {
  const dir = dirname(resolve(path));
  return dir === ROOT || dir === DATA ? join(DATA, 'backups') : join(dir, 'backups');
}

/**
 * Read the ledger records. A v1 file migrates in memory and is written back
 * atomically (with a backup) so every later write sees the current schema.
 */
export function readStore(path) {
  const { store, migrated } = migrate(readJson(path));
  if (migrated) {
    backupBeforeWrite(path, { backupDir: backupDirFor(path) });
    writeJsonAtomic(path, store);
  }
  return store.applications;
}

/** 2-space JSON with schemaVersion first, one trailing newline, record order preserved. */
export function writeStore(path, records) {
  writeJsonSafe(
    path,
    { schemaVersion: SCHEMA_VERSION, updated: new Date().toISOString().slice(0, 10), applications: records },
    { backupDir: backupDirFor(path) },
  );
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
