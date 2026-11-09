import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import generic from '../adapters/generic.mjs';
import { ADAPTERS, assertAdapterContract, findAdapter } from '../adapters/index.mjs';
import workable from '../adapters/workable.mjs';
import { fillForm } from '../core/execute.mjs';
import { loadProfile } from '../core/guard.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const SNAPSHOT = pathToFileURL(join(ROOT, 'fixtures/ats/workable/form.html')).href;
const PROFILE = loadProfile(join(ROOT, 'data/profile.json'));
const SCRATCH = mkdtempSync(join(tmpdir(), 'adapters-'));

// browser.mjs reads the profile path at import time, so point it at a throwaway
// directory before loading it; the CLI tests set the same variable for children.
process.env.JOB_APPLY_PROFILE = join(SCRATCH, 'profile');
const { launch } = await import('../scripts/browser.mjs');

let context = null;

/** One headless browser for the file, offline: the saved snapshot is the whole world. */
async function browser() {
  if (context === null) {
    context = await launch({ headless: true });
    // A snapshot loaded over file:// still asks for analytics and ATS bundles;
    // aborting them keeps the test offline and leaves the captured DOM intact.
    await context.route('**/*', (route) => (route.request().url().startsWith('file:') ? route.continue() : route.abort()));
  }
  return context;
}

async function openSnapshot() {
  const ctx = await browser();
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  // Record any send attempt so "the filler never submits" is observed, not assumed.
  await page.addInitScript(() => {
    window.__submitted = false;
    window.addEventListener('submit', () => { window.__submitted = true; }, true);
    window.addEventListener('click', (event) => {
      if (event.target?.closest?.('button[type=submit], input[type=submit]')) window.__submitted = true;
    }, true);
  });
  await page.goto(SNAPSHOT, { waitUntil: 'load' });
  return page;
}

const answers = (profile) => ({
  firstName: profile.identity.firstName.value,
  lastName: profile.identity.lastName.value,
  email: profile.identity.email.value,
  phone: profile.identity.phone.value,
});

test.after(async () => {
  await context?.close();
  rmSync(SCRATCH, { recursive: true, force: true });
});

test('every registered adapter satisfies the adapter contract', () => {
  for (const adapter of ADAPTERS) {
    assert.doesNotThrow(() => assertAdapterContract(adapter), `${adapter.name} satisfies the contract`);
  }
  assert.deepEqual(ADAPTERS.map((adapter) => adapter.name), ['workable', 'greenhouse', 'lever', 'generic']);
  // S1: only an adapter that understands the form may ever auto-submit.
  assert.equal(workable.supportsSubmit, true);
  assert.equal(generic.supportsSubmit, false);
});

test('the contract check names every member an adapter is missing', () => {
  assert.throws(() => assertAdapterContract({}), /name is missing.*supportsSubmit is missing.*detect is missing.*buildMap is missing/);
  assert.throws(
    () => assertAdapterContract({ name: 'broken', supportsSubmit: 'yes', detect: () => false, buildMap: () => {} }),
    /supportsSubmit must be a boolean, got string/,
  );
  assert.throws(
    () => assertAdapterContract({ name: 'broken', supportsSubmit: true, detect: () => false, buildMap: () => {}, submit: 'yes' }),
    /submit is optional but must be a function/,
  );
});

test('findAdapter claims Workable form URLs and falls back to the generic adapter', () => {
  assert.equal(findAdapter('https://apply.workable.com/acme/j/ABC123/').name, 'workable');
  assert.equal(findAdapter('https://acme.workable.com/apply/ABC123').name, 'workable');
  assert.equal(findAdapter('https://acme.workable.com/j/ABC123').name, 'workable');

  // A careers homepage is not a form, and nothing else may claim an unknown ATS.
  assert.equal(findAdapter('https://acme.workable.com/about').name, 'generic');
  assert.equal(findAdapter('https://jobs.lever.co/acme/123').name, 'generic');
  assert.equal(findAdapter('not a url').name, 'generic');
});

test('buildMap answers the snapshot identity controls from the profile', () => {
  const map = workable.buildMap(PROFILE);
  const identity = answers(PROFILE);

  assert.equal(map.fields['First name'], identity.firstName);
  assert.equal(map.fields['Last name'], identity.lastName);
  assert.equal(map.fields.Email, identity.email);
  assert.equal(map.fields.Phone, identity.phone);
  assert.deepEqual(map.fields.Resume, { __file: PROFILE.work.resumePath.value });
  assert.deepEqual(map.missing, [], 'every mapped answer exists in the profile');
});

