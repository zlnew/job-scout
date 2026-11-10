/**
 * Pure request handlers for the local control UI.
 *
 * Every handler takes an already-parsed request body and returns an HTTP-shaped
 * `{ status, headers, body }` object, so the same code is exercised by tests
 * without a socket. Authority stays where it already lives: the ledger owns
 * transitions, `loadProfile` owns provenance, and prepare/apply run the real
 * CLI entry points in a child process instead of reimplementing them.
 *
 * Cookie contents and CDP URLs are never read here; the UI only checks whether
 * a browser profile exists, never what is inside it.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { jobIdFromUrl } from '../boards/linkedin.mjs';
import { listSources } from '../boards/index.mjs';
import { identityKey, loadProfile } from '../core/guard.mjs';
import { appendEvent, applyTransition, backupDirFor, readStore, writeStore } from '../core/ledger.mjs';
import { LETTERS_DIR, appendRevision, readLetter } from '../core/letters.mjs';
import { CODES } from '../core/result.mjs';
import { writeJsonSafe } from '../core/store.mjs';
import { describe } from '../core/screening.mjs';
import {
  applicationView,
  boardOrder,
  countByStatus,
  postingsView,
  rulesView,
  todayView,
} from './view.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const MAX_OUTPUT = 64 * 1024;
const JSON_HEADERS = Object.freeze({ 'content-type': 'application/json; charset=utf-8' });
const SSE_HEADERS = Object.freeze({
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
});

const json = (status, payload) => ({ status, headers: JSON_HEADERS, body: JSON.stringify(payload) });

/**
 * Every failure carries the same `{ code, message, fix }` shape the CLIs use
 * (S5), so a screen can render one fix action without parsing prose. `error`
 * stays for clients written against the first API version.
 */
const failure = (status, code, message, detail) => {
  const known = CODES[code] ?? { message: 'the request could not be completed', fix: 'reload the page and try again' };
  const body = {
    code,
    message: message ?? known.message,
    fix: known.fix ?? 'reload the page and try again',
    ...(detail !== undefined ? { detail } : {}),
  };
  return json(status, { ...body, error: body.message });
};

