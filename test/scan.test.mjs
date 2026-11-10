import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { after } from 'node:test';
import { SOURCES, dedupe, getSource, listSources, scanAll } from '../boards/index.mjs';
import { assertVerified, scrape } from '../boards/session.mjs';
import { discoveredRecord, writeDiscovered } from '../cli/scan.mjs';
import { identityKey } from '../core/guard.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const GUEST_HTML = readFileSync(join(ROOT, 'fixtures/boards/linkedin-guest.html'), 'utf8');

const scratch = mkdtempSync(join(tmpdir(), 'job-apply-scan-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** Minimal element stub: `map` is selector -> text or { text, attrs }. */
function fakeElement(map) {
  return {
    querySelector: (selector) => {
      const node = map[selector];
      if (node === undefined) return null;
      if (typeof node === 'string') return { textContent: node, getAttribute: () => null };
      return { textContent: node.text ?? '', getAttribute: (name) => node.attrs?.[name] ?? null };
    },
  };
}

/** One page object exposing only what `scrape` uses. */
function fakePage({ rows, url }) {
  let current = url;
  return {
    url: () => current,
    goto: async (next) => {
      current = next;
    },
    waitForSelector: async () => {},
    $$eval: async (selector, pageFn, arg) => pageFn(rows, arg),
  };
}

function fakeBrowser(page, calls = []) {
  return async (options) => {
    calls.push(options);
    return { pages: () => [page], newPage: async () => page, close: async () => {} };
  };
}

/** A verified config so the scrape path is exercised without a real board. */
const SESSION_CONFIG = {
  name: 'glints',
  via: 'session',
  verified: true,
  searchUrl: ({ query, location, page }) => `https://glints.com/id/search?q=${query}&loc=${location}&page=${page}`,
  cards: '.job-card',
  fields: {
    id: (el) => el.querySelector('a').getAttribute('data-id'),
    title: '.title',
    company: '.company',
    location: '.location',
    posted: '.posted',
    url: (el) => el.querySelector('a')?.getAttribute('href') ?? null,
  },
};

test('registry lists every source in a fixed order and resolves names', () => {
  assert.deepEqual(SOURCES.map((source) => source.name), ['linkedin', 'glints', 'kalibrr', 'dealls']);
  assert.deepEqual(listSources().map((source) => source.name), ['linkedin', 'glints', 'kalibrr', 'dealls']);
  assert.equal(getSource('kalibrr').via, 'session');
  assert.throws(() => getSource('monster'), /unknown source "monster"/);
});

test('linkedin source scans the saved guest fragment into candidates', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, text: async () => GUEST_HTML };
  };

  const { candidates, perSource, deduped } = await scanAll({
    names: ['linkedin'],
    queries: ['backend engineer golang'],
    location: 'Jakarta',
    fetchImpl,
    delayMs: 0,
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0], /keywords=backend%20engineer%20golang/);
  assert.deepEqual(perSource, [{ source: 'linkedin', ok: true, count: 2, via: 'api' }]);
  assert.equal(deduped, 0);
  // Denied title (DevOps) is filtered by the board module, not the registry.
  assert.deepEqual(candidates.map((candidate) => candidate.id), ['111', '222']);
  assert.deepEqual(candidates[0], {
    source: 'linkedin',
    id: '111',
    title: 'Backend Engineer (Golang)',
    company: 'Acme',
    location: 'Jakarta, Indonesia',
    posted: '2026-11-01',
    url: 'https://www.linkedin.com/jobs/view/111',
    via: 'api',
    seenOn: ['linkedin'],
  });
});

