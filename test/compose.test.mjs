// Draft Mail compose tests. Every draft write goes through an injected stub, so no
// test reaches the network or a real Gmail mailbox. The DB is a temp file, so
// data/job-scout.db is never touched.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'job-scout-compose-'));
process.env.JOB_APPLY_DB = path.join(scratch, 'compose.db');

const { createHandler, renderComposePage, renderPage, buildBoard } = await import('../bin/serve.mjs');
const { buildLetter, lintLetter } = await import('../lib/letter.mjs');
const { PATHS } = await import('../lib/store.mjs');
const { openDb, closeDb, upsertPostings, upsertApplication, listApplications, listEvents } =
  await import('../lib/db.mjs');

const profile = JSON.parse(fs.readFileSync(PATHS.profile, 'utf8'));

const POSTING_ID = 'fungsi:backend-engineer-payments-ajaib';
const POSTING_WITH_ADDRESS = 'fungsi:platform-engineer-with-address';
const RESUME = path.join(scratch, 'resume.pdf');
const NOT_PDF = path.join(scratch, 'resume.txt');
const MISSING_PDF = path.join(scratch, 'missing.pdf');

fs.writeFileSync(RESUME, Buffer.from('%PDF-1.4 compose test'));
fs.writeFileSync(NOT_PDF, 'not a pdf');

const calls = [];
let server;
let base;

const stubDraft = async (args) => {
  calls.push(args);
  return { draftId: `draft-${calls.length}` };
};

