/**
 * Source registry: the only place that knows which boards exist (S9). Adding a
 * board is one config module under sources/ plus one line here; the scorer, the
 * ledger and the CLI never learn board names.
 *
 * `scanAll` is deliberately forgiving: one board failing is reported per source
 * and never aborts the sweep (S9.4).
 */
import { DEFAULT_QUERIES, rankTitle, searchJobs } from './linkedin.mjs';
import { scrape } from './session.mjs';
import glints from './sources/glints.mjs';
import kalibrr from './sources/kalibrr.mjs';
import dealls from './sources/dealls.mjs';

export { DEFAULT_QUERIES, rankTitle };

const DELAY_MS = 800;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const normaliseValue = (value) => String(value ?? '').toLowerCase().replaceAll(/\s+/g, ' ').trim();

/**
 * LinkedIn keeps its guest HTML endpoint: no session, no ban risk (S9.1), so it
 * stays `via: 'api'`. Every other board is a declarative config in sources/.
 */
const linkedin = {
  name: 'linkedin',
  via: 'api',
  verified: true,
  scan: ({ queries, location, pages, fetchImpl, delayMs }) =>
    searchJobs({ queries, location, pages, fetchImpl, delayMs }),
};

/** Ordered by strategy cost: the free guest endpoint first, authenticated scrapes after. */
export const SOURCES = Object.freeze([linkedin, glints, kalibrr, dealls]);

export function listSources() {
  return SOURCES.map(({ name, via, verified }) => ({ name, via, verified: verified ?? true }));
}

export function getSource(name, sources = SOURCES) {
  const source = sources.find((entry) => entry.name === name);
  if (!source) {
    throw new Error(`unknown source "${name}" (known: ${sources.map((s) => s.name).join(', ')})`);
  }
  return source;
}

/** One board's normalized row. `via` records which strategy produced it (S9.1). */
function normaliseCandidate(row, source) {
  const candidate = {
    source: source.name,
    id: String(row.id ?? '').trim(),
    title: String(row.title ?? '').trim(),
    company: String(row.company ?? '').trim(),
    location: String(row.location ?? '').trim(),
    posted: String(row.posted ?? '').trim(),
    url: String(row.url ?? '').trim(),
    via: source.via,
  };
  if (row.jd) candidate.jd = row.jd;
  return candidate;
}

/**
 * Cross-board dedupe (S9.3): one posting seen on two boards is one record. The
 * first source in the incoming order keeps the row, later boards only extend
 * `seenOn`.
 */
export function dedupe(candidates) {
  const byKey = new Map();
  const kept = [];
  let removed = 0;
  for (const candidate of candidates) {
    const key = [
      normaliseValue(candidate.company),
      normaliseValue(candidate.title),
      normaliseValue(candidate.location),
    ].join('|');
    const existing = byKey.get(key);
    if (!existing) {
      const record = { ...candidate, seenOn: [candidate.source] };
      byKey.set(key, record);
      kept.push(record);
      continue;
    }
    removed += 1;
    if (!existing.seenOn.includes(candidate.source)) existing.seenOn.push(candidate.source);
    // `jd` is the one field a later board may fill in for free.
    if (!existing.jd && candidate.jd) existing.jd = candidate.jd;
  }
  return { candidates: kept, deduped: removed };
}

async function scanOne(source, options) {
  const rows =
    source.via === 'session' ? await scrape(source, options) : await source.scan(options);
  return rows.map((row) => normaliseCandidate(row, source));
}

/**
 * Scan every selected board and merge the results.
 *
 * `concurrency` is 1 by default: these are small boards and hammering four of
 * them in parallel is the fastest way to lose an account. A source config may
 * be injected via `sources` so the registry itself needs no test double.
 */
export async function scanAll({
  names = null,
  sources = SOURCES,
  queries = DEFAULT_QUERIES,
  location = 'Indonesia',
  pages = 1,
  concurrency = 1,
  fetchImpl = globalThis.fetch,
  launchImpl = null,
  delayMs = DELAY_MS,
} = {}) {
  const selected = names ? names.map((name) => getSource(name, sources)) : [...sources];
  // `launchImpl` is only needed by session sources; leaving it undefined keeps
  // the browser module's own default (persistent profile).
  const options = { queries, location, pages, fetchImpl, delayMs, ...(launchImpl ? { launchImpl } : {}) };
  const size = Math.max(1, Math.floor(Number(concurrency)) || 1);

  const perSource = [];
  const collected = [];

  for (let index = 0; index < selected.length; index += size) {
    if (index > 0 && delayMs > 0) await sleep(delayMs);
    const batch = selected.slice(index, index + size);
    const settled = await Promise.all(
      batch.map((source) =>
        Promise.resolve()
          .then(() => scanOne(source, options))
          .then((candidates) => ({ source, ok: true, candidates }))
          .catch((error) => ({ source, ok: false, candidates: [], error })),
      ),
    );

    for (const entry of settled) {
      const report = {
        source: entry.source.name,
        ok: entry.ok,
        count: entry.candidates.length,
        via: entry.source.via,
      };
      if (!entry.ok) {
        report.error = entry.error.message;
        if (entry.error.detail) report.detail = entry.error.detail;
      }
      perSource.push(report);
      collected.push(...entry.candidates);
    }
  }

  const { candidates, deduped } = dedupe(collected);
  return { candidates, perSource, deduped };
}