test('the same posting on two boards is one candidate whose seenOn names both', async () => {
  const rows = [
    fakeElement({
      a: { attrs: { 'data-id': 'acme-1', href: '/id/opportunities/jobs/acme-1' } },
      '.title': 'Backend Engineer (Golang)',
      '.company': 'Acme',
      '.location': 'Jakarta, Indonesia',
      '.posted': '2026-11-02',
    }),
  ];
  const page = fakePage({ rows, url: 'https://glints.com/id/search' });
  const launchCalls = [];
  const sources = [getSource('linkedin'), SESSION_CONFIG];

  const { candidates, perSource, deduped } = await scanAll({
    sources,
    queries: ['backend engineer golang'],
    location: 'Jakarta',
    fetchImpl: async () => ({ ok: true, text: async () => GUEST_HTML }),
    launchImpl: fakeBrowser(page, launchCalls),
    delayMs: 0,
  });

  assert.deepEqual(perSource.map((report) => [report.source, report.ok, report.count, report.via]), [
    ['linkedin', true, 2, 'api'],
    ['glints', true, 1, 'session'],
  ]);
  assert.equal(launchCalls.length, 1);
  assert.equal(deduped, 1);
  assert.equal(candidates.length, 2);
  const shared = candidates.find((candidate) => candidate.company === 'Acme');
  // First source in order keeps the row; the later board only extends seenOn.
  assert.equal(shared.source, 'linkedin');
  assert.equal(shared.via, 'api');
  assert.deepEqual(shared.seenOn, ['linkedin', 'glints']);
});

test('one failing source never aborts the sweep and is reported as failed', async () => {
  const broken = {
    name: 'broken',
    via: 'api',
    scan: async () => {
      throw new Error('429 rate limited');
    },
  };

  const { candidates, perSource } = await scanAll({
    sources: [getSource('linkedin'), broken],
    queries: ['backend engineer golang'],
    fetchImpl: async () => ({ ok: true, text: async () => GUEST_HTML }),
    delayMs: 0,
  });

  assert.deepEqual(perSource, [
    { source: 'linkedin', ok: true, count: 2, via: 'api' },
    { source: 'broken', ok: false, count: 0, via: 'api', error: '429 rate limited' },
  ]);
  assert.equal(candidates.length, 2);
});

test('an unverified session source reports an error and never launches a browser', async () => {
  const launchCalls = [];
  const { candidates, perSource } = await scanAll({
    names: ['glints'],
    queries: ['backend engineer'],
    launchImpl: fakeBrowser(fakePage({ rows: [], url: 'https://glints.com/' }), launchCalls),
    delayMs: 0,
  });

  assert.deepEqual(candidates, []);
  assert.equal(launchCalls.length, 0, 'no browser for a config that has not been verified');
  assert.equal(perSource.length, 1);
  assert.equal(perSource[0].ok, false);
  assert.equal(perSource[0].error, 'unverified config');
  assert.equal(perSource[0].via, 'session');
  assert.match(perSource[0].detail, /cards/);
});

test('every unverified source is honest about being unverified', () => {
  for (const name of ['glints', 'kalibrr', 'dealls']) {
    const source = getSource(name);
    assert.equal(source.verified, false, `${name} must stay unverified until a headed run proves it`);
    assert.throws(() => assertVerified(source), (error) => error.message === 'unverified config');
  }
});

test('session scrape extracts fields, resolves relative URLs, and paginates', async () => {
  const rows = [
    fakeElement({
      a: { attrs: { 'data-id': 'g-1', href: '/id/opportunities/jobs/g-1' } },
      '.title': 'Backend Engineer',
      '.company': 'Acme',
      '.location': 'Jakarta',
      '.posted': '2026-11-02',
    }),
  ];
  const page = fakePage({ rows, url: 'https://glints.com/id/search' });
  const launchCalls = [];
  const urls = [];
  const originalGoto = page.goto;
  page.goto = async (url) => {
    urls.push(url);
    await originalGoto(url);
  };

  const result = await scrape(SESSION_CONFIG, {
    queries: ['backend engineer', 'golang'],
    location: 'Indonesia',
    pages: 2,
    launchImpl: fakeBrowser(page, launchCalls),
    delayMs: 0,
  });

  assert.equal(launchCalls.length, 1);
  assert.equal(launchCalls[0].headless, true);
  assert.deepEqual(urls, [
    'https://glints.com/id/search?q=backend engineer&loc=Indonesia&page=1',
    'https://glints.com/id/search?q=backend engineer&loc=Indonesia&page=2',
    'https://glints.com/id/search?q=golang&loc=Indonesia&page=1',
    'https://glints.com/id/search?q=golang&loc=Indonesia&page=2',
  ]);
  // Same card on every page, so the id dedupe keeps one row.
  assert.deepEqual(result, [
    {
      id: 'g-1',
      title: 'Backend Engineer',
      company: 'Acme',
      location: 'Jakarta',
      posted: '2026-11-02',
      url: 'https://glints.com/id/opportunities/jobs/g-1',
    },
  ]);
});

