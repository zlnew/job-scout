/**
 * Resolve one posting's application target and report what a submit would need.
 *
 *   node cli/prepare.mjs --id <linkedin id | url> [--write] [--headless]
 *
 * Without --write nothing is stored. With --write the record moves to
 * `prepared` when nothing blocks, else to `blocked` with a one-line reason.
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
import { launch, parseArgs } from '../scripts/browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const STORE = join(ROOT, 'applications.json');
const PROFILE = join(ROOT, 'data/profile.json');
const EVENTS = join(ROOT, 'data/events.jsonl');
const USAGE = [
  'usage: node cli/prepare.mjs --id <linkedin id | url> [--write] [--headless]',
  '       [--store <applications.json>] [--profile <profile.json>] [--events <events.jsonl>]',
].join('\n');

const args = parseArgs(process.argv.slice(2));
if (!args.id) {
  console.error(USAGE);
  process.exit(2);
}

let id;
try {
  const raw = String(args.id).trim();
  id = /^\d+$/.test(raw) ? jobIdFromInput({ id: raw }) : jobIdFromInput({ url: raw });
} catch (error) {
  console.error(error.message);
  console.error(USAGE);
  process.exit(2);
}

const storePath = resolve(args.store ?? STORE);
const profilePath = resolve(args.profile ?? PROFILE);
const eventsPath = resolve(args.events ?? EVENTS);
const records = readStore(storePath);
const record = records.find(
  (candidate) => String(candidate.linkedinId ?? '') === id || jobIdFromUrl(candidate.url ?? '') === id,
);
if (!record) {
  console.error(`no record for LinkedIn job ${id} in ${storePath}`);
  process.exit(2);
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
      console.error(`session expired: ${error.message}`);
      process.exit(4);
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

const blockers = [...new Set([
  ...guard.reasons,
  ...(adapter.supportsSubmit ? [] : [`adapter ${adapter.name} does not auto-submit`]),
  ...(applyKind === 'ats' ? [] : [`${applyKind ?? 'unknown'} apply target cannot be auto-submitted`]),
  ...map.questions.map((question) => `${question.label}: ${question.reason}`),
])];
const canSubmitToday = blockers.length === 0;

const fieldLabels = Object.keys(map.fields);
console.log(`${record.company} - ${record.role} (${id})`);
console.log(`adapter: ${adapter.name}${adapter.supportsSubmit ? '' : ' (no auto-submit)'}`);
console.log(`apply: ${applyUrl ?? 'none'} (${applyKind ?? 'unknown'})`);
console.log(`fields: ${fieldLabels.length}`);
for (const label of fieldLabels) console.log(`  - ${label}`);
console.log(`blocks: ${blockers.length}`);
for (const blocker of blockers) console.log(`  - ${blocker}`);
console.log(`submit today: ${canSubmitToday ? 'yes' : 'no'}`);

if (!args.write) process.exit(canSubmitToday ? 0 : 3);

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
  const blockedReason = blockers.join('; ');
  nextRecords = records.map((candidate) => (matches(candidate) ? { ...candidate, ...extra, blockedReason } : candidate));
} else {
  nextRecords = applyTransition(records, key, 'blocked', { ...extra, reason: blockers.join('; ') }).records;
}

writeStore(storePath, nextRecords);
appendEvent(eventsPath, {
  action: canSubmitToday ? 'prepared' : 'blocked',
  key,
  id,
  adapter: adapter.name,
  fields: fieldLabels.length,
  blockedReason: canSubmitToday ? undefined : blockers.join('; '),
});
console.log(`written: ${canSubmitToday ? 'prepared' : 'blocked'} -> ${storePath}`);
process.exit(canSubmitToday ? 0 : 3);
