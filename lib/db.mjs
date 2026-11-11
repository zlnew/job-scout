// SQLite persistence. The database is the system of record; the JSON files are
// migration inputs and derived exports (shortlist.json, applications.md).
//
// Uses the built-in node:sqlite driver (Node >= 22.5, no npm dependency).
// WAL + busy_timeout let an agent and a human write without clobbering each other.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PATHS, postingId } from './store.mjs';

let db = null;
let dbFile = null;

/** Schema history. Never edit an applied entry: append a new version instead. */
const MIGRATIONS = [
  {
    version: 1,
    up(conn) {
      conn.exec(`
        CREATE TABLE IF NOT EXISTS postings (
          id TEXT PRIMARY KEY,
          source TEXT,
          slug TEXT,
          title TEXT,
          company TEXT,
          city TEXT,
          remote INTEGER,
          salary TEXT,
          published TEXT,
          url TEXT,
          description TEXT,
          first_seen TEXT,
          last_seen TEXT
        );
        CREATE TABLE IF NOT EXISTS applications (
          id INTEGER PRIMARY KEY,
          posting_id TEXT,
          company TEXT,
          role TEXT,
          channel TEXT,
          status TEXT,
          score INTEGER,
          to_addr TEXT,
          subject TEXT,
          draft_id TEXT,
          notes TEXT,
          url TEXT,
          posted TEXT,
          created_at TEXT,
          updated_at TEXT,
          legacy_json TEXT
        );
        CREATE TABLE IF NOT EXISTS application_events (
          id INTEGER PRIMARY KEY,
          application_id INTEGER,
          at TEXT,
          status TEXT,
          note TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_applications_posting_id ON applications(posting_id);
        CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);
        CREATE INDEX IF NOT EXISTS idx_application_events_app ON application_events(application_id);
        CREATE INDEX IF NOT EXISTS idx_postings_published ON postings(published);
        CREATE INDEX IF NOT EXISTS idx_postings_company ON postings(company);
      `);
    },
  },
];

const APPLICATION_COLUMNS = ['posting_id', 'company', 'role', 'channel', 'status', 'score', 'to_addr', 'subject', 'draft_id', 'notes', 'url', 'posted'];
const INTERNAL_KEYS = new Set(['id', 'created_at', 'updated_at', 'applied_at', 'legacy_json']);

/** Open (and migrate) the database. Idempotent: a second call with the same path reuses the handle. */
export function openDb(file = PATHS.db) {
  if (db && dbFile === file) return db;
  if (db) closeDb();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const conn = new DatabaseSync(file);
  conn.exec('PRAGMA journal_mode=WAL');
  conn.exec('PRAGMA busy_timeout=5000');
  conn.exec('PRAGMA foreign_keys=ON');
  conn.exec('CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(conn.prepare('SELECT version FROM migrations').all().map((r) => r.version));
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    transaction(conn, () => {
      m.up(conn);
      conn.prepare('INSERT INTO migrations (version, applied_at) VALUES (?, ?)').run(m.version, new Date().toISOString());
    });
  }
  db = conn;
  dbFile = file;
  return db;
}

export function closeDb() {
  if (!db) return;
  db.close();
  db = null;
  dbFile = null;
}

function handle() {
  return db ?? openDb();
}

/** Multi-statement writes go through BEGIN IMMEDIATE so concurrent writers serialise. */
function transaction(conn, fn) {
  conn.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    conn.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      conn.exec('ROLLBACK');
    } catch {}
    throw err;
  }
}

// ---------- postings ----------

/**
 * Insert or refresh postings. Identity comes from postingId(), so re-scans update
 * instead of duplicating; first_seen is preserved and last_seen moves forward.
 */
export function upsertPostings(rows = []) {
  const conn = handle();
  const now = new Date().toISOString();
  const exists = conn.prepare('SELECT id FROM postings WHERE id = ?');
  const upsert = conn.prepare(`
    INSERT INTO postings (id, source, slug, title, company, city, remote, salary, published, url, description, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      source = excluded.source,
      slug = excluded.slug,
      title = excluded.title,
      company = excluded.company,
      city = excluded.city,
      remote = excluded.remote,
      salary = excluded.salary,
      published = excluded.published,
      url = excluded.url,
      description = excluded.description,
      last_seen = excluded.last_seen
  `);
  let added = 0;
  let updated = 0;
  transaction(conn, () => {
    for (const row of rows) {
      const id = row.id || postingId(row);
      const firstSeen = row.first_seen || row.seen_at || now;
      const lastSeen = row.last_seen || row.seen_at || now;
      if (exists.get(id)) updated += 1;
      else added += 1;
      upsert.run(
        id,
        row.source ?? null,
        row.slug ?? null,
        row.title ?? null,
        row.company ?? null,
        row.city ?? null,
        row.remote ? 1 : 0,
        row.salary ?? null,
        row.published ?? null,
        row.url ?? null,
        row.description ?? null,
        firstSeen,
        lastSeen,
      );
    }
  });
  return { added, updated };
}

