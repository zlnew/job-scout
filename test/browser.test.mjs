import assert from 'node:assert/strict';
import test from 'node:test';
import { launchTarget } from './../scripts/browser.mjs';

test('uses a cached playwright chromium when one exists', () => {
  assert.deepEqual(launchTarget({ env: {}, findCached: () => '/cache/chromium-1/chrome-linux64/chrome' }), {
    executablePath: '/cache/chromium-1/chrome-linux64/chrome',
  });
});

test('falls back to system Chrome when no playwright browser is installed', () => {
  assert.deepEqual(launchTarget({ env: {}, findCached: () => null }), { channel: 'chrome' });
});

test('explicit binary and channel overrides win over the cache', () => {
  assert.deepEqual(launchTarget({ env: { JOB_APPLY_CHROME: '/usr/bin/google-chrome' }, findCached: () => '/cache/chrome' }), {
    executablePath: '/usr/bin/google-chrome',
  });
  assert.deepEqual(launchTarget({ env: { JOB_APPLY_CHANNEL: 'msedge' }, findCached: () => '/cache/chrome' }), { channel: 'msedge' });
});
