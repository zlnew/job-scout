#!/usr/bin/env node
// One-shot migration: data/postings.json + data/applications.json -> data/job-apply.db
//
//   node bin/migrate.mjs
//   node bin/migrate.mjs --json
//
// Idempotent: re-running reports 0 imported / everything skipped and never
// duplicates rows. The JSON files are inputs only after this point; the DB is
// the system of record.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PATHS, readJson } from '../lib/store.mjs';
import { openDb, upsertPostings, listPostings, listApplications, upsertApplication, countEvents } from '../lib/db.mjs';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);

const APPLICATION_COLUMNS = ['posting_id', 'company', 'role', 'channel', 'status', 'score', 'to_addr', 'subject', 'draft_id', 'notes', 'url', 'posted'];
const INTERNAL_KEYS = new Set(['id', 'created_at', 'updated_at', 'applied_at', 'legacy_json']);

/** Fields with no curated column, in a stable order so re-runs compare equal. */
function legacyFields(record) {
  const out = {};
  for (const key of Object.keys(record).sort()) {
    if (APPLICATION_COLUMNS.includes(key) || INTERNAL_KEYS.has(key)) continue;
    out[key] = record[key];
  }
  return out;
}

const stable = (value) => JSON.stringify(value, Object.keys(value).sort());

function findExisting(applications, record) {
  if (record.posting_id) {
    const match = applications.find((a) => a.posting_id === record.posting_id);
    if (match) return match;
  }
  const incoming = legacyFields(record);
  return applications.find((a) => {
    if ((a.company ?? null) !== (record.company ?? null)) return false;
    if ((a.role ?? null) !== (record.role ?? null)) return false;
    if ((a.posted ?? null) !== (record.posted ?? null)) return false;
    if ((a.channel ?? null) !== (record.channel ?? null)) return false;
    return stable(a.legacy) === stable(incoming);
  });
}

/** Import both JSON snapshots. Accepts overrides so tests can point at a fixture. */
export function runMigration({
  dbFile = PATHS.db,
  postingsFile = PATHS.postings,
  applicationsFile = PATHS.applications,
} = {}) {
  openDb(dbFile);

  const postingsJson = readJson(postingsFile, { postings: [] });
  const applicationsJson = readJson(applicationsFile, { applications: [] });

  const postingRows = postingsJson.postings || [];
  const postingCounts = upsertPostings(postingRows);

  const applicationRows = applicationsJson.applications || [];
  const existing = listApplications();
  const eventsBefore = countEvents();
  let imported = 0;
  let skipped = 0;

  for (const record of applicationRows) {
    if (findExisting(existing, record)) {
      skipped += 1;
      continue;
    }
    // upsertApplication appends the initial status event for new rows.
    const result = upsertApplication({
      ...record,
      created_at: record.created_at || record.applied_at,
      updated_at: record.updated_at || record.applied_at,
    });
    existing.push({ ...record, id: result.id, legacy: legacyFields(record) });
    imported += 1;
  }

  return {
    db: dbFile,
    postings: { read: postingRows.length, imported: postingCounts.added, skipped: postingCounts.updated, total: listPostings().length },
    applications: { read: applicationRows.length, imported, skipped, total: listApplications().length },
    events: { created: countEvents() - eventsBefore },
  };
}

async function main() {
  if (!fs.existsSync(PATHS.postings) && !fs.existsSync(PATHS.applications)) {
    console.error('Nothing to migrate: data/postings.json and data/applications.json are both missing.');
    process.exit(1);
  }

  const result = runMigration();

  if (has('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Database: ${path.relative(process.cwd(), result.db) || result.db}`);
  console.log(
    `Postings     read ${result.postings.read} · imported ${result.postings.imported} · already present ${result.postings.skipped} · now ${result.postings.total}`,
  );
  console.log(
    `Applications read ${result.applications.read} · imported ${result.applications.imported} · already present ${result.applications.skipped} · now ${result.applications.total}`,
  );
  console.log(`Events       created ${result.events.created}`);
  console.log(`\nNext: node bin/shortlist.mjs`);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`migrate failed: ${err.message}`);
    process.exit(1);
  });
}
