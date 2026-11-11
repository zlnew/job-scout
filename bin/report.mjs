#!/usr/bin/env node
// Stage 4: report. Reads the DB, writes out/report-YYYY-MM-DD.md, and mirrors the
// application log to data/applications.md (a git-visible, human-readable export).
//
//   node bin/report.mjs
//   node bin/report.mjs --json

import fs from 'node:fs';
import path from 'node:path';
import { PATHS, readJson, renderTable, whereLabel } from '../lib/store.mjs';
import { openDb, listPostings, listApplications } from '../lib/db.mjs';

const has = (f) => process.argv.includes(f);

// shortlist.json is a derived export, so it is fine to read; the DB is the source
// of truth for postings and applications.
const shortlist = readJson(PATHS.shortlist, { entries: [] });
openDb();
const entries = shortlist.entries || [];
const applications = listApplications();
const postings = listPostings();

const byDecision = entries.reduce((acc, e) => ((acc[e.decision] = (acc[e.decision] || 0) + 1), acc), {});
const byStatus = applications.reduce((acc, a) => ((acc[a.status || 'unknown'] = (acc[a.status || 'unknown'] || 0) + 1), acc), {});
const stale = entries.filter((e) => (e.flags || []).some((f) => f.startsWith('stale')));
const drafted = applications.filter((a) => a.status === 'drafted');
const toApply = applications.filter((a) => a.status === 'to-apply');

const date = new Date().toISOString().slice(0, 10);
const summary = {
  generated_at: new Date().toISOString(),
  postings: postings.length,
  scored: entries.length,
  by_decision: byDecision,
  applications: applications.length,
  by_status: byStatus,
  pending_human: { drafted: drafted.length, to_apply: toApply.length },
  stale: stale.length,
};

if (has('--json')) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

const lines = [];
lines.push(`# Job search report — ${date}`, '');
lines.push(`Postings indexed: **${summary.postings}** · scored: **${summary.scored}** · applications tracked: **${summary.applications}**`, '');
lines.push('## Decisions', '', `- apply: ${byDecision.apply || 0}`, `- review: ${byDecision.review || 0}`, `- skip: ${byDecision.skip || 0}`, `- reject (policy): ${byDecision.reject || 0}`, '');

const top = entries.filter((e) => e.decision === 'apply' || e.decision === 'review').slice(0, 10);
if (top.length) {
  lines.push('## Shortlist', '');
  lines.push(
    renderTable(top, [
      { label: 'Score', get: (r) => r.score },
      { label: 'Role', get: (r) => r.title },
      { label: 'Company', get: (r) => r.company },
      { label: 'Where', get: whereLabel },
      { label: 'Posted', get: (r) => (r.published || '').slice(0, 10) },
      { label: 'Link', get: (r) => (r.url ? `[open](${r.url})` : '—') },
    ]),
  );
  lines.push('');
}

lines.push('## Waiting on you', '');
if (!drafted.length && !toApply.length) lines.push('_Nothing pending._');
for (const a of drafted) lines.push(`- **Send draft**: ${a.role} @ ${a.company} → ${a.to_addr || a.to} (draft ${a.draft_id})`);
for (const a of toApply) lines.push(`- **Apply on site**: ${a.role} @ ${a.company} → ${a.url}`);
lines.push('');

lines.push('## Applications', '');
if (!applications.length) lines.push('_None tracked yet._');
else {
  lines.push(
    renderTable(applications.slice(0, 20), [
      { label: 'Company', get: (a) => a.company },
      { label: 'Role', get: (a) => a.role },
      { label: 'Channel', get: (a) => a.channel || '—' },
      { label: 'Status', get: (a) => a.status || '—' },
      { label: 'When', get: (a) => (a.created_at || a.updated_at || '').slice(0, 10) },
    ]),
  );
  lines.push('');
}

if (stale.length) {
  lines.push('## Stale postings (posted >45 days)', '');
  for (const s of stale.slice(0, 10)) lines.push(`- ${s.title} @ ${s.company} — ${s.published}`);
  lines.push('');
}

lines.push('## Next actions', '');
if (drafted.length) lines.push('1. Open Gmail and send the pending draft(s) above — the script never sends.');
if (top.length) lines.push(`${drafted.length ? 2 : 1}. Work the shortlist: \`node bin/apply.mjs <id|company>\` for links, \`--email\` for a draft.`);
lines.push(`${drafted.length || top.length ? 3 : 1}. Re-scan when postings age past two weeks: \`node bin/scan.mjs && node bin/shortlist.mjs\`.`);
lines.push('');

const markdown = lines.join('\n');
const outFile = path.join(PATHS.out, `report-${date}.md`);
fs.mkdirSync(PATHS.out, { recursive: true });
fs.writeFileSync(outFile, markdown);

// Mirror of the application log for git. The DB stays authoritative.
const mirror = [];
mirror.push('# Applications', '');
mirror.push(`_Generated ${summary.generated_at} from data/job-apply.db. Source of truth is the database._`, '');
if (!applications.length) mirror.push('_None tracked yet._');
else {
  mirror.push(
    renderTable(applications, [
      { label: 'Company', get: (a) => a.company },
      { label: 'Role', get: (a) => a.role },
      { label: 'Channel', get: (a) => a.channel || '—' },
      { label: 'Status', get: (a) => a.status || '—' },
      { label: 'Created', get: (a) => (a.created_at || '').slice(0, 10) },
      { label: 'Updated', get: (a) => (a.updated_at || '').slice(0, 10) },
      { label: 'Posting', get: (a) => a.posting_id || '—' },
    ]),
  );
}
mirror.push('');
fs.mkdirSync(PATHS.data, { recursive: true });
fs.writeFileSync(PATHS.applicationsMd, mirror.join('\n'));

console.log(`Report: ${path.relative(process.cwd(), outFile)}`);
console.log(`Mirror: ${path.relative(process.cwd(), PATHS.applicationsMd)}`);
console.log(`Postings ${summary.postings} · scored ${summary.scored} · apply ${byDecision.apply || 0} · review ${byDecision.review || 0}`);
console.log(`Pending for you: ${drafted.length} draft(s) to send, ${toApply.length} link(s) to apply`);
if (stale.length) console.log(`Stale: ${stale.length} posting(s) older than 45 days`);
console.log(`\n${markdown}`);
