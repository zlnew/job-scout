import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { generateLetter } from './../scripts/cover.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const career = JSON.parse(readFileSync(join(ROOT, 'fixtures/career.min.json'), 'utf8'));
const jd = readFileSync(join(ROOT, 'fixtures/jd.txt'), 'utf8');

const base = { career, jd, company: 'Kredivo Group', role: 'Backend Engineer - Golang (SDE II)', why: 'Kredivo lends to underbanked borrowers at real scale.', angle: 'backend' };

test('letter is short, evidence-based, and never claims JD-only technology', () => {
  const { text, warnings, wordCount, evidence } = generateLetter(base);

  assert.ok(wordCount >= 90 && wordCount <= 200, `word count ${wordCount} within 90-200`);

  // Best-matching current-role bullet is quoted as first-person evidence.
  assert.match(text, /I develop the core transfer engine and payment rails/i);

  // Current role always leads, even when a past role's bullet has more raw keyword overlap.
  assert.match(evidence[0], /transfer engine/i, 'current-role bullet leads the evidence');

  // The JD asks for Kubernetes, Kafka and gRPC — none are on the resume, so none may be claimed.
  for (const tech of ['kubernetes', 'kafka', 'grpc', 'terraform']) {
    assert.doesNotMatch(text.toLowerCase(), new RegExp(`\\b${tech}\\b`), `${tech} must not be claimed`);
  }
  assert.ok(warnings.includes('kubernetes'), 'kubernetes reported as a gap');
  assert.ok(warnings.includes('kafka'), 'kafka reported as a gap');

  // Real overlap is stated, from resume skills only.
  assert.match(text, /Go/);
  assert.match(text, /PostgreSQL/);

  // Research line is carried verbatim.
  assert.match(text, /underbanked borrowers/);

  // Availability comes from confirmed facts, not invention.
  assert.match(text, /one month/i);
  assert.match(text, /Bekasi|Jakarta/i);
});

test('generator refuses to write a letter without a researched company line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cover-'));
  let status = 0;
  try {
    execFileSync(process.execPath, [join(ROOT, 'scripts/cover.mjs'), '--company', 'Flip', '--role', 'Backend Engineer', '--jd', join(ROOT, 'fixtures/jd.txt'), '--out', join(dir, 'flip.md')], { cwd: ROOT, stdio: 'pipe' });
  } catch (error) {
    status = error.status ?? 1;
  }
  assert.equal(status, 1, 'missing --why fails loudly');
  assert.equal(existsSync(join(dir, 'flip.md')), false, 'no file written with a hole in it');
});

test('generator writes a letter when given the research line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cover-'));
  const out = join(dir, 'flip.md');
  execFileSync(process.execPath, [join(ROOT, 'scripts/cover.mjs'), '--company', 'Flip', '--role', 'Backend Engineer', '--jd', join(ROOT, 'fixtures/jd.txt'), '--angle', 'backend', '--why', 'Flip moves money for millions of Indonesians.', '--out', out], { cwd: ROOT, stdio: 'pipe' });
  const text = readFileSync(out, 'utf8');
  assert.match(text, /Flip moves money for millions/);
  assert.match(text, /Backend Engineer/);
});
