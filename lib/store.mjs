// Filesystem helpers and shared paths. The SQLite database (lib/db.mjs) is the
// system of record; the JSON files here are migration inputs or derived exports.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PATHS = {
  root: ROOT,
  data: path.join(ROOT, 'data'),
  out: path.join(ROOT, 'out'),
  profile: path.join(ROOT, 'data', 'profile.json'),
  db: path.join(ROOT, 'data', 'job-apply.db'),
  applicationsMd: path.join(ROOT, 'data', 'applications.md'),
  postings: path.join(ROOT, 'data', 'postings.json'),
  shortlist: path.join(ROOT, 'data', 'shortlist.json'),
  applications: path.join(ROOT, 'data', 'applications.json'),
  resume: path.join(ROOT, '..', 'repo', 'neo-portfolio', 'public', 'resume.pdf'),
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

export function loadProfile() {
  return readJson(PATHS.profile);
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
