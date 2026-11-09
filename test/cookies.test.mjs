import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { normalizeCookies } from './../scripts/import-cookies.mjs';

const ROOT = resolve(import.meta.dirname, '..');

test('accepts a Cookie-Editor export and fixes browser-invalid combinations', () => {
  const { cookies, rejected } = normalizeCookies([
    { domain: '.linkedin.com', name: 'li_at', value: 'abc', path: '/', secure: true, httpOnly: true, sameSite: 'no_restriction', expirationDate: 1799999999.75 },
    { domain: '.linkedin.com', name: 'lang', value: 'v=2', path: '/', secure: false, sameSite: 'unspecified', session: true },
  ]);

  assert.equal(rejected.length, 0);
  assert.equal(cookies[0].sameSite, 'None');
  assert.equal(cookies[0].secure, true, 'SameSite=None forced to Secure');
  assert.equal(cookies[0].expires, 1799999999, 'float expiry floored to whole seconds');
  assert.equal(cookies[1].secure, false, 'unspecified SameSite leaves Secure alone');
  assert.equal(cookies[1].expires, -1, 'session cookie');
  assert.equal(cookies[1].sameSite, undefined, 'unspecified omitted');
});

test('accepts a Playwright storage-state object and rejects unusable entries', () => {
  const { cookies, rejected } = normalizeCookies({
    cookies: [
      { name: 'a', value: '1', domain: '.example.com', sameSite: 'Lax', expires: 1700000000, secure: true, httpOnly: false, path: '/' },
      { name: 'novalue', domain: '.example.com' },
      { value: 'no-name', domain: '.example.com' },
      { name: 'nodomain', value: 'x' },
    ],
  });

  assert.equal(cookies.length, 1);
  assert.equal(cookies[0].sameSite, 'Lax');
  assert.equal(cookies[0].expires, 1700000000);
  assert.deepEqual(rejected.map((r) => r.name), ['novalue', '(unnamed)', 'nodomain']);
});

test('garbage input is reported, not silently accepted', () => {
  assert.equal(normalizeCookies({ nope: true }).cookies.length, 0);
  assert.match(normalizeCookies({ nope: true }).rejected[0].reason, /expected a JSON array/);
});

test('CLI refuses a cookie file with nothing usable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cookies-'));
  const file = join(dir, 'empty.json');
  writeFileSync(file, '{"cookies":[]}');
  let status = 0;
  try {
    execFileSync(process.execPath, [join(ROOT, 'scripts/import-cookies.mjs'), file], { cwd: ROOT, stdio: 'pipe' });
  } catch (error) {
    status = error.status ?? 1;
  }
  assert.equal(status, 1, 'empty cookie file fails loudly');
});

test('CLI reports an unreadable path without launching a browser', () => {
  let status = 0;
  let stderr = '';
  try {
    execFileSync(process.execPath, [join(ROOT, 'scripts/import-cookies.mjs'), '/nonexistent/cookies.json'], { cwd: ROOT, stdio: 'pipe' });
  } catch (error) {
    status = error.status ?? 1;
    stderr = String(error.stderr ?? '');
  }
  assert.equal(status, 2);
  assert.match(stderr, /cannot read/);
});
