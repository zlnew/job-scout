import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { after } from 'node:test';
import { identityKey } from '../core/guard.mjs';
import { appendRevision, lettersFor, listLetters, readLetter, setCurrent } from '../core/letters.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const LETTER = join(ROOT, 'cli/letter.mjs');
const CAREER = join(ROOT, 'fixtures/career.min.json');
const JD = join(ROOT, 'fixtures/jd.txt');
const WHY = 'Kredivo lends to underbanked borrowers at real scale.';

const scratch = mkdtempSync(join(tmpdir(), 'job-apply-letters-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const caseDir = (name) => {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const record = { company: 'Kredivo Group', role: 'Backend Engineer', applyUrl: 'https://careers.example/jobs/1' };
const key = identityKey(record);
const readIndexFile = (root) => JSON.parse(readFileSync(join(root, key, 'index.json'), 'utf8'));

function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [LETTER, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return { status: error.status ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

/** A CLI --json run must put exactly one already-parsed object on stdout (S5). */
function runJson(args) {
  const result = run(args);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 1, `one JSON line, got: ${JSON.stringify(result.stdout)}`);
  return { status: result.status, payload: JSON.parse(lines[0]) };
}

test('appendRevision numbers revisions, writes the body, and moves current', () => {
  const root = caseDir('append');

  const first = appendRevision(key, { text: 'Dear team,\n\nfirst.\n', origin: 'generated' }, { root, ...record });
  assert.equal(first, 1);

  const dir = join(root, key);
  assert.deepEqual(readdirSync(dir).sort(), ['index.json', 'v1.md']);
  assert.equal(readFileSync(join(dir, 'v1.md'), 'utf8'), 'Dear team,\n\nfirst.\n', 'the body is exactly the text given');

  const index = readIndexFile(root);
  assert.equal(index.identityKey, key);
  assert.equal(index.company, record.company);
  assert.equal(index.role, record.role);
  assert.equal(index.current, 1);
  assert.deepEqual(index.revisions.map((entry) => entry.revision), [1]);
  assert.equal(index.revisions[0].origin, 'generated');
  assert.equal(index.revisions[0].words, 3, 'words are stored for the UI');
  assert.match(index.revisions[0].createdAt, /^\d{4}-\d{2}-\d{2}T/);

  const second = appendRevision(key, { text: 'Dear team,\n\nsecond.\n', origin: 'edited', note: 'shortened' }, { root });
  assert.equal(second, 2);
  const next = readIndexFile(root);
  assert.equal(next.current, 2);
  assert.equal(next.revisions.length, 2);
  assert.equal(next.revisions[1].origin, 'edited');
  assert.equal(next.revisions[1].note, 'shortened');
  assert.equal(next.company, record.company, 'an edit keeps the bound application details');
});

test('setCurrent re-points the index and the next revision still follows the newest number', () => {
  const root = caseDir('current');
  appendRevision(key, { text: 'one', origin: 'generated' }, { root, ...record });
  appendRevision(key, { text: 'two', origin: 'edited' }, { root });

  assert.equal(setCurrent(key, 1, { root }), 1);
  assert.equal(readIndexFile(root).current, 1);

  assert.equal(appendRevision(key, { text: 'three', origin: 'edited' }, { root }), 3);
  assert.equal(readIndexFile(root).current, 3);
  assert.equal(readLetter(key, 2, { root }).text, 'two', 'setCurrent never rewrites a revision');
});

test('readLetter defaults to current, reads an explicit revision, and refuses an unknown one', () => {
  const root = caseDir('read');
  appendRevision(key, { text: 'one', origin: 'generated' }, { root, ...record });
  appendRevision(key, { text: 'two two', origin: 'edited' }, { root });

  const current = readLetter(key, undefined, { root });
  assert.equal(current.revision, 2);
  assert.equal(current.text, 'two two');
  assert.equal(current.words, 2);
  assert.equal(current.company, record.company);

  assert.equal(readLetter(key, 1, { root }).text, 'one');

  assert.throws(
    () => readLetter(key, 9, { root }),
    (error) => {
      assert.equal(error.code, 'letter-revision-not-found');
      assert.match(error.fix, /revision/);
      return true;
    },
  );
  assert.throws(
    () => readLetter(identityKey({ company: 'Nobody', role: 'Nothing' }), undefined, { root }),
    (error) => {
      assert.equal(error.code, 'letter-not-found');
      return true;
    },
  );
});

test('listLetters reports company, role, current and the current word count', () => {
  const root = caseDir('list');
  assert.deepEqual(listLetters({ root }), [], 'an empty store lists nothing and does not throw');

  appendRevision(key, { text: 'one two three', origin: 'generated' }, { root, ...record });
  appendRevision(key, { text: 'four five', origin: 'edited' }, { root });

  const expected = {
    identityKey: key,
    company: record.company,
    role: record.role,
    current: 2,
    revisions: 2,
    words: 2,
  };
  assert.deepEqual(listLetters({ root }), [expected]);
  assert.deepEqual(lettersFor(record, { root }), expected);
  assert.equal(lettersFor({ company: 'Nobody', role: 'Nothing' }, { root }), null);
});

test('a failed body write leaves the previous index intact and cleans its temp file', () => {
  const root = caseDir('fail');
  appendRevision(key, { text: 'v1 body', origin: 'generated' }, { root, ...record });
  const dir = join(root, key);
  const before = readFileSync(join(dir, 'index.json'), 'utf8');

  // A directory where v2.md belongs makes the final rename fail on any uid,
  // which a read-only directory would not do when the suite runs as root.
  mkdirSync(join(dir, 'v2.md'));
  writeFileSync(join(dir, 'v2.md', 'blocker'), 'x');

  assert.throws(() => appendRevision(key, { text: 'v2 body', origin: 'edited' }, { root }));
  assert.equal(readFileSync(join(dir, 'index.json'), 'utf8'), before, 'the index still describes v1');
  assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);
});

test('appendRevision refuses empty text and an unknown origin', () => {
  const root = caseDir('refuse');
  assert.throws(
    () => appendRevision(key, { text: '   \n', origin: 'generated' }, { root }),
    (error) => {
      assert.equal(error.code, 'letter-empty');
      return true;
    },
  );
  assert.throws(
    () => appendRevision(key, { text: 'text', origin: 'assumed' }, { root }),
    (error) => {
      assert.equal(error.code, 'letter-invalid');
      return true;
    },
  );
});

test('cli list --json on an empty store is one clean empty result', () => {
  const root = caseDir('cli-empty');
  const { status, payload } = runJson(['list', '--letters', root, '--json']);
  assert.equal(status, 0);
  assert.equal(payload.ok, true);
  assert.equal(payload.code, 'letters-listed');
  assert.deepEqual(payload.value, []);
});

test('cli generate, read and set address one letter by job id and revision', () => {
  const dir = caseDir('cli');
  const store = join(dir, 'applications.json');
  const letters = join(dir, 'letters');
  const applyUrl = 'https://careers.kredivo.example/jobs/1';
  writeFileSync(
    store,
    `${JSON.stringify(
      {
        updated: '2026-11-10',
        applications: [
          {
            company: 'Kredivo Group',
            role: 'Backend Engineer - Golang (SDE II)',
            status: 'shortlisted',
            url: 'https://www.linkedin.com/jobs/view/4440204415',
            jd: 'fixtures/jd.txt',
            applyUrl,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  const common = ['--store', store, '--letters', letters, '--career', CAREER];

  const generated = runJson(['--id', '4440204415', '--generate', '--why', WHY, '--json', ...common]);
  assert.equal(generated.status, 0);
  assert.equal(generated.payload.ok, true);
  assert.equal(generated.payload.code, 'letter-generated');
  assert.equal(generated.payload.value.revision, 1);
  assert.equal(generated.payload.value.identityKey, identityKey({ company: 'Kredivo Group', role: 'Backend Engineer - Golang (SDE II)', applyUrl }));
  assert.match(generated.payload.value.text, /Kredivo/);

  const setFile = join(dir, 'edited.md');
  writeFileSync(setFile, 'Dear team,\n\nedited body.\n');
  const edited = runJson(['--id', '4440204415', '--set', setFile, '--json', ...common]);
  assert.equal(edited.payload.value.revision, 2);

  const current = runJson(['--id', '4440204415', '--json', ...common]);
  assert.equal(current.payload.code, 'letter-shown');
  assert.equal(current.payload.value.revision, 2);
  assert.equal(current.payload.value.text, 'Dear team,\n\nedited body.\n');

  const first = runJson(['--id', '4440204415', '--revision', '1', '--json', ...common]);
  assert.equal(first.payload.value.revision, 1);
  assert.match(first.payload.value.text, /Kredivo/);

  const listed = runJson(['list', '--letters', letters, '--json']);
  assert.equal(listed.payload.value.length, 1);
  assert.equal(listed.payload.value[0].current, 2);

  const missing = runJson(['--id', '4440204415', '--revision', '7', '--json', ...common]);
  assert.equal(missing.status, 2);
  assert.equal(missing.payload.ok, false);
  assert.equal(missing.payload.code, 'letter-revision-not-found');

  const unknown = runJson(['--id', '999999', '--json', ...common]);
  assert.equal(unknown.status, 2);
  assert.equal(unknown.payload.code, 'record-not-found');
});

test('scripts/cover.mjs keeps its markdown output and records the revision it bound', () => {
  const dir = caseDir('cover');
  const store = join(dir, 'applications.json');
  const letters = join(dir, 'letters');
  writeFileSync(
    store,
    `${JSON.stringify(
      {
        updated: '2026-11-10',
        applications: [
          { company: 'Kredivo Group', role: 'Backend Engineer - Golang (SDE II)', status: 'shortlisted', applyUrl: 'https://careers.kredivo.example/jobs/1' },
        ],
      },
      null,
      2,
    )}\n`,
  );
  const out = join(dir, 'kredivo.md');

  const stdout = execFileSync(
    process.execPath,
    [join(ROOT, 'scripts/cover.mjs'), '--company', 'Kredivo Group', '--role', 'Backend Engineer - Golang (SDE II)',
      '--jd', JD, '--career', CAREER, '--why', WHY, '--out', out, '--store', store, '--letters', letters],
    { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' },
  );

  assert.match(stdout, /words → /, 'the old output line is unchanged');
  assert.match(readFileSync(out, 'utf8'), /Kredivo/);

  const [stored] = listLetters({ root: letters });
  assert.equal(stored.current, 1);
  assert.equal(readLetter(stored.identityKey, 1, { root: letters }).origin, 'generated');
});