test('session scrape fails clearly when the card selector never appears', async () => {
  const page = fakePage({ rows: [], url: 'https://glints.com/id/search' });
  page.waitForSelector = async () => {
    throw new Error('timeout');
  };

  await assert.rejects(
    scrape(SESSION_CONFIG, { launchImpl: fakeBrowser(page), delayMs: 0 }),
    /card selector never appeared: \.job-card/,
  );
});

test('dedupe keeps the first source and only extends seenOn for later boards', () => {
  const { candidates, deduped } = dedupe([
    { source: 'linkedin', title: 'Backend Engineer', company: 'ACME', location: 'Jakarta', url: 'a' },
    { source: 'glints', title: 'backend  engineer', company: 'Acme', location: 'jakarta', url: 'b' },
    { source: 'kalibrr', title: 'Backend Engineer', company: 'Acme', location: 'Jakarta', url: 'c' },
  ]);

  assert.equal(deduped, 2);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].source, 'linkedin');
  assert.deepEqual(candidates[0].seenOn, ['linkedin', 'glints', 'kalibrr']);
});

test('--write adds discovered rows and never touches an existing submitted record', () => {
  const storePath = join(scratch, 'applications.json');
  const submitted = {
    company: 'Acme',
    role: 'Backend Engineer (Golang)',
    status: 'submitted',
    channel: 'LinkedIn',
    url: 'https://www.linkedin.com/jobs/view/111',
    identityKey: identityKey({
      company: 'Acme',
      role: 'Backend Engineer (Golang)',
      applyUrl: 'https://www.linkedin.com/jobs/view/111',
    }),
  };
  writeFileSync(
    storePath,
    `${JSON.stringify({ updated: '2026-11-01', applications: [submitted] }, null, 2)}\n`,
  );

  const [acme] = [
    { source: 'linkedin', title: 'Backend Engineer (Golang)', company: 'Acme', location: 'Jakarta, Indonesia', posted: '2026-11-01', url: 'https://www.linkedin.com/jobs/view/111', seenOn: ['linkedin'] },
  ];
  const fresh = {
    source: 'glints',
    title: 'Golang Developer',
    company: 'Beta',
    location: 'Bandung',
    posted: '2026-11-05',
    url: 'https://glints.com/id/opportunities/jobs/beta-1',
    seenOn: ['glints', 'dealls'],
  };

  const added = writeDiscovered(storePath, [acme, fresh]);
  assert.equal(added.length, 1);
  assert.equal(added[0].status, 'discovered');
  assert.equal(added[0].channel, 'glints');

  const store = JSON.parse(readFileSync(storePath, 'utf8'));
  assert.equal(store.applications.length, 2);
  assert.deepEqual(store.applications[0], submitted, 'the submitted record is byte-identical');
  assert.equal(store.applications[1].company, 'Beta');
  assert.deepEqual(store.applications[1].seenOn, ['glints', 'dealls']);

  // A second scan of the same rows adds nothing: identity keys are unique.
  assert.deepEqual(writeDiscovered(storePath, [acme, fresh]), []);
  assert.equal(JSON.parse(readFileSync(storePath, 'utf8')).applications.length, 2);
});

test('discoveredRecord derives the ledger identity from company, role, and url', () => {
  const record = discoveredRecord({
    source: 'linkedin',
    title: 'Platform Engineer',
    company: 'Beta',
    location: 'Bandung',
    posted: '',
    url: 'https://www.linkedin.com/jobs/view/222',
    seenOn: ['linkedin'],
  });

  assert.equal(
    record.identityKey,
    identityKey({ company: 'Beta', role: 'Platform Engineer', applyUrl: 'https://www.linkedin.com/jobs/view/222' }),
  );
  assert.equal(record.status, 'discovered');
  assert.equal(record.posted, undefined, 'an empty posted date is not stored');
  assert.match(record.discoveredAt, /^\d{4}-\d{2}-\d{2}$/);
});
