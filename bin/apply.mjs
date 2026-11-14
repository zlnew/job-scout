#!/usr/bin/env node
// Stage 3: apply. Two channels, chosen explicitly, never guessed:
//
//   node bin/apply.mjs <id|company|index>                  # prints the on-site apply link
//   node bin/apply.mjs <id> --email --to x@y.z --body-file letter.txt
//
// --email creates a Gmail DRAFT with the CV attached and stops there. Nothing is ever
// sent by this script: a human opens Gmail and presses send. That boundary is the
// whole reason mail access is scoped to gmail.compose.

import fs from 'node:fs';
import path from 'node:path';
import { PATHS, readJson, loadProfile } from '../lib/store.mjs';
import { openDb, upsertApplication } from '../lib/db.mjs';
import { createGmailDraft } from '../lib/sources.mjs';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};

const target = args.find((a) => !a.startsWith('--') && a !== val('--to') && a !== val('--body-file') && a !== val('--subject'));
if (!target) {
  console.error('Usage: node bin/apply.mjs <id|company|index> [--email --to a@b.c --body-file letter.txt]');
  process.exit(1);
}

const shortlist = readJson(PATHS.shortlist, { entries: [] });
const entries = shortlist.entries || [];
if (!entries.length) {
  console.error('No shortlist. Run: node bin/shortlist.mjs');
  process.exit(1);
}

const needle = target.toLowerCase();
const picked =
  entries.find((e) => e.id.toLowerCase() === needle) ||
  entries.find((e) => (e.company || '').toLowerCase().includes(needle)) ||
  (Number.isInteger(Number(target)) ? entries[Number(target) - 1] : undefined) ||
  entries.find((e) => (e.title || '').toLowerCase().includes(needle));

if (!picked) {
  console.error(`No shortlist entry matches "${target}". Try: node bin/shortlist.mjs --top 20`);
  process.exit(1);
}

const profile = loadProfile();
openDb();

/**
 * Persist the intent in the DB. A status change appends an application_events row
 * (see lib/db.mjs), so the application log is append-only history, not overwrites.
 */
function record(patch) {
  const result = upsertApplication({
    posting_id: picked.id,
    company: picked.company,
    role: picked.title,
    score: picked.score,
    decision: picked.decision,
    url: picked.url,
    posted: picked.published,
    ...patch,
  });
  if (has('--json')) {
    console.log(
      JSON.stringify({
        application: { id: result.id, posting_id: picked.id, ...patch },
        created: result.created,
        status_changed: result.status_changed,
        previous_status: result.previous_status,
        status: result.status,
      }, null, 2),
    );
  }
  return result;
}

async function main() {
  const email = has('--email');

  if (!email) {
    console.log(`${picked.title} — ${picked.company}`);
    console.log(`Score ${picked.score} (${picked.decision})${picked.salary ? ` · listed ${picked.salary}` : ''}`);
    console.log(`Apply at: ${picked.url || '(no url in posting)'}`);
    const floor = profile?.compensation?.floor?.value;
    if (floor) console.log(`Salary line: ask ${(floor / 1e6).toFixed(0)}M+, do not go below the floor.`);
    record({ channel: 'site', status: 'to-apply', notes: 'link handed to human' });
    if (!has('--json')) console.log('\nRecorded as channel=site status=to-apply in the database (data/job-scout.db).');
    return;
  }

  const to = val('--to');
  const bodyFile = val('--body-file');
  if (!to || !bodyFile) {
    console.error('--email requires --to <address> and --body-file <path>.');
    process.exit(1);
  }
  if (!fs.existsSync(bodyFile)) {
    console.error(`Body file not found: ${bodyFile}`);
    process.exit(1);
  }

  const subject = val('--subject', `${picked.title} — Maulana Aprizqy Sumaryanto`);
  const body = fs.readFileSync(bodyFile, 'utf8');
  const resumePath = path.resolve(PATHS.data, profile?.work?.resumePath?.value || PATHS.resume);

  const draft = await createGmailDraft({
    to,
    subject,
    body,
    attachmentPath: resumePath,
    attachmentName: 'Maulana-Aprizqy-Sumaryanto-CV.pdf',
  });

  record({ channel: 'email', status: 'drafted', to_addr: to, subject, draft_id: draft.draftId, notes: 'draft created, waiting for human send' });
  console.log(`Draft created for ${picked.company} (${picked.title})`);
  console.log(`  to      : ${to}`);
  console.log(`  subject : ${subject}`);
  console.log(`  attached: ${resumePath}`);
  console.log(`  draft id: ${draft.draftId}`);
  console.log('\nOpen Gmail, read it, press send. This script never sends.');
}

main().catch((err) => {
  console.error(`apply failed: ${err.message}`);
  process.exit(1);
});
