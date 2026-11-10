/**
 * Pure request handlers for the local control UI.
 *
 * Every handler takes an already-parsed request body and returns an HTTP-shaped
 * `{ status, headers, body }` object, so the same code is exercised by tests
 * without a socket. Authority stays where it already lives: the ledger owns
 * transitions, `loadProfile` owns provenance, and prepare/apply run the real
 * CLI entry points in a child process instead of reimplementing them.
 *
 * No browser state, cookies, or CDP URLs are read here; the UI has no view of
 * them at all.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { jobIdFromUrl } from '../boards/linkedin.mjs';
import { identityKey, loadProfile } from '../core/guard.mjs';
import { appendEvent, applyTransition, readStore, writeStore } from '../core/ledger.mjs';
import { describe } from '../core/screening.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const MAX_OUTPUT = 64 * 1024;
const JSON_HEADERS = Object.freeze({ 'content-type': 'application/json; charset=utf-8' });

const json = (status, payload) => ({ status, headers: JSON_HEADERS, body: JSON.stringify(payload) });
const fail = (status, message) => json(status, { error: message });

/** Board order: best score first, newest posting first within a score. */
function boardOrder(a, b) {
  const score = (b.score ?? -1) - (a.score ?? -1);
  if (score !== 0) return score;
  return String(b.posted ?? '').localeCompare(String(a.posted ?? ''));
}