function postingFromRow(row) {
  return {
    id: row.id,
    source: row.source,
    slug: row.slug,
    title: row.title,
    company: row.company,
    city: row.city,
    remote: Boolean(row.remote),
    salary: row.salary,
    published: row.published,
    url: row.url,
    description: row.description,
    first_seen: row.first_seen,
    last_seen: row.last_seen,
  };
}

export function listPostings() {
  return handle().prepare('SELECT * FROM postings ORDER BY published DESC, id').all().map(postingFromRow);
}

export function getPosting(id) {
  const row = handle().prepare('SELECT * FROM postings WHERE id = ?').get(id);
  return row ? postingFromRow(row) : null;
}

export function deletePosting(id) {
  return handle().prepare('DELETE FROM postings WHERE id = ?').run(id).changes > 0;
}

// ---------- applications ----------

function splitPatch(patch = {}) {
  const known = {};
  const legacy = {};
  for (const [key, value] of Object.entries(patch)) {
    if (APPLICATION_COLUMNS.includes(key)) known[key] = value;
    else if (!INTERNAL_KEYS.has(key)) legacy[key] = value;
  }
  return { known, legacy };
}

function applicationFromRow(row) {
  const { legacy_json: legacyJson, ...rest } = row;
  return { ...rest, legacy: legacyJson ? JSON.parse(legacyJson) : {} };
}

/**
 * Insert or update an application.
 *
 * With a posting_id the row is matched and updated; without one every call inserts.
 * A status transition appends an application_events row, so history is append-only.
 * Fields that have no curated column are merged into legacy_json instead of dropped.
 */
export function upsertApplication(patch = {}) {
  const conn = handle();
  const now = new Date().toISOString();
  const { known, legacy } = splitPatch(patch);
  const existing = known.posting_id
    ? conn.prepare('SELECT * FROM applications WHERE posting_id = ? ORDER BY id LIMIT 1').get(known.posting_id)
    : undefined;

  if (!existing) {
    const createdAt = patch.created_at || patch.applied_at || now;
    const updatedAt = patch.updated_at || createdAt;
    const columns = { ...known };
    if (patch.posting_id != null) columns.posting_id = patch.posting_id;
    columns.created_at = createdAt;
    columns.updated_at = updatedAt;
    columns.legacy_json = Object.keys(legacy).length ? JSON.stringify(legacy) : null;
    const names = Object.keys(columns);
    let id;
    transaction(conn, () => {
      id = Number(
        conn
          .prepare(`INSERT INTO applications (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`)
          .run(...names.map((n) => columns[n])).lastInsertRowid,
      );
      if (columns.status) appendEvent(conn, id, columns.status, 'created', updatedAt);
    });
    return { id, created: true, status_changed: Boolean(columns.status), previous_status: null, status: columns.status ?? null };
  }

  const previous = applicationFromRow(existing);
  const mergedLegacy = { ...previous.legacy, ...legacy };
  const next = { ...known };
  if (!('status' in known) || known.status === null) delete next.status;
  const statusChanged = 'status' in next && next.status !== previous.status;
  const assignments = [];
  const values = [];
  for (const [key, value] of Object.entries(next)) {
    assignments.push(`${key} = ?`);
    values.push(value);
  }
  assignments.push('updated_at = ?');
  values.push(patch.updated_at || now);
  assignments.push('legacy_json = ?');
  values.push(Object.keys(mergedLegacy).length ? JSON.stringify(mergedLegacy) : null);

  transaction(conn, () => {
    conn.prepare(`UPDATE applications SET ${assignments.join(', ')} WHERE id = ?`).run(...values, existing.id);
    if (statusChanged) appendEvent(conn, existing.id, next.status, 'status change', patch.updated_at || now);
  });

  return {
    id: existing.id,
    created: false,
    status_changed: statusChanged,
    previous_status: previous.status,
    status: statusChanged ? next.status : previous.status,
  };
}

function appendEvent(conn, applicationId, status, note, at = new Date().toISOString()) {
  return Number(
    conn
      .prepare('INSERT INTO application_events (application_id, at, status, note) VALUES (?, ?, ?, ?)')
      .run(applicationId, at, status ?? null, note ?? null).lastInsertRowid,
  );
}

export function addEvent(applicationId, status, note) {
  return appendEvent(handle(), applicationId, status, note);
}

export function listEvents(applicationId) {
  return handle().prepare('SELECT * FROM application_events WHERE application_id = ? ORDER BY id').all(applicationId);
}

export function listApplications() {
  return handle().prepare('SELECT * FROM applications ORDER BY created_at, id').all().map(applicationFromRow);
}

export function countEvents() {
  return handle().prepare('SELECT COUNT(*) AS c FROM application_events').get().c;
}
