#!/usr/bin/env node
// Stage 2: shortlist and score. Reads postings from the DB, applies the rubric in
// lib/score.mjs (policy from data/answers.md), and writes data/shortlist.json as a
// derived snapshot. The DB is the source of truth: every run rescores from it
// instead of trusting a stale export.
//
//   node bin/shortlist.mjs                 # top 15, all decisions
//   node bin/shortlist.mjs --top 5 --apply # only decision=apply
//   node bin/shortlist.mjs --min 60
//   node bin/shortlist.mjs --json

import { PATHS, writeJson, loadProfile, renderTable, whereLabel } from '../lib/store.mjs';
import { openDb, listPostings } from '../lib/db.mjs';
import { scoreJob, WEIGHTS } from '../lib/score.mjs';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};

const profile = loadProfile();
openDb();
const postings = listPostings();

if (!postings.length) {
  console.error('No postings. Run: node bin/scan.mjs');
  process.exit(1);
}

const scored = postings
  .map((job) => {
    const verdict = scoreJob(job, profile);
    return { id: job.id, title: job.title, company: job.company, city: job.city, remote: job.remote, url: job.url, salary: job.salary, published: job.published, ...verdict };
  })
  .sort((a, b) => b.score - a.score);

// Derived export only (git-visible snapshot). Rescored from the DB on every run.
writeJson(PATHS.shortlist, {
  updated_at: new Date().toISOString(),
  rubric: WEIGHTS,
  floor_idr: profile?.compensation?.floor?.value ?? null,
  count: scored.length,
  entries: scored,
});

const min = Number(val('--min', 0)) || 0;
const top = Number(val('--top', 15)) || 15;
let rows = scored.filter((r) => r.score >= min);
if (has('--apply')) rows = rows.filter((r) => r.decision === 'apply');
if (has('--review')) rows = rows.filter((r) => r.decision === 'review');
rows = rows.slice(0, top);

if (has('--json')) {
  console.log(JSON.stringify({ count: scored.length, shown: rows.length, entries: rows }, null, 2));
  process.exit(0);
}

const tally = scored.reduce((acc, r) => ((acc[r.decision] = (acc[r.decision] || 0) + 1), acc), {});
console.log(`Scored ${scored.length} postings — ${Object.entries(tally).map(([k, v]) => `${k}: ${v}`).join(' · ')}\n`);

console.log(
  renderTable(rows, [
    { label: 'Score', get: (r) => r.score },
    { label: 'Decision', get: (r) => r.decision },
    { label: 'Role', get: (r) => r.title },
    { label: 'Company', get: (r) => r.company },
    { label: 'Where', get: whereLabel },
    { label: 'Posted', get: (r) => (r.published || '').slice(0, 10) },
    { label: 'Watch-outs', get: (r) => (r.flags || []).slice(0, 2).join('; ') },
  ]),
);

const rejects = scored.filter((r) => r.decision === 'reject').slice(0, 5);
if (rejects.length && !has('--quiet')) {
  console.log('\nRejected (policy):');
  for (const r of rejects) console.log(`  - ${r.title} @ ${r.company}: ${r.flags[0]}`);
}

console.log(`\nNext: node bin/apply.mjs <id|company>            (prints the apply link)`);
console.log(`      node bin/apply.mjs <id> --email --to a@b.c --body-file letter.txt`);