function countByStatus(records) {
  const counts = {};
  for (const record of records) {
    const status = record.status ?? 'unknown';
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

const keyOf = (record) => record.identityKey ?? identityKey(record);

/** Accept the identity key the board renders as well as a LinkedIn id or URL. */
function findRecord(records, id) {
  const wanted = String(id ?? '').trim();
  if (!wanted) return null;
  return (
    records.find(
      (record) =>
        record.identityKey === wanted ||
        String(record.linkedinId ?? '') === wanted ||
        jobIdFromUrl(record.url ?? '') === wanted,
    ) ?? null
  );
}

/** Dotted/bracketed profile path, e.g. `answers.age` or `education[0].school`. */
const steps = (key) => key.split(/\.|\[(\d+)\]/).filter((step) => step !== '' && step !== undefined);

function setAnswer(profile, key, answer) {
  const parts = steps(key);
  if (parts.length === 0) throw new Error('answer key is empty');
  let node = profile;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (!node[part] || typeof node[part] !== 'object') {
      node[part] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    }
    node = node[part];
  }
  node[parts.at(-1)] = answer;
}

/**
 * Validate through the real `loadProfile` before the committed file is touched.
 * The candidate is written to a throwaway directory outside the worktree.
 */
function validateCandidate(profile) {
  const dir = mkdtempSync(join(tmpdir(), 'job-apply-ui-'));
  try {
    const path = join(dir, 'profile.json');
    writeFileSync(path, `${JSON.stringify(profile, null, 2)}\n`);
    loadProfile(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const isScalar = (value) =>
  typeof value === 'string' ||
  typeof value === 'boolean' ||
  (typeof value === 'number' && Number.isFinite(value));

export function createHandlers({
  storePath = join(ROOT, 'applications.json'),
  profilePath = join(ROOT, 'data/profile.json'),
  eventsPath = join(ROOT, 'data/events.jsonl'),
  uiPath = join(ROOT, 'ui/index.html'),
  spawn = nodeSpawn,
  root = ROOT,
} = {}) {
  const jobs = new Map();
  const queue = [];
  let draining = false;

  const appendOutput = (job, chunk) => {
    job.output = (job.output + String(chunk)).slice(-MAX_OUTPUT);
  };

  function finish(job, code, detail) {
    if (job.state !== 'running') return;
    job.exitCode = code;
    if (code === 0) {
      job.state = 'done';
    } else {
      job.state = 'error';
      if (detail) appendOutput(job, `\n${detail}\n`);
    }
    draining = false;
    drain();
  }

  // One slot: a second browser job waits for the first, so two Chromium
  // profiles never race over the same session.
  function drain() {
    if (draining) return;
    const next = queue.shift();
    if (!next) return;
    draining = true;
    const { job, command, args } = next;
    job.state = 'running';

    let child;
    try {
      child = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      finish(job, null, `spawn failed: ${error.message}`);
      return;
    }

    child.stdout?.on('data', (chunk) => appendOutput(job, chunk));
    child.stderr?.on('data', (chunk) => appendOutput(job, chunk));
    child.on('error', (error) => finish(job, null, `spawn failed: ${error.message}`));
    child.on('close', (code) => finish(job, code, code === 0 ? '' : `exited with code ${code}`));
  }

  function enqueue(command, args) {
    const job = { id: randomUUID(), state: 'queued', output: '', exitCode: null };
    jobs.set(job.id, job);
    queue.push({ job, command, args });
    drain();
    return job;
  }

  const jobView = (job) => ({ state: job.state, output: job.output });

  /** A record plus the LinkedIn id the CLI needs; `error` is the HTTP failure. */
  function cliTarget(id) {
    const records = readStore(storePath);
    const record = findRecord(records, id);
    if (!record) return { error: fail(404, `no record for ${JSON.stringify(String(id ?? ''))}`) };
    const linkedinId = record.linkedinId ? String(record.linkedinId) : jobIdFromUrl(record.url ?? '');
    if (!linkedinId) return { error: fail(400, 'record has no LinkedIn id to run the CLI with') };
    return { record, linkedinId };
  }

  function getBoard() {
    const records = readStore(storePath);
    return json(200, {
      records: [...records].sort(boardOrder),
      counts: countByStatus(records),
      gaps: describe(loadProfile(profilePath)),
    });
  }

  function postAnswers(body) {
    if (!body || typeof body !== 'object') return fail(400, 'expected a JSON body');
    const { key, value } = body;
    if (typeof key !== 'string' || !key.trim()) return fail(400, 'key is required');
    if (!isScalar(value)) return fail(400, 'value must be a string, number, or boolean');

    const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
    const blocked = Array.isArray(profile.blockedTopics) ? profile.blockedTopics : [];
    if (!blocked.some((entry) => entry?.key === key)) {
      return fail(400, `key ${JSON.stringify(key)} is not in blockedTopics`);
    }

    const candidate = structuredClone(profile);
    setAnswer(candidate, key, { value, source: 'confirmed', scope: 'all' });
    candidate.blockedTopics = blocked.filter((entry) => entry?.key !== key);

    try {
      validateCandidate(candidate);
    } catch (error) {
      // The answer never reaches the committed profile when provenance fails.
      return fail(400, `profile validation failed: ${error.message}`);
    }

    writeFileSync(profilePath, `${JSON.stringify(candidate, null, 2)}\n`);
    return json(200, { gaps: describe(loadProfile(profilePath)) });
  }

  function postStatus(body) {
    if (!body || typeof body !== 'object') return fail(400, 'expected a JSON body');
    const { id, status, note } = body;
    if (typeof status !== 'string' || !status) return fail(400, 'status is required');

    const records = readStore(storePath);
    const record = findRecord(records, id);
    if (!record) return fail(404, `no record for ${JSON.stringify(String(id ?? ''))}`);

    const key = keyOf(record);
    let moved;
    try {
      moved = applyTransition(records, key, status);
    } catch (error) {
      return fail(409, error.message);
    }

    writeStore(storePath, moved.records);
    appendEvent(eventsPath, {
      action: 'status',
      key,
      id: String(record.linkedinId ?? id),
      status,
      ...(note === undefined ? {} : { note: String(note) }),
    });
    return json(200, { record: moved.record });
  }

  function postPrepare(body) {
    if (!body || typeof body !== 'object' || body.id === undefined) return fail(400, 'id is required');
    const target = cliTarget(body.id);
    if (target.error) return target.error;

    const job = enqueue(process.execPath, [
      join(root, 'cli/prepare.mjs'),
      '--id',
      target.linkedinId,
      '--write',
      '--store',
      storePath,
      '--profile',
      profilePath,
      '--events',
      eventsPath,
    ]);
    return json(202, { job: job.id });
  }

  function postApply(body) {
    if (!body || typeof body !== 'object' || body.id === undefined) return fail(400, 'id is required');
    const target = cliTarget(body.id);
    if (target.error) return target.error;

    const dryRun = body.dryRun !== false;
    if (!dryRun && (typeof target.record.company !== 'string' || body.confirm !== target.record.company)) {
      return fail(400, `a real submit needs confirm: ${JSON.stringify(target.record.company ?? '')}`);
    }

    const args = [
      join(root, 'cli/apply.mjs'),
      '--id',
      target.linkedinId,
      ...(dryRun ? ['--dry-run'] : []),
      '--store',
      storePath,
      '--profile',
      profilePath,
      '--events',
      eventsPath,
    ];
    const job = enqueue(process.execPath, args);
    return json(202, { job: job.id });
  }

  function getLog() {
    let text;
    try {
      text = readFileSync(eventsPath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return json(200, { lines: [] });
      throw error;
    }

    const lines = text
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { raw: line };
        }
      })
      .slice(-100)
      .reverse();
    return json(200, { lines });
  }

  function getJob(id) {
    const job = jobs.get(String(id));
    return job ? json(200, jobView(job)) : fail(404, `no job ${JSON.stringify(String(id))}`);
  }

  function getStatic() {
    return {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: readFileSync(uiPath, 'utf8'),
    };
  }

  function handle(request = {}) {
    const method = String(request.method ?? 'GET').toUpperCase();
    const pathname = String(request.path ?? '/').split('?')[0];
    const body = request.body;

    try {
      if (pathname === '/' || pathname === '/index.html') {
        return method === 'GET' ? getStatic() : fail(405, 'method not allowed');
      }
      if (pathname === '/api/board') return method === 'GET' ? getBoard() : fail(405, 'method not allowed');
      if (pathname === '/api/answers') return method === 'POST' ? postAnswers(body) : fail(405, 'method not allowed');
      if (pathname === '/api/status') return method === 'POST' ? postStatus(body) : fail(405, 'method not allowed');
      if (pathname === '/api/prepare') return method === 'POST' ? postPrepare(body) : fail(405, 'method not allowed');
      if (pathname === '/api/apply') return method === 'POST' ? postApply(body) : fail(405, 'method not allowed');
      if (pathname === '/api/log') return method === 'GET' ? getLog() : fail(405, 'method not allowed');

      const job = pathname.match(/^\/api\/job\/([^/]+)$/);
      if (job) return method === 'GET' ? getJob(decodeURIComponent(job[1])) : fail(405, 'method not allowed');

      return fail(404, 'not found');
    } catch (error) {
      return fail(500, error.message);
    }
  }

  return {
    handle,
    getBoard,
    postAnswers,
    postStatus,
    postPrepare,
    postApply,
    getLog,
    getJob,
    getStatic,
    jobs,
  };
}
