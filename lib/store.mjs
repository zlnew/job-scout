// Filesystem helpers and shared paths. The SQLite database (lib/db.mjs) is the
// system of record; the JSON files here are migration inputs or derived exports.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadProfileFromDb } from './db.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The workspace root holds sibling repos under repo/. Resolve it from git itself:
// a linked worktree still points at the original repo through --git-common-dir.
export function findWorkspaceRoot() {
  if (process.env.WORKSPACE_ROOT) return path.resolve(process.env.WORKSPACE_ROOT);
  const looksRight = (d) => fs.existsSync(path.join(d, '_memory')) && fs.existsSync(path.join(d, 'repo'));
  let dir = ROOT;
  for (let i = 0; i < 6; i++) {
    if (looksRight(dir)) return dir;
    dir = path.dirname(dir);
  }
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8' }).trim();
    let d = path.dirname(common);
    for (let i = 0; i < 6; i++) {
      if (looksRight(d)) return d;
      d = path.dirname(d);
    }
  } catch { /* not a git checkout */ }
  return path.resolve(ROOT, '..', '..');
}
export const WORKSPACE = findWorkspaceRoot();
export const PATHS = {
  root: ROOT,
  data: path.join(ROOT, 'data'),
  out: path.join(ROOT, 'out'),
  profile: path.join(ROOT, 'data', 'profile.json'),
  // JOB_APPLY_DB points the whole harness at another database file, which is how the
  // tests (and a throwaway copy) run without touching the real application log.
  db: process.env.JOB_APPLY_DB || path.join(ROOT, 'data', 'job-scout.db'),
  applicationsMd: path.join(ROOT, 'data', 'applications.md'),
  postings: path.join(ROOT, 'data', 'postings.json'),
  shortlist: path.join(ROOT, 'data', 'shortlist.json'),
  applications: path.join(ROOT, 'data', 'applications.json'),
  resume: path.join(WORKSPACE, 'repo', 'neo-portfolio', 'public', 'resume.pdf'),
};

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw err;
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** The seed document on disk. Not the source of truth after the first seed. */
export function loadProfileFromFile() {
  return readJson(PATHS.profile);
}

/** The profile assembled from profile_fields, so edits made in settings win. */
export function loadProfile() {
  return loadProfileFromDb();
}

/** Posting identity is stable per source+slug, so re-scans update instead of duplicating. */
export function postingId(job) {
  const base = job.slug || job.url || `${job.company}-${job.title}`;
  return `${job.source || 'unknown'}:${base}`.toLowerCase().replace(/\s+/g, '-');
}

export function mergePostings(existing = [], incoming = []) {
  const byId = new Map(existing.map((p) => [p.id, p]));
  let added = 0;
  let updated = 0;
  for (const job of incoming) {
    const id = postingId(job);
    const next = { ...job, id, seen_at: new Date().toISOString() };
    if (byId.has(id)) {
      byId.set(id, { ...byId.get(id), ...next });
      updated += 1;
    } else {
      byId.set(id, next);
      added += 1;
    }
  }
  return { postings: [...byId.values()], added, updated };
}

/** Location label for tables: never renders "null"/"undefined" when a posting has no city. */
export function whereLabel(row) {
  const city = String(row?.city ?? '').trim();
  const remote = Boolean(row?.remote);
  if (city && remote) return `${city} +remote`;
  if (city) return city;
  return remote ? 'remote' : '—';
}

export function renderTable(rows, columns) {
  const head = `| ${columns.map((c) => c.label).join(' | ')} |`;
  const rule = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${columns.map((c) => String(c.get(r) ?? '').replace(/\|/g, '\\|')).join(' | ')} |`);
  return [head, rule, ...body].join('\n');
}
