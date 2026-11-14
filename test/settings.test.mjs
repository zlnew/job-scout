// Settings tests. The DB is a temp file set before the modules load, so
// data/job-scout.db is never touched. No test reaches the network or Gmail: the
// one HTTP server uses the injected draft stub and only exercises settings.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'job-scout-settings-'));
process.env.JOB_APPLY_DB = path.join(scratch, 'settings.db');

const db = await import('../lib/db.mjs');
const store = await import('../lib/store.mjs');
const { scoreJob } = await import('../lib/score.mjs');
const { buildLetter, lintLetter } = await import('../lib/letter.mjs');
const { createHandler } = await import('../bin/serve.mjs');

let server;
let base;

before(async () => {
  db.openDb();
  server = http.createServer(createHandler({ createDraft: async () => ({ draftId: 'never-used' }) }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  db.closeDb();
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

const posting = {
  source: 'test',
  slug: 'x',
  title: 'Backend Engineer',
  company: 'Ajaib',
  location: 'Jakarta, DKI Jakarta',
  remote: false,
  salary: 'Rp 15.000.000 a month',
  published: new Date().toISOString().slice(0, 10),
  description: 'Build Golang services for payments and settlement. REST APIs, PostgreSQL.',
};

test('seeding is idempotent: reopening keeps the row count and values', () => {
  db.openDb();
  const before = db.listProfileFields();
  const count = Object.keys(before).length;
  assert.ok(count > 0);
  assert.equal(before['compensation.floor'].value, 12000000);
  assert.equal(before['compensation.floor'].source, 'seed');

  db.setProfileField('identity.phone', '+62 812-0000-0000');
  db.closeDb();
  db.openDb();

  const after = db.listProfileFields();
  assert.equal(Object.keys(after).length, count, 'reopening must not add seed rows');
  assert.equal(after['identity.phone'].value, '+62 812-0000-0000', 'a human edit survives reopen');
  assert.equal(after['identity.phone'].source, 'db');
  assert.equal(after['compensation.floor'].value, 12000000);
});

test('setProfileField persists into loadProfile and rejects an unknown path', () => {
  const result = db.setProfileField('compensation.floor', 15000000);
  assert.deepEqual(result.updated, ['compensation.floor']);

  const profile = store.loadProfile();
  assert.equal(profile.compensation.floor.value, 15000000);
  assert.equal(profile.compensation.floor.source, 'db');
  assert.equal(db.listProfileFields()['compensation.floor'].source, 'db');

  assert.throws(
    () => db.setProfileField('not.a.real.path', 1),
    /unknown profile field path: not\.a\.real\.path/,
  );

  db.setProfileField('compensation.floor', 12000000);
});

test('setProfileFields is atomic: one bad path leaves every value unchanged', () => {
  const before = db.listProfileFields();
  assert.throws(
    () =>
      db.setProfileFields({
        'compensation.floor': 20000000,
        'identity.city': 'Bandung',
        'not.a.real.path': 1,
      }),
    /unknown profile field path: not\.a\.real\.path/,
  );

  const after = db.listProfileFields();
  assert.deepEqual(after, before);
});

test('scoring uses the DB floor, not profile.json', () => {
  db.setProfileField('compensation.floor', 12000000);
  const before = scoreJob(posting, store.loadProfile());
  assert.notEqual(before.decision, 'reject', JSON.stringify(before));

  db.setProfileField('compensation.floor', 20000000);
  const after = scoreJob(posting, store.loadProfile());
  assert.equal(after.decision, 'reject');
  assert.match(after.flags.join(' '), /below the 20M floor/);

  db.setProfileField('compensation.floor', 12000000);
});

test('settings-save accepts a valid payload and rejects invalid fields with 400', async () => {
  const valid = await post({
    action: 'settings-save',
    fields: {
      'identity.email': 'maulana@example.com',
      'skills.languages': 'Go, Python, Go, , JavaScript',
    },
  });
  assert.equal(valid.status, 200, valid.text);
  assert.deepEqual(valid.json.updated, ['identity.email', 'skills.languages']);

  const page = await fetch(`${base}/settings`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes('value="maulana@example.com"'));
  assert.ok(html.includes('value="Go, Python, JavaScript"'), 'arrays are trimmed and deduped');
  assert.ok(html.includes('src-db'));

  const savedPage = await fetch(`${base}/settings?saved=1`);
  assert.equal(savedPage.status, 200);
  assert.ok((await savedPage.text()).includes('Settings saved.'));

  const badEmail = await post({
    action: 'settings-save',
    fields: { 'identity.email': 'not-an-email', 'identity.city': 'Bandung' },
  });
  assert.equal(badEmail.status, 400);
  assert.match(badEmail.json.error, /identity\.email/);
  assert.equal(db.listProfileFields()['identity.city'].value, 'Bekasi', 'a 400 writes nothing');

  const unknown = await post({ action: 'settings-save', fields: { 'nope.path': 1 } });
  assert.equal(unknown.status, 400);
  assert.match(unknown.json.error, /nope\.path/);

  const floorOverTarget = await post({
    action: 'settings-save',
    fields: { 'compensation.floor': 20000000, 'compensation.target': 14000000 },
  });
  assert.equal(floorOverTarget.status, 400);
  assert.match(floorOverTarget.json.error, /compensation\.floor/);
  assert.equal(db.listProfileFields()['compensation.floor'].value, 12000000);
});

test('a settings edit that changes nothing factual still lints clean', () => {
  db.setProfileField('identity.phone', '+62 812-3456-7890');
  const profile = store.loadProfile();
  const letter = buildLetter(posting, profile, {});
  const lint = lintLetter(letter, profile);
  assert.deepEqual(lint.violations, []);
  assert.equal(lint.ok, true);
  assert.match(letter, /\+62 812-3456-7890/);
});
