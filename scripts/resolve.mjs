/**
 * Discover where a LinkedIn posting's application actually happens: an employer ATS
 * URL, LinkedIn's own Easy Apply form, or neither. It only reads the page and, at most,
 * clicks the apply control once - it never fills or submits a form.
 *
 *   node scripts/resolve.mjs --id 4440204415 [--write]
 *   node scripts/resolve.mjs --url https://www.linkedin.com/jobs/view/4440204415 [--write]
 *   node scripts/resolve.mjs --limit 5 [--write]
 *
 * Without --write the result is printed and nothing is stored. Easy Apply stays manual:
 * the harness refuses to automate it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyApplyTarget,
  isAuthwallUrl,
  isLinkedInHost,
  jobIdFromInput,
  jobIdFromUrl,
  resolveApplyTarget,
  SessionExpired,
  unwrapRedirect,
} from '../boards/linkedin.mjs';
import { launch, parseArgs } from './browser.mjs';

export { classifyApplyTarget, isAuthwallUrl, isLinkedInHost, jobIdFromInput, unwrapRedirect };

const ROOT = resolve(import.meta.dirname, '..');
const STORE = join(ROOT, 'applications.json');

const USAGE = [
  'usage: node scripts/resolve.mjs --id <job id> [--write]',
  '       node scripts/resolve.mjs --url <linkedin job url> [--write]',
  '       node scripts/resolve.mjs --limit <n> [--write]',
].join('\n');

/** Rows worth resolving: shortlisted LinkedIn jobs that still have no discovered ATS URL. */
export function pendingResolutions(records, limit = 5) {
  const ids = [];
  for (const record of records) {
    if (record.status !== 'shortlisted' || record.applyUrl) continue;
    const id = jobIdFromUrl(record.url ?? '');
    if (!id) continue;
    ids.push(id);
    if (ids.length >= limit) break;
  }
  return ids;
}

/** Return a new record list with one resolution applied; every other field is preserved. */
export function mergeResolution(records, result, resolvedAt = new Date().toISOString().slice(0, 10)) {
  const target = String(result.id);
  return records.map((record) => {
    if (jobIdFromUrl(record.url ?? '') !== target) return record;
    return {
      ...record,
      applyUrl: result.kind === 'ats' ? result.applyUrl : null,
      applyKind: result.kind,
      resolvedAt,
    };
  });
}

/** The store keeps 2-space JSON and one trailing newline; diffs stay readable. */
export function serializeStore(store) {
  return `${JSON.stringify(store, null, 2)}\n`;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  const wantsBatch = args.limit !== undefined;

  let ids = [];
  try {
    if (wantsBatch) {
      const limit = Number(args.limit);
      if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be a positive whole number');
      const store = JSON.parse(readFileSync(STORE, 'utf8'));
      ids = pendingResolutions(store.applications ?? [], limit);
    } else {
      ids = [jobIdFromInput(args)];
    }
  } catch (error) {
    console.error(`resolve: ${error.message}`);
    console.error(USAGE);
    process.exit(2);
  }

  if (ids.length === 0) {
    console.log('nothing to resolve: no shortlisted LinkedIn rows are missing applyUrl');
    process.exit(0);
  }

  let context;
  try {
    context = await launch({ headless: true });
  } catch (error) {
    console.error(`resolve: ${error.message}`);
    process.exit(1);
  }

  const page = await context.newPage();
  const results = [];
  try {
    for (const id of ids) {
      try {
        const result = await resolveApplyTarget({ id, page });
        results.push(result);
        console.log(JSON.stringify(result));
      } catch (error) {
        if (error instanceof SessionExpired) throw error;
        // One broken page should not hide the rest of a batch.
        const result = { id, url: `https://www.linkedin.com/jobs/view/${id}`, kind: 'manual', applyUrl: null, reason: `page failed: ${error.message}` };
        results.push(result);
        console.log(JSON.stringify(result));
      }
    }
  } catch (error) {
    if (!(error instanceof SessionExpired)) throw error;
    console.error(`session expired (${error.message}) - re-import cookies, then rerun.`);
    console.error('  npm run import-cookies -- cookies.json --verify https://www.linkedin.com/feed');
    await context.close().catch(() => {});
    process.exit(4);
  }

  if (args.write) {
    const store = JSON.parse(readFileSync(STORE, 'utf8'));
    let records = store.applications ?? [];
    for (const result of results) records = mergeResolution(records, result);
    const written = serializeStore({ ...store, applications: records });
    writeFileSync(STORE, written);
    console.error(`wrote ${results.length} resolution(s) to ${STORE}`);
  }

  await context.close().catch(() => {});
}
