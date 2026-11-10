/**
 * Resolve one posting's application target and report what a submit would need.
 *
 *   node cli/prepare.mjs --id <linkedin id | url> [--write] [--headless] [--json]
 *
 * Without --write nothing is stored. With --write the record moves to
 * `prepared` when nothing blocks, else to `blocked` with the reasons and fixes.
 * --json prints the structured result (S5) and nothing else.
 * Exit codes: 0 prepared, 3 blocked, 2 usage/unknown record, 4 session expired.
 */
import { join, resolve } from 'node:path';
import { findAdapter } from '../adapters/index.mjs';
import {
  SessionExpired,
  jobIdFromInput,
  jobIdFromUrl,
  resolveApplyTarget,
} from '../boards/linkedin.mjs';
import { checkSubmission, identityKey, loadProfile } from '../core/guard.mjs';
import { appendEvent, applyTransition, readStore, writeStore } from '../core/ledger.mjs';
import { fail, ok, reason, refusal } from '../core/result.mjs';
import { launch, parseArgs } from '../scripts/browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const STORE = join(ROOT, 'applications.json');
const PROFILE = join(ROOT, 'data/profile.json');
const EVENTS = join(ROOT, 'data/events.jsonl');
const USAGE = [
  'usage: node cli/prepare.mjs --id <linkedin id | url> [--write] [--headless] [--json]',
  '       [--store <applications.json>] [--profile <profile.json>] [--events <events.jsonl>]',
].join('\n');

const args = parseArgs(process.argv.slice(2));
const jsonOut = Boolean(args.json);
// In --json mode stdout carries exactly one result object, so no human line
// may slip in alongside it.
const log = (...parts) => {
  if (!jsonOut) console.log(...parts);
};
const emit = (result) => {
  if (jsonOut) process.stdout.write(`${JSON.stringify(result)}\n`);
};
const die = (status, result, lines) => {
  if (jsonOut) emit(result);
  else for (const line of lines) console.error(line);
  process.exit(status);
};

if (!args.id) {
  die(2, fail('usage', { message: USAGE }), [USAGE]);
}

let id;
try {
  const raw = String(args.id).trim();
  id = /^\d+$/.test(raw) ? jobIdFromInput({ id: raw }) : jobIdFromInput({ url: raw });
} catch (error) {
  die(2, fail('usage', { message: error.message }), [error.message, USAGE]);
}

const storePath = resolve(args.store ?? STORE);
const profilePath = resolve(args.profile ?? PROFILE);
const eventsPath = resolve(args.events ?? EVENTS);
const records = readStore(storePath);
const record = records.find(
  (candidate) => String(candidate.linkedinId ?? '') === id || jobIdFromUrl(candidate.url ?? '') === id,
);
if (!record) {
  const message = `no record for LinkedIn job ${id} in ${storePath}`;
  die(2, fail('record-not-found', { message }), [message]);
}

let applyUrl = record.applyUrl ?? null;
let applyKind = record.applyKind ?? null;
if (!applyUrl) {
  const context = await // Headless by default: this box has no display, and a headed launch dies here.
  launch({ headless: args.headed ? false : true });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const resolved = await resolveApplyTarget({ id, page });
    applyUrl = resolved.applyUrl;
    applyKind = resolved.kind;
  } catch (error) {
    if (error instanceof SessionExpired) {
      const message = `session expired: ${error.message}`;
      die(4, fail('session-expired', { message }), [message]);
    }
    throw error;
  } finally {
    await context.close();
  }
}

const adapter = findAdapter(applyUrl);
const profile = loadProfile(profilePath);
const map = adapter.buildMap(profile, {
  ...record,
  controls: record.controls,
  coverLetter: record.coverLetter,
});

// Materialise the key so later reads keep matching this record even after
// applyUrl is filled in (the identity is allowed to include it).
const key = record.identityKey ?? identityKey(record);
const guard = checkSubmission({
  kind: applyKind === 'easy-apply' ? 'easy-apply' : 'ats',
  identityKey: key,
  missed: map.missing,
  blockedQuestions: map.blocked.map((question) => question.label),
  priorRecords: records,
});

