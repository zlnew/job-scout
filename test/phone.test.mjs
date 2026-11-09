import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const env = { ...process.env, JOB_APPLY_PROFILE: mkdtempSync(join(tmpdir(), 'profile-')) };
const PAGE = pathToFileURL(join(ROOT, 'fixtures/intl-phone.html')).href;

test('a phone field is filled even when a country-picker button shares its label', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phone-'));
  const fields = join(dir, 'fields.json');
  const report = join(dir, 'report.json');
  writeFileSync(fields, JSON.stringify({ Email: 'a@b.c', 'Phone number': '+62 813-8379-4949' }));

  let status = 0;
  try {
    execFileSync(
      process.execPath,
      [join(ROOT, 'scripts/fill.mjs'), '--url', PAGE, '--fields', fields, '--report', report, '--shot', join(dir, 's.png'), '--headless'],
      { cwd: ROOT, stdio: 'pipe', env },
    );
  } catch (error) {
    status = error.status ?? 1;
  }

  const written = JSON.parse(readFileSync(report, 'utf8'));
  assert.equal(status, 0, `phone form fills cleanly (missed: ${written.missed.join(', ')})`);
  assert.ok(
    written.filled.some((entry) => entry.field === 'Phone number'),
    'the phone input itself is filled, not the country button',
  );
  assert.ok(
    !written.skipped.some((entry) => entry.field === 'Phone number'),
    'the decoy button is not chosen',
  );
});
