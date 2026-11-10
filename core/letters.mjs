/**
 * Cover letters as per-application documents with an append-only revision
 * history (S7).
 *
 *   data/letters/<identityKey>/index.json   metadata: current revision + list
 *   data/letters/<identityKey>/vN.md        the body of revision N
 *
 * The key is the guard's, so a letter is bound to the same application record
 * as the ledger entry and a submission can record which revision it sent.
 *
 * Revisions are immutable: an edit appends vN+1 and moves `current`. Only
 * `index.json` mutates, and it is written through the store's safe write
 * (rotated backup + atomic rename), so a crash leaves either the previous
 * index or the next one, never a torn file.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { identityKey as guardKey } from './guard.mjs';
import { CodedError } from './result.mjs';
import { readJson, writeJsonSafe } from './store.mjs';

export const LETTERS_DIR = join(resolve(import.meta.dirname, '..'), 'data/letters');
export const ORIGINS = Object.freeze(['generated', 'edited']);

// The key names a directory, so anything that is not a plain slug is refused
// rather than allowed to escape the letters root through `--id`.
const KEY_PATTERN = /^[0-9a-z][0-9a-z-]{7,63}$/;

const countWords = (text) => text.trim().split(/\s+/).length;
const letterDir = (root, key) => join(root, key);
const indexPath = (root, key) => join(letterDir(root, key), 'index.json');
const bodyPath = (root, key, revision) => join(letterDir(root, key), `v${revision}.md`);

function assertKey(identityKey) {
  if (typeof identityKey !== 'string' || !KEY_PATTERN.test(identityKey)) {
    throw new CodedError('letter-invalid', { message: `"${identityKey}" is not an application identity`, detail: String(identityKey) });
  }
}

/**
 * Write a revision body atomically. `writeJsonAtomic` would JSON-encode the
 * text, so this mirrors its temp-file-then-rename instead.
 */
function writeTextAtomic(path, text) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, text);
    renameSync(temp, path);
  } catch (error) {
    // A failed write must not leave its half-written temp file behind.
    rmSync(temp, { force: true });
    throw error;
  }
}

/** The index for one application, or null when it has no letter yet. */
function loadIndex(identityKey, root) {
  assertKey(identityKey);
  const path = indexPath(root, identityKey);
  if (!existsSync(path)) return null;
  return readJson(path);
}

/** The shape `listLetters` and `lettersFor` return: no body, so a list is cheap. */
function summarise(index) {
  const current = index.revisions.find((entry) => entry.revision === index.current);
  return {
    identityKey: index.identityKey,
    company: index.company,
    role: index.role,
    current: index.current,
    revisions: index.revisions.length,
    words: current?.words ?? 0,
  };
}

/** Every stored letter, oldest key first so a listing is deterministic. */
export function listLetters({ root = LETTERS_DIR } = {}) {
  if (!existsSync(root)) return [];
  const keys = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const letters = [];
  for (const key of keys) {
    const index = loadIndex(key, root);
    if (index) letters.push(summarise(index));
  }
  return letters;
}

/** One revision of one letter; defaults to the current revision. */
export function readLetter(identityKey, revision, { root = LETTERS_DIR } = {}) {
  const index = loadIndex(identityKey, root);
  if (!index) {
    throw new CodedError('letter-not-found', {
      message: `no letter is stored for application ${identityKey}`,
      detail: identityKey,
    });
  }

  const wanted = revision === undefined ? index.current : Number(revision);
  const entry = index.revisions.find((candidate) => candidate.revision === wanted);
  if (!entry) {
    throw new CodedError('letter-revision-not-found', {
      message: `letter ${identityKey} has no revision ${revision}; its current revision is ${index.current}`,
      detail: String(revision),
    });
  }

  const path = bodyPath(root, identityKey, entry.revision);
  return { ...index, ...entry, text: readFileSync(path, 'utf8'), path };
}

/**
 * Append a revision and make it current. The body lands before the index, so a
 * failed body write leaves the previous index describing the previous state.
 */
export function appendRevision(identityKey, { text, origin, note } = {}, { root = LETTERS_DIR, company, role } = {}) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new CodedError('letter-empty', { message: 'a letter revision needs text', detail: identityKey });
  }
  if (!ORIGINS.includes(origin)) {
    throw new CodedError('letter-invalid', {
      message: `letter origin must be one of ${ORIGINS.join(', ')}; got ${JSON.stringify(origin ?? null)}`,
      detail: origin,
    });
  }

  const index = loadIndex(identityKey, root);
  // `current` may point at an older revision, so number from the newest one.
  const revision = Math.max(0, ...(index?.revisions ?? []).map((entry) => entry.revision)) + 1;

  writeTextAtomic(bodyPath(root, identityKey, revision), text);

  writeJsonSafe(indexPath(root, identityKey), {
    identityKey,
    company: company ?? index?.company ?? '',
    role: role ?? index?.role ?? '',
    current: revision,
    revisions: [
      ...(index?.revisions ?? []),
      {
        revision,
        createdAt: new Date().toISOString(),
        origin,
        words: countWords(text),
        ...(note ? { note } : {}),
      },
    ],
  });
  return revision;
}

/** Point `current` at an existing revision, which is how the UI picks what is sent. */
export function setCurrent(identityKey, revision, { root = LETTERS_DIR } = {}) {
  const index = loadIndex(identityKey, root);
  if (!index) {
    throw new CodedError('letter-not-found', {
      message: `no letter is stored for application ${identityKey}`,
      detail: identityKey,
    });
  }

  const wanted = Number(revision);
  if (!index.revisions.some((entry) => entry.revision === wanted)) {
    throw new CodedError('letter-revision-not-found', {
      message: `letter ${identityKey} has no revision ${revision}; its current revision is ${index.current}`,
      detail: String(revision),
    });
  }

  writeJsonSafe(indexPath(root, identityKey), { ...index, current: wanted });
  return wanted;
}

/** The letter summary for one ledger record, or null when it has none. */
export function lettersFor(record, { root = LETTERS_DIR } = {}) {
  if (!record) return null;
  const index = loadIndex(record.identityKey ?? guardKey(record), root);
  return index ? summarise(index) : null;
}
