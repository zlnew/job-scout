import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveTarget, SITES } from './../scripts/login.mjs';

test('bare login defaults to LinkedIn', () => {
  assert.equal(resolveTarget({}, []), SITES.linkedin);
});

test('named sites resolve, explicit URLs win', () => {
  assert.equal(resolveTarget({ site: 'glints' }, []), SITES.glints);
  assert.equal(resolveTarget({ site: 'Kalibrr' }, []), SITES.kalibrr);
  assert.equal(resolveTarget({}, ['dealls']), SITES.dealls);
  assert.equal(resolveTarget({ site: 'https://example.com/login' }, []), 'https://example.com/login');
});

test('unknown site fails with the usable list', () => {
  assert.throws(() => resolveTarget({ site: 'jobstreet' }, []), /unknown site "jobstreet".*linkedin, glints, kalibrr, dealls/);
});
