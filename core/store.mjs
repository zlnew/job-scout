/**
 * Atomic, versioned JSON persistence for job-apply data files (S6).
 *
 * Every write lands in a temp file inside the target's own directory and is
 * renamed over the target, so a crash mid-write can never truncate the store.
 * A rotated backup keeps the newest states, so a bad write is recoverable by
 * hand instead of from memory.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { CodedError } from './result.mjs';

export const SCHEMA_VERSION = 2;
export const MAX_BACKUPS = 20;

/** Parse one JSON file; invalid content is a coded error naming the fix. */
export function readJson(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') throw error;
    throw new CodedError('store-corrupt', { message: `${basename(path)} could not be read: ${error.message}`, detail: path });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CodedError('store-corrupt', { message: `${basename(path)} is not valid JSON: ${error.message}`, detail: path });
  }
}

/** Write JSON through a sibling temp file and a rename; the old file survives any failure. */
export function writeJsonAtomic(path, value) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(temp, path);
  } catch (error) {
    // A failed write must not leave its half-written temp file behind.
    rmSync(temp, { force: true });
    throw error;
  }
}

/**
 * Keep the newest `MAX_BACKUPS` files for this store and drop the rest. Names
 * embed an ISO timestamp, so a plain name sort is oldest-first.
 */
function pruneBackups(backupDir, stem, keep) {
  const prefix = `${stem}.`;
  const backups = readdirSync(backupDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .sort();
  for (const name of backups.slice(0, Math.max(0, backups.length - keep))) {
    rmSync(join(backupDir, name), { force: true });
  }
}

/**
 * Copy the current file into `backupDir` before it is replaced. Returns the
 * backup path, or null when there is no previous file to protect.
 */
export function backupBeforeWrite(path, { backupDir = join(dirname(path), 'backups'), keep = MAX_BACKUPS } = {}) {
  if (!existsSync(path)) return null;
  mkdirSync(backupDir, { recursive: true });
  const stem = basename(path).replace(/\.json$/, '');
  const stamp = new Date().toISOString().replaceAll(':', '-');
  const backup = join(backupDir, `${stem}.${stamp}.json`);
  copyFileSync(path, backup);
  pruneBackups(backupDir, stem, keep);
  return backup;
}

/** The safe write every data file uses: rotate a backup, then replace atomically. */
export function writeJsonSafe(path, value, options = {}) {
  const backup = backupBeforeWrite(path, options);
  writeJsonAtomic(path, value);
  return backup;
}

/**
 * Bring a store up to `SCHEMA_VERSION` in memory. Migrations add the version
 * and normalise the shape; an unknown or future schema refuses rather than
 * writing a shape this build does not understand.
 */
export function migrate(store) {
  const version = Array.isArray(store) ? 1 : Number(store?.schemaVersion ?? 1);
  if (!Number.isInteger(version) || version < 1) {
    throw new CodedError('store-schema', { message: `data file schema ${JSON.stringify(store?.schemaVersion ?? null)} is not valid` });
  }
  if (version > SCHEMA_VERSION) {
    throw new CodedError('store-schema', {
      message: `data file schema ${version} is newer than this build understands (${SCHEMA_VERSION})`,
    });
  }

  const next = Array.isArray(store) ? { applications: store } : { ...store };
  next.schemaVersion = SCHEMA_VERSION;
  if (!Array.isArray(next.applications)) next.applications = [];
  return { store: next, migrated: version !== SCHEMA_VERSION };
}
