/**
 * Fill a prepared application and, when nothing blocks (S1), submit it.
 *
 *   node cli/apply.mjs --id <linkedin id> [--dry-run] [--headless] [--json]
 *
 * --dry-run stops after the fill and the guard, so nothing is clicked and the
 * record is untouched. --json prints the structured result (S5) and nothing
 * else on stdout. Exit codes: 0 submitted or dry-run clean, 3 refused (not
 * prepared, guard failed, no safe submit), 2 usage/unknown record, 4 expired
 * session or missing apply gate.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { findAdapter } from '../adapters/index.mjs';
import { SessionExpired, jobIdFromInput, jobIdFromUrl } from '../boards/linkedin.mjs';
import { findSubmit, fillForm, requiredEmptyControls } from '../core/execute.mjs';
import { checkSubmission, identityKey, loadProfile } from '../core/guard.mjs';
import { appendEvent, applyTransition, readStore, writeStore } from '../core/ledger.mjs';
import { fail, ok, refusal } from '../core/result.mjs';
import { launch, parseArgs } from '../scripts/browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const STORE = join(ROOT, 'applications.json');
const PROFILE = join(ROOT, 'data/profile.json');
const EVENTS = join(ROOT, 'data/events.jsonl');
const USAGE = [
  'usage: node cli/apply.mjs --id <linkedin id> [--dry-run] [--headless] [--json]',
  '       [--store <applications.json>] [--profile <profile.json>] [--events <events.jsonl>] [--shot <path>]',
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
// Diagnostics stay on stderr in human mode; --json callers read stdout only.
const problem = (message) => {
  if (!jsonOut) console.error(message);
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
if (record.status !== 'prepared') {
  const message = `record ${id} is "${record.status}", not "prepared"; run prepare --write first`;
  die(3, fail('not-prepared', { message }), [message]);
}
if (!record.applyUrl) {
  const message = `record ${id} has no applyUrl; run prepare --write first`;
  die(2, fail('not-prepared', { message }), [message]);
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
let result = null;
let submitted = false;

try {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(record.applyUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });

  if (typeof adapter.prepare === 'function') {
    const prepared = await adapter.prepare(page);
    if (prepared?.gate === false) {
      exitCode = 4;
      result = fail('adapter-unverified', { message: `apply gate did not appear on ${record.applyUrl}` });
      problem(result.message);
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

    // Warnings stay visible on every outcome: an unmatched optional control is
    // worth a human glance even when nothing refuses.
    for (const warning of guard.warnings) log(`warnings: ${warning.message}`);

    if (!guard.ok) {
      exitCode = 3;
      result = refusal(guard.reasons, guard.warnings);
      problem(`guard refused: ${guard.reasons.map((entry) => entry.message).join('; ')}`);
      for (const entry of guard.reasons) {
        if (entry.fix) problem(`  fix: ${entry.fix}`);
      }
    } else if (args['dry-run']) {
      result = { ...ok('dry-run-clean', { id, adapter: adapter.name, filled: filled.filled.length }), reasons: [], warnings: guard.warnings };
      log(`dry run: filled ${filled.filled.length} fields, guard passed`);
      log(
        adapter.supportsSubmit
          ? `would submit with adapter ${adapter.name}`
          : `would stop: adapter ${adapter.name} has no auto-submit`,
      );
    } else if (!adapter.supportsSubmit) {
      exitCode = 3;
      result = fail('adapter-unverified', {
        message: `adapter ${adapter.name} does not auto-submit; complete this form by hand`,
      });
      problem(result.message);
    } else {
      let clicked = true;
      if (typeof adapter.submit === 'function') await adapter.submit(page);
      else {
        const button = await findSubmit(page);
        if (!button) {
          exitCode = 3;
          clicked = false;
          result = fail('adapter-unverified', { message: 'no submit control on the form; nothing was clicked' });
          problem(result.message);
        } else {
          await button.click();
        }
      }

      if (exitCode === 0 && clicked) {
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
        result = { ...ok('submitted', { id, adapter: adapter.name, screenshot: shotPath }), reasons: [], warnings: guard.warnings };
      }
    }
  }
} catch (error) {
  if (error instanceof SessionExpired) {
    exitCode = 4;
    result = fail('session-expired', { message: `session expired: ${error.message}` });
    problem(result.message);
  } else {
    throw error;
  }
} finally {
  await context.close();
}

if (submitted) {
  log(`submitted ${record.company} - ${record.role}`);
  log(`screenshot: ${shotPath}`);
}
emit(result);
process.exit(exitCode);
