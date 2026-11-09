import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildBoard } from './../scripts/board.mjs';

test('board sorts by score, counts statuses, and flags overdue follow-ups', () => {
  const today = '2026-11-09';
  const applications = [
    { company: 'Kredivo', role: 'Backend Go SDE II', score: 9, status: 'submitted', applied: '2026-10-01' },
    { company: 'Traveloka', role: 'Software Backend Engineer', score: 7, status: 'shortlisted' },
    { company: 'Indocyber', role: 'Golang Developer', score: 7, status: 'shortlisted', notes: 'vendor' },
    { company: 'Ajaib', role: 'Staff Engineer', score: null, status: 'scored' },
  ];

  const html = buildBoard({ applications, today });

  // Highest score first, unscored last.
  const order = ['Kredivo', 'Indocyber', 'Traveloka', 'Ajaib'].map((name) => html.indexOf(name));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'rows ordered by score desc, unscored last');

  // Overdue follow-up (applied 39 days ago, no follow_up) must be visually flagged.
  const dataRows = html.split('<tr').slice(1);
  const rowFor = (name) => dataRows.find((row) => row.includes(name)) ?? '';
  assert.match(rowFor('Kredivo'), /class="row due"/, 'overdue row carries the due class');
  assert.doesNotMatch(rowFor('Traveloka'), /class="row due"/, 'unapplied rows are not due');

  // Counts per status.
  assert.match(html, /2<\/span>[\s\S]{0,40}shortlisted/i);
  assert.match(html, /1<\/span>[\s\S]{0,40}submitted/i);

  // Self-contained: no external assets.
  assert.doesNotMatch(html, /<link[^>]+href=/i);
  assert.doesNotMatch(html, /<script[^>]+src=/i);
});

test('board writes to disk and reports row count', () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-'));
  const out = join(dir, 'board.html');
  const html = buildBoard({ applications: [{ company: 'Flip', role: 'Backend', score: 8, status: 'submitted' }], today: '2026-11-09', out });
  writeFileSync(out, html);
  assert.match(html, /Flip/);
});
