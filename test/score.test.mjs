// Scoring tests. These pin the confirmed policy in data/answers.md, not opinions:
// a posting asking 5+ years scores zero, a sub-floor salary is rejected outright,
// non-accepted titles are disqualified, and a stale posting is penalised.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreJob, parseSalaryIdr, parseMinYears } from '../lib/score.mjs';

const profile = {
  compensation: { floor: { value: 12000000 } },
};

const base = {
  source: 'test',
  slug: 'x',
  title: 'Backend Engineer',
  company: 'Ajaib',
  location: 'Jakarta, DKI Jakarta',
  remote: false,
  salary: null,
  published: new Date().toISOString().slice(0, 10),
  description: 'Build Golang services for payments and settlement. REST APIs, PostgreSQL.',
};

test('strong fit: fintech, Golang, Jakarta, fresh -> apply', () => {
  const v = scoreJob(base, profile);
  assert.equal(v.decision, 'apply', JSON.stringify(v));
  assert.ok(v.score >= 70);
  assert.match(v.reasons.join(' '), /golang/);
});

test('5+ years requirement scores zero regardless of fit', () => {
  const v = scoreJob({ ...base, description: base.description + ' Minimum 5 years of experience with Golang.' }, profile);
  assert.equal(v.score, 0);
  assert.equal(v.decision, 'reject');
  assert.match(v.flags.join(' '), /5\+ years/);
});

test('3-5 years band is accepted and scored', () => {
  const v = scoreJob({ ...base, description: base.description + ' 3-5 years of experience required.' }, profile);
  assert.notEqual(v.decision, 'reject');
  assert.ok(v.score > 0);
});

test('listed salary below the 12M floor is rejected', () => {
  const v = scoreJob({ ...base, salary: 'Rp. 8.000.000 - Rp. 10.000.000 a month' }, profile);
  assert.equal(v.decision, 'reject');
  assert.match(v.flags.join(' '), /below the 12M floor/);
});

test('listed salary above the floor scores the comp component', () => {
  const v = scoreJob({ ...base, salary: 'Rp 15.000.000 a month' }, profile);
  assert.notEqual(v.decision, 'reject');
  assert.match(v.reasons.join(' '), /15\.0M/);
});

test('mobile titles are disqualified without scoring', () => {
  for (const title of ['Senior Android Engineer', 'Flutter Developer', 'QA Tester', 'DevOps Engineer', 'Sales Engineer']) {
    const v = scoreJob({ ...base, title }, profile);
    assert.equal(v.decision, 'reject', title);
    assert.equal(v.score, 0, title);
  }
});

test('foreign employer without full remote is rejected', () => {
  const v = scoreJob({ ...base, location: 'Singapore', remote: false, description: 'Golang payments platform. On-site.' }, profile);
  assert.equal(v.decision, 'reject');
});

test('foreign employer with full remote is allowed', () => {
  const v = scoreJob({ ...base, location: 'Singapore', remote: true }, profile);
  assert.notEqual(v.decision, 'reject');
});

test('stale posting is penalised and flagged', () => {
  const old = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);
  const v = scoreJob({ ...base, published: old }, profile);
  assert.match(v.flags.join(' '), /stale/);
});

test('senior title keeps the score but warns against claiming the level', () => {
  const v = scoreJob({ ...base, title: 'Senior Backend Engineer' }, profile);
  assert.match(v.flags.join(' '), /senior-title/);
});

test('parseMinYears handles ranges and minimums', () => {
  assert.equal(parseMinYears('5-7 years of experience'), 5);
  assert.equal(parseMinYears('minimum 5 years using Golang'), 5);
  assert.equal(parseMinYears('3+ years building APIs'), 3);
  assert.equal(parseMinYears('no experience requirement stated'), null);
});

test('parseSalaryIdr converts monthly, daily and yearly forms', () => {
  assert.equal(parseSalaryIdr('Rp. 300.000 - Rp. 400.000 a day'), 6600000);
  assert.equal(parseSalaryIdr('Rp 12.000.000 - Rp 15.000.000 a month'), 12000000);
  assert.equal(parseSalaryIdr('IDR 180,000,000 a year'), 15000000);
  assert.equal(parseSalaryIdr(''), null);
});
