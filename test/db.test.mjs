// DB layer tests. Every test uses its own temp directory so nothing touches data/.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openDb,
  closeDb,
  upsertPostings,
  listPostings,
  getPosting,
  deletePosting,
  listApplications,
  upsertApplication,
  addEvent,
  listEvents,
} from '../lib/db.mjs';
import { runMigration } from '../bin/migrate.mjs';

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-apply-db-'));
  return {
    dir,
    db: path.join(dir, 'test.db'),
    cleanup() {
      closeDb();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const posting = (over = {}) => ({
  source: 'fungsi',
  slug: 'backend-engineer-ajaib',
  title: 'Backend Engineer',
  company: 'Ajaib',
  city: 'Jakarta',
  remote: true,
  salary: '12M - 20M',
  published: '2026-11-02',
  url: 'https://fungsi.id/backend-engineer-ajaib',
  description: 'Go backend',
  ...over,
});

test('upserting the same posting twice keeps one row and bumps last_seen', async () => {
  const s = scratch();
  try {
    openDb(s.db);
    const first = upsertPostings([posting()]);
    assert.deepEqual(first, { added: 1, updated: 0 });

    const [before] = listPostings();
    assert.equal(listPostings().length, 1);

    await new Promise((resolve) => setTimeout(resolve, 5));

    const second = upsertPostings([posting({ title: 'Backend Engineer II' })]);
    assert.deepEqual(second, { added: 0, updated: 1 });

    const rows = listPostings();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, 'Backend Engineer II');
    assert.equal(rows[0].first_seen, before.first_seen);
    assert.ok(rows[0].last_seen > before.last_seen, 'last_seen should move forward');
  } finally {
    s.cleanup();
  }
});

test('deletePosting removes the posting', () => {
  const s = scratch();
  try {
    openDb(s.db);
    upsertPostings([posting()]);
    const [row] = listPostings();
    assert.ok(getPosting(row.id));

    assert.equal(deletePosting(row.id), true);
    assert.equal(getPosting(row.id), null);
    assert.equal(listPostings().length, 0);
    assert.equal(deletePosting(row.id), false);
  } finally {
    s.cleanup();
  }
});

test('changing an application status appends an event and keeps the previous one', () => {
  const s = scratch();
  try {
    openDb(s.db);
    const created = upsertApplication({
      posting_id: 'fungsi:backend-engineer-ajaib',
      company: 'Ajaib',
      role: 'Backend Engineer',
      channel: 'site',
      status: 'to-apply',
      score: 90,
      decision: 'apply',
    });
    assert.equal(created.created, true);

    const id = listApplications()[0].id;
    const firstEvents = listEvents(id);
    assert.equal(firstEvents.length, 1);
    assert.equal(firstEvents[0].status, 'to-apply');

    const updated = upsertApplication({ posting_id: 'fungsi:backend-engineer-ajaib', status: 'applied' });
    assert.equal(updated.created, false);
    assert.equal(updated.status_changed, true);

    const events = listEvents(id);
    assert.equal(events.length, 2);
    assert.equal(events[0].status, 'to-apply');
    assert.equal(events[1].status, 'applied');
    assert.equal(listApplications().length, 1);

    // Same status again is not a transition, so it must not append.
    upsertApplication({ posting_id: 'fungsi:backend-engineer-ajaib', status: 'applied' });
    assert.equal(listEvents(id).length, 2);

    addEvent(id, 'interview', 'recruiter called');
    const manual = listEvents(id);
    assert.equal(manual.length, 3);
    assert.equal(manual[2].note, 'recruiter called');
  } finally {
    s.cleanup();
  }
});

test('migration import of a 2-row fixture is idempotent across two runs', () => {
  const s = scratch();
  const postingsFile = path.join(s.dir, 'postings.json');
  const applicationsFile = path.join(s.dir, 'applications.json');
  try {
    fs.writeFileSync(
      postingsFile,
      JSON.stringify({
        postings: [
          posting(),
          posting({ slug: 'golang-engineer-kredivo', title: 'Golang Engineer', company: 'Kredivo', source: 'fungsi' }),
        ],
      }),
    );
    fs.writeFileSync(
      applicationsFile,
      JSON.stringify({
        applications: [
          { posting_id: 'fungsi:backend-engineer-ajaib', company: 'Ajaib', role: 'Backend Engineer', channel: 'site', status: 'to-apply' },
          { company: 'Kredivo Group', role: 'Backend Engineer - Golang (SDE II)', channel: 'LinkedIn', status: 'blocked', posted: '2026-10-30', jd: 'postings/1.txt', applyKind: 'easy-apply' },
        ],
      }),
    );

    openDb(s.db);
    const first = runMigration({ dbFile: s.db, postingsFile, applicationsFile });
    assert.equal(first.postings.imported, 2);
    assert.equal(first.applications.imported, 2);
    assert.equal(first.events.created, 2);
    assert.equal(listApplications().length, 2);

    const second = runMigration({ dbFile: s.db, postingsFile, applicationsFile });
    assert.equal(second.postings.imported, 0);
    assert.equal(second.postings.skipped, 2);
    assert.equal(second.applications.imported, 0);
    assert.equal(second.applications.skipped, 2);
    assert.equal(second.events.created, 0);

    assert.equal(listPostings().length, 2);
    assert.equal(listApplications().length, 2);
    for (const app of listApplications()) assert.equal(listEvents(app.id).length, 1);

    // Legacy fields survive the import instead of being dropped.
    const legacy = listApplications().find((a) => a.company === 'Kredivo Group');
    assert.equal(legacy.posting_id, null);
    assert.equal(legacy.legacy.jd, 'postings/1.txt');
    assert.equal(legacy.legacy.applyKind, 'easy-apply');
  } finally {
    s.cleanup();
  }
});
