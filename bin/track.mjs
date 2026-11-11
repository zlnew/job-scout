#!/usr/bin/env node
// Stage 3b — track. Moves an application through its lifecycle and appends history.
//
//   node bin/track.mjs --list
//   node bin/track.mjs ajaib --status applied --note "applied via careers page"
//   node bin/track.mjs ajaib --history
//   node bin/track.mjs --json
//
// Statuses: to-apply · drafted · applied · replied · interview · offer · rejected · closed

import { listApplications, listEvents, upsertApplication, openDb, closeDb } from '../lib/db.mjs';
import { renderTable } from '../lib/store.mjs';

const STATUSES = ['to-apply', 'drafted', 'applied', 'replied', 'interview', 'offer', 'rejected', 'closed'];
const OPEN = new Set(['to-apply', 'drafted', 'applied', 'replied', 'interview']);

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};

const target = args.find((a) => !a.startsWith('--') && a !== val('--status') && a !== val('--note'));

function resolve(applications, needle) {
  const n = needle.toLowerCase();
  const exact = applications.find((a) => (a.posting_id || '').toLowerCase() === n);
  if (exact) return exact;
  const matches = applications.filter(
    (a) =>
      (a.company || '').toLowerCase().includes(n) ||
      (a.role || '').toLowerCase().includes(n) ||
      (a.posting_id || '').toLowerCase().includes(n),
  );
  if (!matches.length) return null;
  // A company can have both an open application and old migrated history. Never let the
  // newest row win by id alone: an open lifecycle row is always the intended target.
  const open = matches.filter((a) => OPEN.has(a.status));
  const pool = open.length ? open : matches;
  return pool.sort((a, b) => b.id - a.id)[0];
}

function showHistory(app) {
  const events = listEvents(app.id);
  console.log(`\n${app.role} @ ${app.company} — ${app.status || 'unknown'}`);
  if (!events.length) {
    console.log('  (no events recorded)');
    return;
  }
  for (const e of events) console.log(`  ${e.at.slice(0, 16).replace('T', ' ')}  ${e.status}${e.note ? ` — ${e.note}` : ''}`);
}

function main() {
  openDb();
  const applications = listApplications();

  if (has('--list') || (!target && !has('--json'))) {
    const open = applications.filter((a) => OPEN.has(a.status) || !a.status);
    const closed = applications.length - open.length;
    console.log(`${applications.length} tracked · ${open.length} open · ${closed} closed\n`);
    if (!open.length) console.log('_Nothing open._');
    else {
      console.log(
        renderTable(open.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '')), [
          { label: 'Status', get: (a) => a.status || '—' },
          { label: 'Role', get: (a) => a.role },
          { label: 'Company', get: (a) => a.company },
          { label: 'Channel', get: (a) => a.channel || '—' },
          { label: 'Updated', get: (a) => (a.updated_at || '').slice(0, 10) },
        ]),
      );
    }
    console.log('\nNext: node bin/track.mjs <company> --status applied');
    return;
  }

  if (has('--json')) {
    console.log(JSON.stringify({ applications }, null, 2));
    return;
  }

  if (!target) {
    console.error('Nothing to do. Use --list, or: node bin/track.mjs <company> --status <status>');
    process.exitCode = 1;
    return;
  }

  const app = resolve(applications, target);
  if (!app) {
    console.error(`No application matches "${target}". Try: node bin/track.mjs --list`);
    process.exitCode = 1;
    return;
  }

  if (has('--history') || !val('--status')) {
    showHistory(app);
    return;
  }

  const status = val('--status');
  if (!STATUSES.includes(status)) {
    console.error(`Unknown status "${status}". One of: ${STATUSES.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  // Track only ever moves a row that already exists; creating applications is apply.mjs's job.
  const result = upsertApplication({ id: app.id, posting_id: app.posting_id, status, notes: val('--note', app.notes) });
  console.log(
    result.status_changed
      ? `${app.company}: ${result.previous_status || 'none'} → ${result.status}`
      : `${app.company}: already ${result.status}, no change`,
  );
  showHistory({ ...app, status: result.status });
}

try {
  main();
} finally {
  closeDb();
}
