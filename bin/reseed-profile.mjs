#!/usr/bin/env node
// Re-seed profile_fields from data/profile.json.
//
//   npm run reseed-profile              # report what would change
//   npm run reseed-profile -- --apply   # write the file into the DB
//
// Opening the dashboard or running a CLI stage never re-seeds an existing table,
// so a hand edit to profile.json is inert until this command is run with --apply.
import { openDb, closeDb, reseedProfile } from '../lib/db.mjs';

const apply = process.argv.slice(2).includes('--apply');

openDb();
const result = reseedProfile({ apply });

console.log(
  `profile_fields: ${result.total} seeded paths, ${result.added.length} added, ` +
    `${result.changed.length} changed, ${result.removed.length} removed, ${result.unchanged} unchanged`,
);

for (const path of result.added) console.log(`ADDED ${path}`);
for (const item of result.changed) {
  console.log(`CHANGED ${item.path}: ${JSON.stringify(item.from)} -> ${JSON.stringify(item.to)}`);
}
for (const path of result.removed) console.log(`REMOVED ${path}`);

if (apply) {
  console.log('Applied: profile_fields now mirrors data/profile.json (source "seed").');
} else if (result.added.length || result.changed.length || result.removed.length) {
  console.log('Dry run. Re-run with --apply to write these changes.');
} else {
  console.log('No changes. The database already matches data/profile.json.');
}

closeDb();