test('an answer without provenance is not a field, whichever adapter reads it', () => {
  const unprovenanced = {
    identity: {
      email: { value: 'someone@example.com', source: 'assumed' },
      firstName: { value: 'Maulana' },
    },
    blockedTopics: [],
  };

  const map = generic.buildMap(unprovenanced, { controls: ['Email', 'First name'] });

  assert.deepEqual(map.fields, {}, 'no provenance, no answer');
  assert.deepEqual(map.missing, ['identity.firstName', 'identity.email']);
  // Only the profile-read controls: the derived vacancy field never reads the profile.
  assert.deepEqual(Object.keys(workable.buildMap(unprovenanced, { controls: ['Email', 'First name'] }).fields), []);
});

test('screener questions land in questions and blocked, never in fields', () => {
  const map = workable.buildMap(PROFILE);
  const blockedKeys = new Set(PROFILE.blockedTopics.map((entry) => entry.key));
  const questionKeys = new Set(map.questions.map((question) => question.key));

  // Recognised from the snapshot's labels, including the autogenerated CA_* ones.
  for (const key of [
    'answers.expectedSalaryNumeric',
  ]) {
    assert.ok(questionKeys.has(key), `${key} is reported as a question`);
  }

  for (const question of map.questions) {
    assert.equal(typeof question.label, 'string', `${question.key} names the control`);
    assert.equal(typeof question.reason, 'string', `${question.key} explains why it is unanswered`);
    assert.ok(!(question.label in map.fields), `${question.label} is never filled`);
  }

  for (const entry of map.blocked) {
    assert.ok(blockedKeys.has(entry.key), `${entry.key} comes from blockedTopics`);
    assert.ok(questionKeys.has(entry.key), `${entry.key} is a question nobody may answer`);
    assert.ok(!(entry.label in map.fields), `${entry.label} stays empty`);
  }
  // Job Vacancy is no longer here: it is derived from the posting's own role.
  assert.deepEqual(
    map.blocked.map((entry) => entry.key).sort(),
    ['answers.expectedSalaryNumeric'],
  );

  assert.equal(map.fields['Major of Study'], 'Software Engineering', 'the major is derived from the degree string');

  // S2: an answer the profile does not state never becomes a value.
  for (const value of Object.values(map.fields)) assert.notEqual(value, undefined);
});

test('Job Vacancy to Apply is derived from the posting role, never from the profile', () => {
  const controls = ['Job Vacancy to Apply'];
  const withRole = workable.buildMap(PROFILE, { role: 'Backend Engineer - Golang', controls });
  const withoutRole = workable.buildMap(PROFILE, { controls });

  assert.equal(withRole.fields['Job Vacancy to Apply'], 'Backend Engineer - Golang');
  assert.equal(withoutRole.fields['Job Vacancy to Apply'], 'Fullstack Engineer');
  assert.deepEqual(withRole.questions, [], 'a derived value is a field, not a question');
  assert.deepEqual(withRole.blocked, []);
  // Nothing is stored: the profile still has no such answer, so the gap stays on record.
  assert.ok(PROFILE.blockedTopics.some((entry) => entry.key === 'answers.jobVacancy'));
});

test('a confirmed data-processing consent fills the checkbox instead of blocking', () => {
  const label = 'By submitting this form';
  const map = workable.buildMap(PROFILE, {
    controls: ['By submitting this form, I agree to the processing of my personal data'],
  });

  // The value comes from answers.dataProcessingConsent, the key the registry owns.
  assert.equal(map.fields[label], PROFILE.answers.dataProcessingConsent.value);
  assert.ok(map.fields[label]);
  assert.ok(!map.questions.some((question) => question.key === 'answers.dataProcessingConsent'));
  assert.ok(!map.blocked.some((question) => question.key === 'answers.dataProcessingConsent'));
});

test('an absent or declined consent stays blocked instead of being guessed', () => {
  const label = 'By submitting this form';
  const controls = [label];
  const declined = workable.buildMap(
    { ...PROFILE, answers: { ...PROFILE.answers, dataProcessingConsent: { value: false, source: 'confirmed' } } },
    { controls },
  );
  const absent = workable.buildMap({ ...PROFILE, answers: {} }, { controls });

  for (const map of [declined, absent]) {
    assert.ok(!(label in map.fields), 'no consent value is invented');
    assert.ok(map.questions.some((question) => question.label === label), 'a human must decide');
  }
});

