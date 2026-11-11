#!/usr/bin/env node
// Stage 1: scan. Pulls open postings from the fungsi.id index into the SQLite DB
// (data/job-apply.db). The DB is the system of record.
//
//   node bin/scan.mjs                  # default profile searches
//   node bin/scan.mjs --query backend --city jakarta
//   node bin/scan.mjs --no-detail      # titles only, fast, no stack detection
//   node bin/scan.mjs --json           # machine-readable output for agents

import { renderTable } from '../lib/store.mjs';
import { openDb, upsertPostings, listPostings } from '../lib/db.mjs';
import { scanFungsi } from '../lib/sources.mjs';
import { DEFAULT_SEARCHES } from '../lib/searches.mjs';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};

function searchesFromArgs() {
  const query = val('--query');
  if (!query) return DEFAULT_SEARCHES;
  const one = { query };
  const city = val('--city');
  if (city) one.city = city.toLowerCase();
  if (has('--remote')) one.remote = true;
  return [one];
}

async function main() {
  const searches = searchesFromArgs();
  const details = !has('--no-detail');
  const limit = Number(val('--limit', 0)) || 0;

  if (!has('--json')) {
    console.log(`Scanning fungsi.id — ${searches.length} search(es), details ${details ? 'on' : 'off'}\n`);
  }

  let jobs = await scanFungsi(searches, { details });
  if (limit) jobs = jobs.slice(0, limit);

  openDb();
  const { added, updated } = upsertPostings(jobs);
  const total = listPostings().length;

  if (has('--json')) {
    console.log(JSON.stringify({ total, added, updated, scanned: jobs.length, postings: jobs }, null, 2));
    return;
  }

  console.log(`Fetched ${jobs.length} · new ${added} · refreshed ${updated} · store now holds ${total}\n`);
  console.log(
    renderTable(jobs.slice(0, 25), [
      { label: 'Title', get: (j) => j.title },
      { label: 'Company', get: (j) => j.company },
      { label: 'Location', get: (j) => (j.remote ? `${j.city} +remote` : j.city) },
      { label: 'Salary', get: (j) => j.salary || '—' },
      { label: 'Posted', get: (j) => (j.published || '').slice(0, 10) },
    ]),
  );
  console.log(`\nNext: node bin/shortlist.mjs`);
}

main().catch((err) => {
  console.error(`scan failed: ${err.message}`);
  process.exit(1);
});
