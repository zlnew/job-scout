/**
 * Fill a prepared application and, when nothing blocks (S1), submit it.
 *
 *   node cli/apply.mjs --id <linkedin id> [--dry-run] [--headless]
 *
 * --dry-run stops after the fill and the guard, so nothing is clicked and the
 * record is untouched. Exit codes: 0 submitted or dry-run clean, 3 refused
 * (not prepared, guard failed, no safe submit), 2 usage/unknown record.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { findAdapter } from '../adapters/index.mjs';
import { SessionExpired, jobIdFromInput, jobIdFromUrl } from '../boards/linkedin.mjs';
import { findSubmit, fillForm, requiredEmptyControls } from '../core/execute.mjs';
import { checkSubmission, identityKey, loadProfile } from '../core/guard.mjs';
import { appendEvent, applyTransition, readStore, writeStore } from '../core/ledger.mjs';
import { launch, parseArgs } from '../scripts/browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const STORE = join(ROOT, 'applications.json');
const PROFILE = join(ROOT, 'data/profile.json');
const EVENTS = join(ROOT, 'data/events.jsonl');
const USAGE = [
  'usage: node cli/apply.mjs --id <linkedin id> [--dry-run] [--headless]',
  '       [--store <applications.json>] [--profile <profile.json>] [--events <events.jsonl>] [--shot <path>]',
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
if (record.status !== 'prepared') {
  console.error(`record ${id} is "${record.status}", not "prepared"; run prepare --write first`);
  process.exit(3);
}
if (!record.applyUrl) {
  console.error(`record ${id} has no applyUrl; run prepare --write first`);
  process.exit(2);
}

const adapter = findAdapter(record.applyUrl);
const key = record.identityKey ?? identityKey(record);
// prepare stores the reviewed map on the record; older rows rebuild it.
const map = record.fields
  ? {
      fields: record.fields,
      questions: record.questions ?? [],
      blocked: record.blocked ?? [],
      missing: record.missing ?? [],
    }
  : adapter.buildMap(loadProfile(profilePath), record);

const started = Date.now();
const slug = String(record.company ?? 'apply').replaceAll(/[^a-z0-9]+/gi, '-').toLowerCase() || 'apply';
const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
const shotPath = resolve(args.shot ?? join(ROOT, 'screenshots', `${stamp}-${slug}.png`));

const context = await // Headless by default: this box has no display, and a headed launch dies here.
  launch({ headless: args.headed ? false : true });
let exitCode = 0;
let failure = '';
let submitted = false;

try {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(record.applyUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });

  if (typeof adapter.prepare === 'function') {
    const prepared = await adapter.prepare(page);
    if (prepared?.gate === false) {
      exitCode = 4;
      failure = `apply gate did not appear on ${record.applyUrl}`;
    }
  }

  if (exitCode === 0) {
    const filled = await fillForm(page, { fields: map.fields, fieldsDir: ROOT });
    const requiredEmpty = await requiredEmptyControls(page);
    const guard = checkSubmission({
      kind: record.applyKind === 'easy-apply' ? 'easy-apply' : 'ats',
      identityKey: key,
      missed: [...map.missing, ...filled.missed],
      requiredEmpty,
      blockedQuestions: [...map.blocked, ...map.questions].map((question) => question.label),
      priorRecords: records,
    });

    if (!guard.ok) {
      exitCode = 3;
      failure = `guard refused: ${guard.reasons.join('; ')}`;
    } else if (args['dry-run']) {
      console.log(`dry run: filled ${filled.filled.length} fields, guard passed`);
      console.log(
        adapter.supportsSubmit
          ? `would submit with adapter ${adapter.name}`
          : `would stop: adapter ${adapter.name} has no auto-submit`,
      );
    } else if (!adapter.supportsSubmit) {
      exitCode = 3;
      failure = `adapter ${adapter.name} does not auto-submit; complete this form by hand`;
    } else {
      if (typeof adapter.submit === 'function') await adapter.submit(page);
      else {
        const button = await findSubmit(page);
        if (!button) {
          exitCode = 3;
          failure = 'no submit control on the form; nothing was clicked';
        } else {
          await button.click();
        }
      }

      if (exitCode === 0) {
        mkdirSync(dirname(shotPath), { recursive: true });
        await page.screenshot({ path: shotPath, fullPage: true });
        const { records: nextRecords } = applyTransition(records, key, 'submitted', {
          applied: new Date().toISOString().slice(0, 10),
          screenshot: shotPath,
          identityKey: key,
        });
        writeStore(storePath, nextRecords);
        appendEvent(eventsPath, {
          action: 'applied',
          key,
          id,
          adapter: adapter.name,
          fields: filled.filled.length,
          screenshot: shotPath,
          durationMs: Date.now() - started,
        });
        submitted = true;
      }
    }
  }
} catch (error) {
  if (error instanceof SessionExpired) {
    exitCode = 4;
    failure = `session expired: ${error.message}`;
  } else {
    throw error;
  }
} finally {
  await context.close();
}

if (failure) console.error(failure);
if (submitted) {
  console.log(`submitted ${record.company} - ${record.role}`);
  console.log(`screenshot: ${shotPath}`);
}
process.exit(exitCode);
