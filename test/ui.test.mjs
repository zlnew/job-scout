// UI tests: server-side pagination, expandable descriptions, and the shared
// stylesheet. A temp DB keeps data/job-apply.db untouched; no test reaches the
// network or a Gmail mailbox.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'job-apply-ui-'));
process.env.JOB_APPLY_DB = path.join(scratch, 'ui.db');

const { createHandler } = await import('../bin/serve.mjs');
const { openDb, closeDb, upsertPostings } = await import('../lib/db.mjs');

const TOTAL = 55;
const NASTY = '<script>alert(1)</script>Never trust this description.';

const seed = Array.from({ length: TOTAL }, (_, i) => {
  const n = String(i).padStart(2, '0');
  return {
    source: 'fungsi',
    slug: `backend-engineer-payments-${n}`,
    title: `Backend Engineer (Payments) ${n}`,
    company: `Company ${n}`,
    city: 'Jakarta',
    remote: true,
    salary: '15.000.000',
    published: '2026-11-09',
    url: `https://fungsi.id/backend-engineer-payments-${n}`,
    description:
      i === 0
        ? NASTY
        : 'Own the payments ledger in Go. Golang payments fintech backend API postgres. 3 years experience.',
  };
});

let server;
let base;

before(async () => {
  openDb();
  upsertPostings(seed);
  server = http.createServer(createHandler());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeDb();
  fs.rmSync(scratch, { recursive: true, force: true });
});

async function get(pathname) {
  const res = await fetch(`${base}${pathname}`);
  return { status: res.status, type: res.headers.get('content-type'), html: await res.text() };
}

function ids(html) {
  return [...html.matchAll(/data-posting-id="([^"]+)"/g)].map((m) => m[1]);
}

test('page 1 shows 25 of 55 and page 2 is a disjoint, ordered continuation', async () => {
  const p1 = await get('/?per=25');
  assert.equal(p1.status, 200);
  assert.ok(p1.html.includes('1–25 of 55'), 'page 1 range missing');
  const first = ids(p1.html);
  assert.equal(first.length, 25);

  const p2 = await get('/?per=25&page=2');
  assert.equal(p2.status, 200);
  assert.ok(p2.html.includes('26–50 of 55'), 'page 2 range missing');
  const second = ids(p2.html);
  assert.equal(second.length, 25);

  assert.equal(new Set([...first, ...second]).size, 50, 'a posting appears twice across pages');

  // Determinism: the same ordering is produced by a single large page.
  const all = await get('/?per=100');
  assert.equal(ids(all.html).length, TOTAL);
  assert.deepEqual([...first, ...second], ids(all.html).slice(0, 50));
});

test('out-of-range page clamps to the last page instead of erroring or emptying', async () => {
  const res = await get('/?page=999');
  assert.equal(res.status, 200);
  const last = ids(res.html);
  assert.equal(last.length, 5);
  assert.ok(res.html.includes('51–55 of 55'), 'clamped range missing');
  assert.ok(!res.html.includes('No postings match these filters.') || res.html.includes('data-posting-id='));
});

test('an unsupported per falls back to the 25 default', async () => {
  const res = await get('/?per=9999&page=1');
  assert.equal(res.status, 200);
  assert.equal(ids(res.html).length, 25);
  assert.ok(res.html.includes('1–25 of 55'));
});

test('filter state survives pagination links', async () => {
  const res = await get('/?decision=apply&page=2');
  assert.equal(res.status, 200);
  assert.equal(ids(res.html).length, 25, 'seed postings should all be apply');
  assert.ok(res.html.includes('decision=apply'), 'pagination links dropped the decision filter');
});

test('each posting has a native details block and the description is escaped', async () => {
  const res = await get('/?per=100');
  assert.equal(res.status, 200);
  assert.equal((res.html.match(/<details/g) || []).length, TOTAL, 'expected one details element per posting');
  assert.equal(res.html.includes('<script>alert(1)</script>'), false, 'raw script tag leaked into the board');
  assert.ok(
    res.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;Never trust this description.'),
    'escaped description text is missing',
  );
  assert.ok(res.html.includes('reasons'), 'scorer reasons are not shown');
  assert.ok(res.html.includes('flags'), 'scorer flags are not shown');
});

test('board, compose and settings all reference the one stylesheet, which is dark and responsive', async () => {
  for (const page of ['/', '/compose', '/settings']) {
    const res = await get(page);
    assert.equal(res.status, 200, `${page} did not render`);
    assert.ok(res.html.includes('href="/assets/app.css"'), `${page} does not reference the shared stylesheet`);
  }
  const css = await get('/assets/app.css');
  assert.equal(css.status, 200);
  assert.match(css.type, /text\/css/);
  assert.match(css.html, /--bg:\s*#0b0d10/i, 'dark background token missing');
  assert.match(css.html, /@media[^{]+\{/, 'no media query in the shared stylesheet');
});
