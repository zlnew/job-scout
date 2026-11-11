// SQLite persistence. The database is the system of record; the JSON files are
// migration inputs and derived exports (shortlist.json, applications.md).
//
// Uses the built-in node:sqlite driver (Node >= 22.5, no npm dependency).
// WAL + busy_timeout let an agent and a human write without clobbering each other.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PATHS, postingId, loadProfileFromFile } from './store.mjs';

let db = null;
let dbFile = null;

/** The five skill groups the settings page edits, in display order. */
const SKILL_GROUPS = [
  { key: 'languages', title: 'Languages' },
  { key: 'frameworks', title: 'Frameworks & Libraries' },
  { key: 'data', title: 'Data & Infrastructure' },
  { key: 'protocols', title: 'Protocols & APIs' },
  { key: 'domain', title: 'Domain & Practices' },
];
const SKILL_KEY_BY_TITLE = new Map(SKILL_GROUPS.map((g) => [g.title, g.key]));
const SKILL_TITLE_BY_KEY = new Map(SKILL_GROUPS.map((g) => [g.key, g.title]));

function skillKey(title) {
  const known = SKILL_KEY_BY_TITLE.get(String(title ?? ''));
  if (known) return known;
  return String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'other';
}

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
  {
    version: 2,
    up(conn) {
      // One row per leaf setting. `value` is JSON so numbers, booleans and
      // arrays round-trip. `updated_at` NULL means the row still comes from the
      // seed file; non-NULL means a human edited it through settings.
      conn.exec(`
        CREATE TABLE IF NOT EXISTS profile_fields (
          path TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT
        );
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
  // Seed once, from the file, only while the table is empty. A human edit to
  // profile.json after this point is inert until `npm run reseed-profile`.
  if (countProfileFields(conn) === 0) {
    transaction(conn, () => seedProfileWith(conn, loadProfileFromFile()));
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
  // `id` selects an existing row directly. Without it, a row that has no posting_id
  // (every migrated historical entry) cannot be updated, only duplicated.
  const { id: rowId, ...fields } = patch || {};
  const { known, legacy } = splitPatch(fields);
  const existing = known.posting_id
    ? conn.prepare('SELECT * FROM applications WHERE posting_id = ? ORDER BY id LIMIT 1').get(known.posting_id)
    : rowId != null
      ? conn.prepare('SELECT * FROM applications WHERE id = ?').get(rowId)
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

// ---------- profile fields ----------

/**
 * Flatten the seed document into dotted path -> leaf value.
 *
 * A node shaped {value, source, scope} is a leaf (store only `value`). Arrays are
 * stored whole. The one exception is `skills`: the file holds display groups, while
 * settings edits five named lists, so it is decomposed into skills.<group>.
 */
export function flattenProfileSeed(profile = loadProfileFromFile()) {
  const out = new Map();
  const add = (parts, value) => out.set(parts.join('.'), value);

  const walk = (node, parts) => {
    if (Array.isArray(node)) {
      add(parts, node);
      return;
    }
    if (node && typeof node === 'object') {
      const keys = Object.keys(node);
      const wrapper = 'value' in node && keys.every((k) => ['value', 'source', 'scope'].includes(k));
      if (wrapper) {
        if (parts.length === 1 && parts[0] === 'skills') {
          for (const group of Array.isArray(node.value) ? node.value : []) {
            add(['skills', skillKey(group?.title)], Array.isArray(group?.items) ? group.items : []);
          }
          return;
        }
        add(parts, node.value);
        return;
      }
      for (const [key, value] of Object.entries(node)) walk(value, [...parts, key]);
      return;
    }
    add(parts, node);
  };

  walk(profile, []);
  return out;
}

function seedProfileWith(conn, profile) {
  const fields = flattenProfileSeed(profile);
  const insert = conn.prepare(
    'INSERT OR IGNORE INTO profile_fields (path, value, updated_at) VALUES (?, ?, NULL)',
  );
  let inserted = 0;
  for (const [path, value] of fields) inserted += insert.run(path, JSON.stringify(value)).changes;
  return inserted;
}

function countProfileFields(conn) {
  return conn.prepare('SELECT COUNT(*) AS n FROM profile_fields').get().n;
}

/** Re-seed the profile table from data/profile.json in one transaction. */
export function seedProfileFields(profile = loadProfileFromFile()) {
  const conn = handle();
  if (countProfileFields(conn) > 0) return { inserted: 0, total: flattenProfileSeed(profile).size };
  let inserted = 0;
  transaction(conn, () => {
    inserted = seedProfileWith(conn, profile);
  });
  return { inserted, total: flattenProfileSeed(profile).size };
}

/** path -> {value, source, updated_at}; source is "db" once a human edited it. */
export function listProfileFields() {
  const rows = handle().prepare('SELECT path, value, updated_at FROM profile_fields ORDER BY path').all();
  const out = {};
  for (const row of rows) {
    out[row.path] = {
      value: JSON.parse(row.value),
      source: row.updated_at ? 'db' : 'seed',
      updated_at: row.updated_at ?? null,
    };
  }
  return out;
}

function setPath(root, parts, leaf) {
  let node = root;
  for (const key of parts.slice(0, -1)) {
    if (!node[key] || typeof node[key] !== 'object' || Array.isArray(node[key])) node[key] = {};
    node = node[key];
  }
  node[parts[parts.length - 1]] = leaf;
}

/**
 * Assemble the nested profile from profile_fields. The wrapper shape is kept
 * ({value, source, scope}) because score.mjs and letter.mjs read `.value`.
 */
export function loadProfileFromDb() {
  const rows = handle().prepare('SELECT path, value, updated_at FROM profile_fields ORDER BY path').all();
  const profile = {};
  const skills = [];

  for (const row of rows) {
    const value = JSON.parse(row.value);
    const parts = row.path.split('.');
    const source = row.updated_at ? 'db' : 'seed';

    if (parts[0] === 'skills') {
      skills.push({ key: parts[1], value, source });
      continue;
    }
    if (parts[0] === 'meta') {
      setPath(profile, parts, value);
      continue;
    }
    if (row.path === 'blockedTopics') {
      profile.blockedTopics = value;
      continue;
    }
    setPath(profile, parts, { value, source, scope: 'all' });
  }

  if (skills.length) {
    const order = new Map(SKILL_GROUPS.map((g, index) => [g.key, index]));
    skills.sort((a, b) => (order.get(a.key) ?? 99) - (order.get(b.key) ?? 99));
    profile.skills = {
      value: skills.map((s) => ({ title: SKILL_TITLE_BY_KEY.get(s.key) || s.key, items: s.value })),
      source: skills.some((s) => s.source === 'db') ? 'db' : 'seed',
      scope: 'all',
    };
  }

  return profile;
}

/**
 * Write several fields in one transaction. Paths must already exist in the seeded
 * schema: an unknown path throws before anything is written.
 */
export function setProfileFields(fields = {}) {
  const entries = Object.entries(fields);
  if (!entries.length) return { updated: [] };
  const conn = handle();
  const exists = conn.prepare('SELECT 1 AS ok FROM profile_fields WHERE path = ?');
  const unknown = entries.map(([path]) => path).filter((path) => !exists.get(path));
  if (unknown.length) throw new Error(`unknown profile field path: ${unknown.join(', ')}`);

  const now = new Date().toISOString();
  transaction(conn, () => {
    const update = conn.prepare('UPDATE profile_fields SET value = ?, updated_at = ? WHERE path = ?');
    for (const [path, value] of entries) update.run(JSON.stringify(value), now, path);
  });
  return { updated: entries.map(([path]) => path) };
}

export function setProfileField(path, value) {
  return setProfileFields({ [path]: value });
}

/**
 * Compare the seed file with the DB without touching anything. `apply` mirrors the
 * file into the table (including removing paths the file no longer has) and resets
 * those rows to source "seed".
 */
export function reseedProfile({ apply = false, profile = loadProfileFromFile() } = {}) {
  const conn = handle();
  const seed = flattenProfileSeed(profile);
  const current = new Map(
    conn.prepare('SELECT path, value FROM profile_fields').all().map((row) => [row.path, row.value]),
  );
  const added = [];
  const changed = [];
  let unchanged = 0;
  for (const [path, value] of seed) {
    const encoded = JSON.stringify(value);
    if (!current.has(path)) added.push(path);
    else if (current.get(path) !== encoded) changed.push({ path, from: JSON.parse(current.get(path)), to: value });
    else unchanged += 1;
  }
  const removed = [...current.keys()].filter((path) => !seed.has(path)).sort();

  if (apply) {
    transaction(conn, () => {
      const upsert = conn.prepare(`
        INSERT INTO profile_fields (path, value, updated_at) VALUES (?, ?, NULL)
        ON CONFLICT(path) DO UPDATE SET value = excluded.value, updated_at = NULL
      `);
      for (const [path, value] of seed) upsert.run(path, JSON.stringify(value));
      const remove = conn.prepare('DELETE FROM profile_fields WHERE path = ?');
      for (const path of removed) remove.run(path);
    });
  }

  return { apply, added, changed, removed, unchanged, total: seed.size };
}