before(async () => {
  openDb();
  upsertPostings([
    {
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
    },
    {
      source: 'fungsi',
      slug: 'platform-engineer-with-address',
      title: 'Platform Engineer',
      company: 'Sagara',
      city: 'Jakarta',
      published: '2026-11-08',
      url: 'https://fungsi.id/platform-engineer-with-address',
      description: 'Send your CV to jobs@sagara.example and we will reply.',
    },
  ]);
  upsertApplication({ posting_id: POSTING_ID, company: 'Ajaib', role: 'Backend Engineer (Payments)', status: 'to-apply' });

  server = http.createServer(createHandler({ createDraft: stubDraft }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeDb();
  fs.rmSync(scratch, { recursive: true, force: true });
});

async function post(payload) {
  const res = await fetch(`${base}/api/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, text, json };
}

const body = 'I am applying for the [Role] role at [Company] and would be glad to talk.';
const valid = () => ({
  action: 'compose-draft',
  to: 'hiring@ajaib.example',
  cc: '',
  bcc: '',
  subject: 'Application: Backend Engineer (Payments)',
  body,
  attachmentPath: RESUME,
});

test('compose-draft rejects a payload with no recipient and never calls Gmail', async () => {
  const before = calls.length;
  const { status, json } = await post({ ...valid(), to: '' });
  assert.equal(status, 400);
  assert.match(json.error, /recipient/i);
  assert.equal(calls.length, before);
});

test('compose-draft rejects a malformed recipient address', async () => {
  const before = calls.length;
  const { status, json } = await post({ ...valid(), to: 'not-an-email' });
  assert.equal(status, 400);
  assert.match(json.error, /not-an-email/);
  assert.equal(calls.length, before);
});

test('compose-draft rejects an empty subject', async () => {
  const before = calls.length;
  const { status, json } = await post({ ...valid(), subject: '   ' });
  assert.equal(status, 400);
  assert.match(json.error, /subject/i);
  assert.equal(calls.length, before);
});

test('compose-draft rejects an empty and a too-short body', async () => {
  const before = calls.length;
  const empty = await post({ ...valid(), body: '' });
  assert.equal(empty.status, 400);
  assert.match(empty.json.error, /body/i);
  const short = await post({ ...valid(), body: 'Too short.' });
  assert.equal(short.status, 400);
  assert.match(short.json.error, /too short/i);
  assert.equal(calls.length, before);
});

test('compose-draft rejects a non-pdf attachment and a missing attachment', async () => {
  const before = calls.length;
  const txt = await post({ ...valid(), attachmentPath: NOT_PDF });
  assert.equal(txt.status, 400);
  assert.match(txt.json.error, /pdf/i);
  const missing = await post({ ...valid(), attachmentPath: MISSING_PDF });
  assert.equal(missing.status, 400);
  assert.match(missing.json.error, /attachment/i);
  assert.equal(calls.length, before);
});

test('a valid compose-draft calls the stub once with To, no Cc/Bcc, and the attachment path', async () => {
  const before = calls.length;
  const { status, json } = await post(valid());
  assert.equal(status, 200);
  assert.equal(calls.length, before + 1);
  const sent = calls[calls.length - 1];
  assert.deepEqual(sent, {
    to: 'hiring@ajaib.example',
    subject: 'Application: Backend Engineer (Payments)',
    body,
    attachmentPath: RESUME,
    attachmentName: 'resume.pdf',
  });
  assert.equal('cc' in sent, false);
  assert.equal('bcc' in sent, false);
  assert.equal(json.draftId, `draft-${calls.length}`);
  assert.equal(json.to, 'hiring@ajaib.example');
  assert.equal(json.attachment, RESUME);
});

test('multiple recipients become one whitespace-normalised To value without duplicates', async () => {
  const before = calls.length;
  const { status, json } = await post({ ...valid(), to: 'a@b.c;   d@e.f, a@b.c ;' });
  assert.equal(status, 200);
  assert.equal(calls.length, before + 1);
  assert.equal(calls[calls.length - 1].to, 'a@b.c, d@e.f');
  assert.equal(json.to, 'a@b.c, d@e.f');
});

test('Cc and Bcc are passed through when given', async () => {
  const { status } = await post({ ...valid(), cc: 'cc@ajaib.example', bcc: 'bcc@ajaib.example' });
  assert.equal(status, 200);
  const sent = calls[calls.length - 1];
  assert.equal(sent.cc, 'cc@ajaib.example');
  assert.equal(sent.bcc, 'bcc@ajaib.example');
});

test('a Gmail failure becomes 502, never a success status', async () => {
  const failing = http.createServer(
    createHandler({
      createDraft: async () => {
        throw new Error('upstream exploded');
      },
    }),
  );
  await new Promise((resolve) => failing.listen(0, '127.0.0.1', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${failing.address().port}/api/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(valid()),
    });
    const json = await res.json();
    assert.equal(res.status, 502);
    assert.match(json.error, /upstream exploded/);
  } finally {
    await new Promise((resolve) => failing.close(resolve));
  }
});

test('a posting_id with an application moves it to drafted and appends an event only there', async () => {
  const before = upsertApplication({ posting_id: POSTING_ID, company: 'Ajaib', status: 'to-apply' }).id;
  const eventsBefore = listEvents(before).length;
  const { status, json } = await post({ ...valid(), posting_id: POSTING_ID });
  assert.equal(status, 200);
  assert.equal(json.application.status, 'drafted');
  const events = listEvents(before);
  assert.equal(events.length, eventsBefore + 1);
  assert.equal(events.at(-1).status, 'drafted');

  // An unknown posting_id never fabricates an application row.
  const rowsBefore = listApplications().length;
  const unknown = await post({ ...valid(), posting_id: 'fungsi:no-such-posting' });
  assert.equal(unknown.status, 200);
  assert.equal(listApplications().length, rowsBefore);
});

test('GET /compose serves the four fields, the template body and the absolute resume path', async () => {
  const res = await fetch(`${base}/compose`);
  const html = await res.text();
  assert.equal(res.status, 200);
  for (const field of ['to', 'cc', 'bcc', 'subject', 'body', 'attachmentPath']) {
    assert.ok(html.includes(`name="${field}"`), `missing field ${field}`);
  }
  assert.ok(html.includes(path.resolve(PATHS.resume)));
  assert.ok(html.includes('Create Gmail draft'));
  assert.ok(html.includes('Creates a draft only. You open Gmail and press send.'));
  assert.ok(html.includes('https://mail.google.com/mail/u/0/#drafts'));
  assert.ok(html.includes('[Company]'));
  assert.ok(html.includes('[Role]'));
});

test('GET /compose?posting=<id> prefills subject and body, and leaves To empty without an address', async () => {
  const res = await fetch(`${base}/compose?posting=${encodeURIComponent(POSTING_ID)}`);
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /id="to"[^>]*value=""/);
  assert.ok(html.includes('Backend Engineer (Payments)'));
  assert.ok(html.includes(profile.identity.fullName.value));
  assert.ok(html.includes('I am applying for the Backend Engineer (Payments) role at Ajaib.'));
  assert.ok(html.includes(`value="${POSTING_ID}"`));
});

test('GET /compose?posting=<id> prefills To only from a published address', async () => {
  const res = await fetch(`${base}/compose?posting=${encodeURIComponent(POSTING_WITH_ADDRESS)}`);
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.ok(html.includes('value="jobs@sagara.example"'));
});

test('GET /compose?posting=<unknown> is a 404, not an invented posting', async () => {
  const res = await fetch(`${base}/compose?posting=fungsi:nope`);
  assert.equal(res.status, 404);
});

test('the board links to the compose page', () => {
  const rows = buildBoard({ postings: [], applications: [], profile });
  const html = renderPage({ rows, summary: { postings: 0, open: 0, apply: 0 }, lastReport: null });
  assert.ok(html.includes('href="/compose"'));
});

test('the general template uses placeholders and claims no outside employer and no years', () => {
  const letter = buildLetter(null, profile);
  assert.match(letter, /\[Company\]/);
  assert.match(letter, /\[Role\]/);
  for (const outside of ['Google', 'Meta', 'Amazon', 'Tokopedia', 'Gojek', 'Ajaib']) {
    assert.equal(letter.includes(outside), false, `general template must not name ${outside}`);
  }
  assert.equal(/\b\d+\s*\+?\s*years?\b/i.test(letter), false);
  const lint = lintLetter(letter, profile);
  assert.deepEqual(lint.violations, []);
});

test('renderComposePage escapes a posting title and still renders the form', () => {
  const html = renderComposePage({
    prefill: {
      postingId: '',
      to: '',
      cc: '',
      bcc: '',
      subject: '<script>alert(1)</script>',
      body: body,
      attachmentPath: RESUME,
    },
  });
  assert.equal(html.includes('<script>alert(1)</script>'), false);
});