// Ordered, de-duplicated by message: a rule and an adapter may name the same gap.
const blockers = [
  ...new Map([
    ...guard.reasons,
    ...(adapter.supportsSubmit
      ? []
      : [reason('adapter-unverified', { message: `adapter ${adapter.name} does not auto-submit` })]),
    ...(applyKind === 'ats'
      ? []
      : [
          reason(applyKind === 'easy-apply' ? 'easy-apply' : 'adapter-unverified', {
            message: `${applyKind ?? 'unknown'} apply target cannot be auto-submitted`,
          }),
        ]),
    ...map.questions.map((question) =>
      reason('blocked-question', { message: `${question.label}: ${question.reason}` }),
    ),
  ].map((entry) => [entry.message, entry])).values(),
];
const canSubmitToday = blockers.length === 0;

const fieldLabels = Object.keys(map.fields);
const value = {
  id,
  company: record.company,
  role: record.role,
  applyUrl,
  applyKind,
  adapter: adapter.name,
  supportsSubmit: adapter.supportsSubmit,
  fields: fieldLabels,
  canSubmitToday,
};
const result = canSubmitToday
  ? { ...ok('prepared', value), reasons: [], warnings: guard.warnings }
  : refusal(blockers, guard.warnings, value);

log(`${record.company} - ${record.role} (${id})`);
log(`adapter: ${adapter.name}${adapter.supportsSubmit ? '' : ' (no auto-submit)'}`);
log(`apply: ${applyUrl ?? 'none'} (${applyKind ?? 'unknown'})`);
log(`fields: ${fieldLabels.length}`);
for (const label of fieldLabels) log(`  - ${label}`);
log(`blocks: ${blockers.length}`);
for (const blocker of blockers) {
  log(`  - ${blocker.message}`);
  if (blocker.fix) log(`    fix: ${blocker.fix}`);
}
// Optional controls the map could not fill: reported, never counted as a block.
for (const warning of guard.warnings) log(`warnings: ${warning.message}`);
log(`submit today: ${canSubmitToday ? 'yes' : 'no'}`);

if (!args.write) {
  emit(result);
  process.exit(canSubmitToday ? 0 : 3);
}

const extra = {
  applyUrl,
  applyKind,
  adapter: adapter.name,
  fields: map.fields,
  questions: map.questions,
  blocked: map.blocked,
  missing: map.missing,
  identityKey: key,
};
const matches = (candidate) => (candidate.identityKey ?? identityKey(candidate)) === key;
const blockerText = blockers.map((entry) => entry.message).join('; ');
let nextRecords = records;

if (canSubmitToday) {
  if (record.status === 'prepared') {
    nextRecords = records.map((candidate) => (matches(candidate) ? { ...candidate, ...extra } : candidate));
  } else {
    // A record may only walk forward along the state machine, so shortlisted
    // rows pass through resolved on their way to prepared.
    const path = ['scored', 'shortlisted', 'resolved', 'prepared'];
    let current = record.status === 'blocked' ? record.blockedFrom ?? 'resolved' : record.status;
    for (let i = path.indexOf(current) + 1; i < path.length; i += 1) {
      nextRecords = applyTransition(nextRecords, key, path[i], extra).records;
    }
  }
} else if (record.status === 'blocked') {
  nextRecords = records.map((candidate) => (matches(candidate) ? { ...candidate, ...extra, blockedReason: blockerText } : candidate));
} else {
  nextRecords = applyTransition(records, key, 'blocked', { ...extra, reason: blockerText }).records;
}

writeStore(storePath, nextRecords);
appendEvent(eventsPath, {
  action: canSubmitToday ? 'prepared' : 'blocked',
  key,
  id,
  adapter: adapter.name,
  fields: fieldLabels.length,
  blockedReason: canSubmitToday ? undefined : blockerText,
});
log(`written: ${canSubmitToday ? 'prepared' : 'blocked'} -> ${storePath}`);
emit(result);
process.exit(canSubmitToday ? 0 : 3);