test('buildMap narrows to the controls a posting actually renders', () => {
  const map = workable.buildMap(PROFILE, { controls: ['First name', 'Email'] });

  assert.deepEqual(Object.keys(map.fields), ['First name', 'Email']);
  assert.deepEqual(map.questions, [], 'no question for a control the form never shows');
  assert.deepEqual(map.blocked, []);
});

test('fillForm fills the saved snapshot from the map and never submits', async () => {
  const page = await openSnapshot();
  const map = workable.buildMap(PROFILE);
  const identity = answers(PROFILE);

  // Workable renders its custom questions as readonly comboboxes that only an
  // option click can set — the fill step's job, not the map's. Fill the part of
  // the same map the label-based filler can set, and let the rest prove it is
  // left alone rather than guessed at.
  const readonly = await page.evaluate(() =>
    [...document.querySelectorAll('input[readonly], input[role=combobox]')]
      .map((el) => document.getElementById(el.getAttribute('aria-labelledby')?.split(' ')[0] ?? '')?.innerText ?? '')
      .map((label) => label.replaceAll('*', '').trim())
      .filter(Boolean),
  );
  const fillable = Object.fromEntries(
    Object.entries(map.fields).filter(([label]) => !readonly.some((text) => text.toLowerCase() === label.toLowerCase())),
  );
  assert.ok(readonly.includes('Nationality'), 'the snapshot still renders readonly comboboxes');

  const result = await fillForm(page, { fields: fillable, fieldsDir: ROOT });
  const filled = result.filled.map((entry) => entry.field);

  for (const field of ['First name', 'Last name', 'Email', 'Resume', 'LinkedIn URL', 'University']) {
    assert.ok(filled.includes(field), `${field} was filled`);
  }

  const dom = await page.evaluate(() => ({
    firstname: document.getElementById('firstname')?.value,
    lastname: document.getElementById('lastname')?.value,
    email: document.getElementById('email')?.value,
    resume: document.querySelector('input[type=file]')?.files.length,
    birthPlace: document.getElementById('CA_44761')?.value,
    nationality: document.getElementById('input_CA_44765_input')?.value,
    submitted: window.__submitted,
  }));

  assert.equal(dom.firstname, identity.firstName);
  assert.equal(dom.lastname, identity.lastName);
  assert.equal(dom.email, identity.email);
  assert.equal(dom.resume, 1);
  assert.equal(dom.birthPlace, 'Magelang', 'an answered screening question fills from the profile');
  assert.equal(dom.nationality, '', 'a readonly combobox is left for the adapter fill step');
  assert.equal(dom.submitted, false, 'the form was not submitted');
  assert.equal(result.skipped.filter((entry) => /submit/i.test(entry.reason)).length, 0);
  assert.equal(new URL(page.url()).protocol, 'file:');
});

test('prepare opens the "Apply for this job" gate before any mapping happens', async () => {
  const ctx = await browser();
  const page = await ctx.newPage();
  await page.goto(pathToFileURL(join(ROOT, 'fixtures/apply-gate.html')).href, { waitUntil: 'load' });

  assert.deepEqual(await workable.prepare(page), { gate: true });
  await page.close();
});

test('the generic adapter maps standard labels and reports its own gaps', async () => {
  const html = join(SCRATCH, 'form.html');
  writeFileSync(
    html,
    `<!DOCTYPE html><html><body><form>
      <label for="name">Full name</label><input id="name" name="name">
      <label for="email">Email</label><input id="email" name="email" type="email">
      <label for="salary">Expected salary</label><input id="salary" name="salary">
      <button type="submit">Submit application</button>
    </form></body></html>`,
  );

  const controls = ['Full name', 'Email', 'Expected salary'];
  const map = generic.buildMap(PROFILE, { controls });

  assert.deepEqual(Object.keys(map.fields), ['Full name', 'Email']);
  assert.deepEqual(map.missing, []);
  assert.deepEqual(map.blocked, [], 'a generic form is never submitted, so nothing is hard-blocked');
  assert.deepEqual(
    map.questions.map((question) => question.key),
    ['unrecognisedControls'],
    'the adapter says which controls it cannot recognise',
  );

  const ctx = await browser();
  const page = await ctx.newPage();
  await page.goto(pathToFileURL(html).href);
  await fillForm(page, { fields: map.fields });
  const dom = await page.evaluate(() => ({
    name: document.getElementById('name')?.value,
    email: document.getElementById('email')?.value,
    salary: document.getElementById('salary')?.value,
  }));

  assert.equal(dom.name, PROFILE.identity.fullName.value);
  assert.equal(dom.email, PROFILE.identity.email.value);
  assert.equal(dom.salary, '', 'an unrecognised control stays for a human');
  await page.close();
});
