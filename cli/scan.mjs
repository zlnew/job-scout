/**
 * Multi-source discovery sweep. One board failing is reported, never fatal (S9.4).
 *
 *   node cli/scan.mjs [--sources linkedin,glints,kalibrr,dealls] [--queries "a|b"]
 *                     [--location Indonesia] [--pages 1] [--limit 30] [--write]
 *                     [--store applications.json] [--json]
 *
 * Without --write nothing is stored. With --write new candidates are appended to
 * the ledger as `discovered`; an existing identity key is never touched, so a
 * re-scan cannot downgrade or duplicate a row.
 * --json prints the structured result (S5) and nothing else on stdout.
 * Exit codes: 0 at least one source replied, 5 every source failed, 2 usage.
 */
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { DEFAULT_QUERIES, listSources, rankTitle, scanAll } from '../boards/index.mjs';
import { identityKey } from '../core/guard.mjs';
import { readStore, writeStore } from '../core/ledger.mjs';
import { CODES, fail, ok, reason } from '../core/result.mjs';
import { parseArgs } from '../scripts/browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const STORE = join(ROOT, 'applications.json');
const USAGE = [
  'usage: node cli/scan.mjs [--sources linkedin,glints,kalibrr,dealls] [--queries "a|b"]',
  '                        [--location Indonesia] [--pages 1] [--limit 30] [--write]',
  '                        [--store applications.json]',
  '',
  '  --sources  comma-separated boards to scan (default: all registered)',
  '  --queries  pipe-separated search terms (default: the LinkedIn query set)',
  '  --pages    pages per query (default: 1)',
  '  --limit    rows to print and write (default: 30)',
  '  --write    append new candidates to the ledger as discovered',
  '  --json     print the structured result instead of the table',
].join('\n');

const today = () => new Date().toISOString().slice(0, 10);

/** A candidate as a ledger record. The key is explicit because the board calls
 * the role `title`. Identity does not include `source`: see the scan report. */
export function discoveredRecord(candidate) {
  const key = identityKey({
    company: candidate.company,
    role: candidate.title,
    applyUrl: candidate.url,
  });
  return {
    company: candidate.company,
    role: candidate.title,
    status: 'discovered',
    channel: candidate.source,
    source: candidate.source,
    posted: candidate.posted || undefined,
    url: candidate.url,
    seenOn: candidate.seenOn ?? [candidate.source],
    identityKey: key,
    discoveredAt: today(),
  };
}

/**
 * Append candidates the ledger has never seen. Existing records keep their
 * status, score and notes, whatever they are (a re-scan must not downgrade
 * `submitted` back to `discovered`).
 */
export function writeDiscovered(storePath, candidates) {
  const records = readStore(storePath);
  const known = new Set(records.map((record) => record.identityKey ?? identityKey(record)));
  const added = [];
  for (const candidate of candidates) {
    const record = discoveredRecord(candidate);
    if (known.has(record.identityKey)) continue;
    known.add(record.identityKey);
    added.push(record);
  }
  if (added.length > 0) writeStore(storePath, [...records, ...added]);
  return added;
}

function statusLine(report) {
  const outcome = report.ok ? `ok ${report.count}` : `error: ${report.error}`;
  return `${report.source.padEnd(10)} ${outcome.padEnd(32)} via ${report.via}`;
}

function table(candidates) {
  const head = `${'rank'.padEnd(4)}  ${'source'.padEnd(9)} ${'company'.padEnd(26)} ${'title'.padEnd(46)} ${'location'.padEnd(20)} ${'posted'.padEnd(10)} url`;
  const lines = [head];
  for (const candidate of candidates) {
    lines.push(
      [
        String(rankTitle(candidate.title)).padEnd(4),
        ' ',
        candidate.source.padEnd(9),
        ' ',
        candidate.company.slice(0, 26).padEnd(26),
        ' ',
        candidate.title.slice(0, 46).padEnd(46),
        ' ',
        candidate.location.slice(0, 20).padEnd(20),
        ' ',
        candidate.posted.padEnd(10),
        ' ',
        candidate.url,
      ].join(''),
    );
  }
  return lines.join('\n');
}

async function main(argv) {
  const args = parseArgs(argv);
  const jsonOut = Boolean(args.json);
  const log = (...parts) => {
    if (!jsonOut) console.log(...parts);
  };
  const emit = (result) => {
    if (jsonOut) process.stdout.write(`${JSON.stringify(result)}\n`);
  };

  if (args.help) {
    log(USAGE);
    return 0;
  }

  const known = listSources().map((source) => source.name);
  const names = args.sources ? String(args.sources).split(',').map((s) => s.trim()).filter(Boolean) : known;
  const unknown = names.filter((name) => !known.includes(name));
  if (unknown.length > 0) {
    if (jsonOut) emit(fail('usage', { message: `unknown source: ${unknown.join(', ')} (known: ${known.join(', ')})` }));
    else {
      console.error(`unknown source: ${unknown.join(', ')} (known: ${known.join(', ')})`);
      console.error(USAGE);
    }
    return 2;
  }

  const queries = args.queries
    ? String(args.queries).split('|').map((query) => query.trim()).filter(Boolean)
    : DEFAULT_QUERIES;
  const location = String(args.location ?? 'Indonesia');
  const pages = Number(args.pages ?? 1);
  const limit = Number(args.limit ?? 30);
  const storePath = resolve(args.store ?? STORE);

  log(`${names.length} sources · ${location} · ${pages} page(s)`);
  const { candidates, perSource, deduped } = await scanAll({ names, queries, location, pages });

  for (const report of perSource) log(statusLine(report));

  const rows = candidates.slice(0, limit);
  log(`\n${candidates.length} candidates (${deduped} duplicate(s) merged, ${rows.length} shown)\n`);
  if (rows.length > 0) log(table(rows));

  let written = 0;
  if (args.write) {
    written = writeDiscovered(storePath, rows).length;
    log(`\nwrote ${written} new record(s) to ${storePath}`);
  }

  // One report per source: a partial sweep stays ok, every-source failure does not.
  const failed = perSource.filter((report) => !report.ok);
  const failures = failed.map((report) => reason('source-failed', { message: `${report.source}: ${report.error}` }));
  const value = { location, pages, perSource, candidates: rows, shown: rows.length, deduped, written };
  emit({
    ...(failed.length === 0
      ? ok('scanned', value)
      : { ok: false, code: 'source-failed', message: CODES['source-failed'].message, fix: CODES['source-failed'].fix, value }),
    reasons: failures,
    warnings: [],
  });

  // Partial results are reported as partial, not as zero (S9.4).
  return perSource.every((report) => !report.ok) ? 5 : 0;
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
