// Dashboard tests. Postings come from a third party, so the renderer must escape
// them. The one DB test points JOB_APPLY_DB at a temp file before importing the
// modules that read PATHS, so data/job-apply.db is never touched.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'job-apply-serve-'));
process.env.JOB_APPLY_DB = path.join(scratch, 'dash.db');

const { escapeHtml, contactEmail, buildBoard, renderPage, applyStatus } = await import('../bin/serve.mjs');
const { openDb, closeDb, upsertPostings, listApplications, listEvents } = await import('../lib/db.mjs');

after(() => {
  closeDb();
  fs.rmSync(scratch, { recursive: true, force: true });
});

const poster = (over = {}) => ({
  source: 'fungsi',
  slug: 'backend-engineer-payments-ajaib',
  title: 'Backend Engineer (Payments)',
  company: 'Ajaib',
  city: 'Jakarta',
  remote: true,
  salary: '15.000.000',
  published: '2026-11-09',
  url: 'https://fungsi.id/backend-engineer-payments-ajaib',
  description: 'Own the payments ledger in Go.',
  ...over,
});

test('escapeHtml neutralises a script tag and its attribute quotes', () => {
  assert.equal(escapeHtml('<script>alert("x")</script>'), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
});

test('the board page escapes a third-party script tag in a posting title', () => {
  const rows = buildBoard({
    postings: [poster({ title: '<script>alert(1)</script>Backend' })],
    applications: [],
    profile: { compensation: { floor: { value: 12000000 } } },
  });
  const html = renderPage({ rows, summary: { postings: 1, open: 1, apply: 0 }, lastReport: null });
  assert.equal(html.includes('<script>alert(1)</script>'), false);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;Backend'));
});

test('contactEmail reads a published address and refuses to invent one', () => {
  assert.equal(contactEmail({ description: 'Send your CV to jobs@ajaib.co.id before Friday.' }), 'jobs@ajaib.co.id');
  assert.equal(contactEmail({ description: 'No address is published here.' }), null);
  assert.equal(contactEmail({}), null);
});

test('the board sorts by score and joins an application status', () => {
  const rows = buildBoard({
    postings: [poster({ slug: 'low', title: 'Sales Executive' }), poster()],
    applications: [{ id: 7, posting_id: 'fungsi:backend-engineer-payments-ajaib', status: 'applied' }],
    profile: { compensation: { floor: { value: 12000000 } } },
  });
  assert.ok(rows.length === 2);
  assert.ok(rows[0].verdict.score >= rows[1].verdict.score);
  assert.equal(rows[0].app?.status, 'applied');
});

test('a status action creates the application row and appends an event in the temp DB', () => {
  openDb();
  assert.deepEqual(upsertPostings([poster()]), { added: 1, updated: 0 });
  const target = 'fungsi:backend-engineer-payments-ajaib';
  const result = applyStatus(target, 'applied', { compensation: { floor: { value: 12000000 } } });
  assert.equal(result.created, true);
  assert.equal(result.status, 'applied');

  const app = listApplications().find((a) => a.posting_id === target);
  assert.ok(app, `expected an application row for ${target}`);
  assert.equal(app.status, 'applied');
  assert.equal(app.channel, 'site');
  assert.deepEqual(
    listEvents(app.id).map((e) => e.status),
    ['to-apply', 'applied'],
  );
});