/** Statuses the UI cannot map to a result code still need a stable shape. */
const NOT_FOUND = (what) => failure(404, 'record-not-found', `no ${what} matches that address`);

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
  lettersRoot = LETTERS_DIR,
  browserProfilePath = join(ROOT, 'profile'),
  spawn = nodeSpawn,
  root = ROOT,
} = {}) {
  const jobs = new Map();
  const queue = [];
  const streams = new Set();
  let draining = false;

  // Server-sent events replace polling: every state change is pushed to every
  // open page. A dead socket simply drops out of the set on `close`.
  function broadcast(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of streams) {
      try {
        res.write(frame);
      } catch {
        streams.delete(res);
      }
    }
  }

  function openStream(res) {
    res.writeHead(200, SSE_HEADERS);
    res.write('retry: 3000\n\n');
    res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);
    streams.add(res);
    res.on?.('close', () => streams.delete(res));
  }

  const appendOutput = (job, chunk) => {
    job.output = (job.output + String(chunk)).slice(-MAX_OUTPUT);
    broadcast('job', jobView(job));
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
    broadcast('job', jobView(job));
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
    broadcast('job', jobView(job));

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
    broadcast('job', jobView(job));
    drain();
    return job;
  }

  const jobView = (job) => ({ state: job.state, output: job.output });

  /** A record plus the LinkedIn id the CLI needs; `error` is the HTTP failure. */
  function cliTarget(id) {
    const records = readStore(storePath);
    const record = findRecord(records, id);
    if (!record) return { error: NOT_FOUND('record') };
    const linkedinId = record.linkedinId ? String(record.linkedinId) : jobIdFromUrl(record.url ?? '');
    if (!linkedinId) return { error: failure(400, 'usage', 'this record has no LinkedIn id to run a job with') };
    return { record, linkedinId };
  }

  function readEvents() {
    let text;
    try {
      text = readFileSync(eventsPath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    return text
      .split('\n')
      .filter((line) => line.trim() !== '')
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  }

  function sessions() {
    // The persistent profile is shared by every session source. Only its
    // existence is checked: the UI never reads cookies.
    const signedIn = existsSync(join(browserProfilePath, 'Default', 'Cookies'));
    return listSources().map(({ name, via, verified }) => ({
      name,
      via,
      verified,
      status:
        via === 'api'
          ? 'no session needed'
          : !verified
            ? 'config unverified'
            : signedIn
              ? 'session stored'
              : 'no session stored',
      reauth: via === 'api' ? null : `npm run login -- https://${name}.com`,
      note:
        via === 'api'
          ? 'public guest endpoint; nothing to sign in to'
          : verified
            ? null
            : 'confirm the selectors with a headed run before scanning',
    }));
  }

  function getBoard() {
    const records = readStore(storePath);
    return json(200, {
      records: [...records].sort(boardOrder),
      counts: countByStatus(records),
      gaps: describe(loadProfile(profilePath)),
    });
  }

  function getToday() {
    const records = readStore(storePath);
    const gaps = describe(loadProfile(profilePath));
    return json(200, todayView({ records, events: readEvents(), sessions: sessions(), gaps }));
  }

  function getPostings(params) {
    const records = readStore(storePath);
    return json(
      200,
      postingsView({
        records,
        gaps: describe(loadProfile(profilePath)),
        filters: {
          status: params.get('status') ?? undefined,
          minScore: params.get('minScore') ?? undefined,
          source: params.get('source') ?? undefined,
        },
      }),
    );
  }

  function getSessions() {
    return json(200, { sessions: sessions(), rules: rulesView(loadProfile(profilePath)) });
  }

  function letterFor(key) {
    try {
      return readLetter(key, undefined, { root: lettersRoot });
    } catch (error) {
      if (error.code === 'letter-not-found') return null;
      throw error;
    }
  }

  function recordFor(id) {
    return findRecord(readStore(storePath), id);
  }

  function getApplication(id) {
    const record = recordFor(id);
    if (!record) return NOT_FOUND('application');
    const key = keyOf(record);
    return json(
      200,
      applicationView({
        record,
        events: readEvents(),
        profile: loadProfile(profilePath),
        letter: letterFor(key),
      }),
    );
  }

  function getLetter(id) {
    const record = recordFor(id);
    if (!record) return NOT_FOUND('application');
    const key = keyOf(record);
    const letter = letterFor(key);
    if (!letter) return failure(404, 'letter-not-found');
    return json(200, {
      key,
      current: letter.current,
      revisions: letter.revisions,
      origin: letter.origin,
      createdAt: letter.createdAt,
      words: letter.words,
      note: letter.note ?? null,
      text: letter.text,
    });
  }

  /** The stored screenshot for one application, only when it lives under the repo. */
  function getScreenshot(id) {
    const record = recordFor(id);
    if (!record) return NOT_FOUND('application');
    const shot = record.screenshot ? resolve(record.screenshot) : null;
    if (!shot || !shot.startsWith(`${resolve(root)}/`) || !existsSync(shot)) {
      return failure(404, 'record-not-found', 'this application has no screenshot yet');
    }
    const type = shot.endsWith('.jpg') || shot.endsWith('.jpeg') ? 'image/jpeg' : shot.endsWith('.webp') ? 'image/webp' : 'image/png';
    return { status: 200, headers: { 'content-type': type }, body: readFileSync(shot) };
  }

  function postLetter(id, body) {
    const record = recordFor(id);
    if (!record) return NOT_FOUND('application');
    const key = keyOf(record);
    if (!body || typeof body !== 'object') return failure(400, 'usage', 'expected a JSON body');
    if (typeof body.text !== 'string' || body.text.trim() === '') {
      return failure(400, 'letter-empty', 'the edit is empty; a letter revision needs text');
    }

    const revision = appendRevision(
      key,
      {
        text: body.text,
        origin: 'edited',
        ...(body.note === undefined || body.note === '' ? {} : { note: String(body.note) }),
      },
      { root: lettersRoot, company: record.company, role: record.role },
    );
    appendEvent(eventsPath, {
      action: 'letter',
      key,
      revision,
      origin: 'edited',
      ...(body.note === undefined || body.note === '' ? {} : { note: String(body.note) }),
    });
    broadcast('events', { at: new Date().toISOString() });
    const stored = letterFor(key);
    const { path: _bodyPath, ...index } = stored ?? {};
    return json(201, { index, revision });
  }

  function postAnswers(body) {
    if (!body || typeof body !== 'object') return failure(400, 'usage', 'expected a JSON body');
    const { key, value } = body;
    if (typeof key !== 'string' || !key.trim()) return failure(400, 'usage', 'a profile key is required');
    if (!isScalar(value)) return failure(400, 'usage', 'the answer must be a string, number, or boolean');

    const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
    const blocked = Array.isArray(profile.blockedTopics) ? profile.blockedTopics : [];
    if (!blocked.some((entry) => entry?.key === key)) {
      return failure(400, 'usage', `${JSON.stringify(key)} is not a blocked topic in the profile`);
    }

    const candidate = structuredClone(profile);
    setAnswer(candidate, key, { value, source: 'confirmed', scope: 'all' });
    candidate.blockedTopics = blocked.filter((entry) => entry?.key !== key);

    try {
      validateCandidate(candidate);
    } catch (error) {
      // The answer never reaches the committed profile when provenance fails.
      return failure(400, 'provenance-invalid', error.message);
    }

    writeJsonSafe(profilePath, candidate, { backupDir: backupDirFor(profilePath) });
    broadcast('events', { at: new Date().toISOString() });
    return json(200, { gaps: describe(loadProfile(profilePath)) });
  }

  function postStatus(body) {
    if (!body || typeof body !== 'object') return failure(400, 'usage', 'expected a JSON body');
    const { id, status, note } = body;
    if (typeof status !== 'string' || !status) return failure(400, 'usage', 'a status is required');

    const records = readStore(storePath);
    const record = findRecord(records, id);
    if (!record) return NOT_FOUND('record');

    const key = keyOf(record);
    let moved;
    try {
      moved = applyTransition(records, key, status);
    } catch (error) {
      return failure(409, error.code === 'illegal-transition' ? 'illegal-transition' : 'usage', error.message);
    }

    writeStore(storePath, moved.records);
    appendEvent(eventsPath, {
      action: 'status',
      key,
      id: String(record.linkedinId ?? id),
      status,
      ...(note === undefined ? {} : { note: String(note) }),
    });
    broadcast('events', { at: new Date().toISOString() });
    return json(200, { record: moved.record });
  }

  function postPrepare(body) {
    if (!body || typeof body !== 'object' || body.id === undefined) return failure(400, 'usage', 'a job id is required');
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
    if (!body || typeof body !== 'object' || body.id === undefined) return failure(400, 'usage', 'a job id is required');
    const target = cliTarget(body.id);
    if (target.error) return target.error;

    const dryRun = body.dryRun !== false;
    if (!dryRun && (typeof target.record.company !== 'string' || body.confirm !== target.record.company)) {
      return failure(
        400,
        'submit-unconfirmed',
        `a real submit needs the exact company name as confirmation: ${JSON.stringify(target.record.company ?? '')}`,
      );
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
    return job ? json(200, jobView(job)) : NOT_FOUND('job');
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
    const rawPath = String(request.path ?? '/');
    const pathname = rawPath.split('?')[0];
    const params = request.query instanceof URLSearchParams ? request.query : new URLSearchParams(rawPath.split('?')[1] ?? '');
    const body = request.body;
    const notAllowed = () => failure(405, 'usage', 'that method is not accepted by this route');

    try {
      if (pathname === '/' || pathname === '/index.html') {
        return method === 'GET' ? getStatic() : notAllowed();
      }
      if (pathname === '/api/board') return method === 'GET' ? getBoard() : notAllowed();
      if (pathname === '/api/today') return method === 'GET' ? getToday() : notAllowed();
      if (pathname === '/api/postings') return method === 'GET' ? getPostings(params) : notAllowed();
      if (pathname === '/api/sessions') return method === 'GET' ? getSessions() : notAllowed();
      if (pathname === '/api/answers') return method === 'POST' ? postAnswers(body) : notAllowed();
      if (pathname === '/api/status') return method === 'POST' ? postStatus(body) : notAllowed();
      if (pathname === '/api/prepare') return method === 'POST' ? postPrepare(body) : notAllowed();
      if (pathname === '/api/apply') return method === 'POST' ? postApply(body) : notAllowed();
      if (pathname === '/api/log') return method === 'GET' ? getLog() : notAllowed();

      const application = pathname.match(/^\/api\/application\/([^/]+)$/);
      if (application) {
        const key = decodeURIComponent(application[1]);
        return method === 'GET' ? getApplication(key) : notAllowed();
      }

      const screenshot = pathname.match(/^\/api\/screenshot\/([^/]+)$/);
      if (screenshot) {
        return method === 'GET' ? getScreenshot(decodeURIComponent(screenshot[1])) : notAllowed();
      }

      const letter = pathname.match(/^\/api\/letter\/([^/]+)$/);
      if (letter) {
        const key = decodeURIComponent(letter[1]);
        if (method === 'GET') return getLetter(key);
        if (method === 'POST') return postLetter(key, body);
        return notAllowed();
      }

      const job = pathname.match(/^\/api\/job\/([^/]+)$/);
      if (job) return method === 'GET' ? getJob(decodeURIComponent(job[1])) : notAllowed();

      return failure(404, 'record-not-found', 'that screen or address does not exist');
    } catch (error) {
      if (error?.code && CODES[error.code]) {
        return failure(error.code === 'letter-invalid' ? 400 : 404, error.code, error.message);
      }
      return failure(500, 'store-corrupt', 'the server could not read its data');
    }
  }

  return {
    handle,
    openStream,
    getBoard,
    getToday,
    getPostings,
    getSessions,
    getApplication,
    getLetter,
    getScreenshot,
    postLetter,
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
