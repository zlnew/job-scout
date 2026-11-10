/**
 * Health check for the local data, adapters and sessions (S6).
 *
 *   node cli/doctor.mjs [--store <applications.json>] [--profile <profile.json>]
 *                       [--backups <dir>]
 *
 * Read-only by design: it reports and never migrates, writes or launches a
 * browser, so it is safe to run before a commit or after a crash.
 * Exit codes: 0 healthy, 6 at least one check failed.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { ADAPTERS, assertAdapterContract } from '../adapters/index.mjs';
import { listSources } from '../boards/index.mjs';
import { loadProfile } from '../core/guard.mjs';
import { backupDirFor } from '../core/ledger.mjs';
import { MAX_BACKUPS, SCHEMA_VERSION, migrate, readJson } from '../core/store.mjs';
import { PROFILE, parseArgs } from '../scripts/browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const STORE = join(ROOT, 'applications.json');
const PROFILE_PATH = join(ROOT, 'data/profile.json');
const FIXTURES = join(ROOT, 'fixtures/ats');
const USAGE = [
  'usage: node cli/doctor.mjs [--store <applications.json>] [--profile <profile.json>] [--backups <dir>]',
].join('\n');

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

const storePath = resolve(args.store ?? STORE);
const profilePath = resolve(args.profile ?? PROFILE_PATH);
const backupsDir = resolve(args.backups ?? backupDirFor(storePath));

const rows = [];
const pass = (check, detail) => rows.push({ check, status: 'ok', detail });
const note = (check, detail) => rows.push({ check, status: 'info', detail });
const problem = (check, detail, fix) => rows.push({ check, status: 'fail', detail, fix });

// 1. The ledger store must parse before any other store check means anything.
let store = null;
try {
  const parsed = readJson(storePath);
  store = migrate(parsed).store;
  pass('store', `${basename(storePath)} is valid JSON (${store.applications.length} record(s))`);
} catch (error) {
  problem('store', error.message, error.fix ?? 'run: node cli/scan.mjs --write to create the ledger, or fix --store');
}

// 2. A v1 store is readable and self-heals on the next write; a newer one is not.
if (!store) {
  problem('schemaVersion', 'skipped: the store could not be read', 'fix the store row first');
} else if (store.schemaVersion === SCHEMA_VERSION) {
  pass('schemaVersion', String(SCHEMA_VERSION));
} else {
  note('schemaVersion', `${store.schemaVersion} -> ${SCHEMA_VERSION} on the next write`);
}

// 3. Provenance is the one profile rule the whole guard depends on.
try {
  loadProfile(profilePath);
  pass('profile', 'provenance valid');
} catch (error) {
  problem('profile', error.message, error.fix ?? 'check that --profile points at data/profile.json');
}

// 4. Backups are the recovery path for every write; the cap must actually hold.
if (!existsSync(backupsDir)) {
  pass('backups', 'none yet (created on the first write)');
} else {
  const files = readdirSync(backupsDir).filter((name) => name.endsWith('.json')).sort();
  if (files.length > MAX_BACKUPS) {
    problem('backups', `${files.length} backups, over the ${MAX_BACKUPS} cap`, `remove the oldest files in ${backupsDir}`);
  } else {
    let newest = 'none';
    try {
      const newestFile = files.at(-1);
      if (newestFile) {
        readJson(join(backupsDir, newestFile));
        newest = `newest ${newestFile} parses`;
      }
      pass('backups', `${files.length}/${MAX_BACKUPS} kept, ${newest}`);
    } catch (error) {
      problem('backups', error.message, `restore or remove the newest file in ${backupsDir}`);
    }
  }
}

// 5. Every adapter must satisfy its contract and keep a saved fixture the tests use.
const adapterProblems = [];
for (const adapter of ADAPTERS) {
  try {
    assertAdapterContract(adapter);
  } catch (error) {
    adapterProblems.push(error.message);
    continue;
  }
  // The generic fallback has no ATS snapshot; the specific adapters each do.
  if (adapter.name !== 'generic' && !existsSync(join(FIXTURES, adapter.name, 'form.html'))) {
    adapterProblems.push(`adapter "${adapter.name}" is missing fixtures/ats/${adapter.name}/form.html`);
  }
}
if (adapterProblems.length > 0) {
  problem('adapters', adapterProblems.join('; '), 'restore the missing fixture or fix the adapter contract');
} else {
  pass('adapters', `${ADAPTERS.length} adapters, fixtures present`);
}

// 6. Per-source session status. Only LinkedIn has an offline marker; the
// scraped boards report `unverified` until a headed run confirms them (S9.1).
for (const source of listSources()) {
  if (source.name !== 'linkedin') {
    note(source.name, 'unverified');
    continue;
  }
  if (existsSync(join(PROFILE, 'Default', 'Cookies'))) {
    pass('linkedin', 'session file present');
  } else {
    problem('linkedin', `no session file in ${PROFILE}`, 'run: npm run login -- linkedin');
  }
}

// 7. The pre-commit suite is reported, never run: doctor must stay fast and read-only.
let hooksPath = '';
let gitRoot = ROOT;
try {
  hooksPath = execFileSync('git', ['config', '--get', 'core.hooksPath'], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' }).trim();
  // The hook lives in the git root, which is the workspace above job-apply.
  gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' }).trim();
} catch {
  hooksPath = '';
}
if (hooksPath === '.githooks' && existsSync(join(gitRoot, '.githooks/pre-commit'))) {
  pass('hook', 'installed: npm test runs on every commit');
} else {
  note('hook', 'not installed: run git config core.hooksPath .githooks');
}

const width = Math.max(...rows.map((row) => row.check.length)) + 2;
console.log(`${'check'.padEnd(width)}${'status'.padEnd(8)}detail`);
for (const row of rows) {
  console.log(`${row.check.padEnd(width)}${row.status.padEnd(8)}${row.detail}`);
  if (row.fix) console.log(`${''.padEnd(width + 8)}fix: ${row.fix}`);
}

const failed = rows.filter((row) => row.status === 'fail');
console.log(`\n${rows.length} checks, ${failed.length} failed`);
process.exit(failed.length === 0 ? 0 : 6);
