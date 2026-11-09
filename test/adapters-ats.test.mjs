/**
 * Greenhouse and Lever adapters, offline: both assertions run against a saved
 * snapshot of the real apply page, and every request that is not file:// is
 * aborted, so the tests never touch the network (design §2.5).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import generic from '../adapters/generic.mjs';
import greenhouse from '../adapters/greenhouse.mjs';
import { ADAPTERS, assertAdapterContract, findAdapter } from '../adapters/index.mjs';
import lever from '../adapters/lever.mjs';
import { fillForm } from '../core/execute.mjs';
import { loadProfile } from '../core/guard.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const snapshot = (ats) => pathToFileURL(join(ROOT, `fixtures/ats/${ats}/form.html`)).href;
const PROFILE = loadProfile(join(ROOT, 'data/profile.json'));
const SCRATCH = mkdtempSync(join(tmpdir(), 'adapters-ats-'));

// browser.mjs reads the profile path at import time, so point it at a throwaway
// directory before loading it; the CLI tests set the same variable for children.
process.env.JOB_APPLY_PROFILE = join(SCRATCH, 'profile');
const { launch } = await import('../scripts/browser.mjs');

let context = null;

/** One headless browser for the file, offline: the saved snapshot is the whole world. */
async function browser() {
  if (context === null) {
    context = await launch({ headless: true });
    await context.route('**/*', (route) => (route.request().url().startsWith('file:') ? route.continue() : route.abort()));
  }
  return context;
}

async function openSnapshot(ats) {
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
  await page.goto(snapshot(ats), { waitUntil: 'load' });
  return page;
}

const blockedKeys = new Set((PROFILE.blockedTopics ?? []).map((entry) => entry.key));
const answers = (profile) => ({
  firstName: profile.identity.firstName.value,
  lastName: profile.identity.lastName.value,
  fullName: profile.identity.fullName.value,
  email: profile.identity.email.value,
  phone: profile.identity.phone.value,
  location: profile.identity.location.value,
  city: profile.identity.city.value,
});

test.after(async () => {
  await context?.close();
  rmSync(SCRATCH, { recursive: true, force: true });
});

test('both ATS adapters satisfy the contract and claim only their apply pages', () => {
  for (const adapter of [greenhouse, lever]) {
    assert.doesNotThrow(() => assertAdapterContract(adapter), `${adapter.name} satisfies the contract`);
    assert.ok(ADAPTERS.includes(adapter), `${adapter.name} is registered`);
    // A form this adapter understands end to end may be submitted without
    // approval (S1); the registry still ends with the generic fallback (S3).
    assert.equal(adapter.supportsSubmit, true);
  }
  assert.equal(ADAPTERS.at(-1), generic, 'the label-based fallback stays last');

  assert.equal(findAdapter('https://boards.greenhouse.io/acme/jobs/1').name, 'greenhouse');
  assert.equal(findAdapter('https://job-boards.greenhouse.io/acme/jobs/123').name, 'greenhouse');
  assert.equal(findAdapter('https://jobs.lever.co/acme/abc/apply').name, 'lever');

  // A board home or a posting without the apply view is not a form.
  assert.equal(findAdapter('https://boards.greenhouse.io/acme').name, 'generic');
  assert.equal(findAdapter('https://jobs.lever.co/acme/abc').name, 'generic');
  assert.equal(findAdapter('https://example.com/acme/jobs/1').name, 'generic');
  assert.equal(findAdapter('not a url').name, 'generic');
});

test('greenhouse answers the saved identity controls and names what it leaves open', () => {
  const map = greenhouse.buildMap(PROFILE);
  const identity = answers(PROFILE);

  assert.equal(map.fields['First Name'], identity.firstName);
  assert.equal(map.fields['Last Name'], identity.lastName);
  assert.equal(map.fields.Email, identity.email);
  assert.equal(map.fields.Phone, identity.phone);
  assert.equal(map.fields['Location (City)'], identity.city);
  assert.equal(map.fields['LinkedIn Profile'], PROFILE.identity.links.linkedin.value);
  assert.deepEqual(map.fields['Resume/CV'], { __file: PROFILE.work.resumePath.value });
  assert.deepEqual(map.missing, [], 'every mapped answer exists in the profile');

  // The discipline on its own is not a stated answer, so it is reported, not derived.
  // "Discipline" is another name for major; the degree string supplies it.
  assert.equal(map.fields.Discipline, 'Software Engineering', 'a discipline resolves from the derived major');
  assert.ok(!map.questions.some((question) => question.label === 'Discipline'));
});

test('greenhouse routes a posting\'s own questions through the screening registry', () => {
  const map = greenhouse.buildMap(PROFILE, {
    controls: [
      'First Name',
      'Email',
      'Are you legally authorized to work in the United States for our Company?',
      'Why do you want to work at Discord?',
      'Race and Ethnicity',
      'Cover Letter',
    ],
  });

  assert.equal(map.fields['First Name'], PROFILE.identity.firstName.value);
  assert.equal(map.fields['Are you legally authorized to work in the United States for our Company?'], PROFILE.work.authorizedIn.value);

  const labels = map.questions.map((question) => question.label);
  assert.ok(labels.includes('Why do you want to work at Discord?'), 'an unanswerable question is reported');
  assert.ok(labels.includes('Race and Ethnicity'), 'an EEO question nobody may answer is reported');
  assert.ok(labels.includes('Cover Letter'), 'an unwritten cover letter stays open');

  // S2: the registry's blockedTopics decision reaches the map as `blocked` too.
  assert.deepEqual(map.blocked.map((entry) => entry.key), ['answers.race']);

  for (const question of map.questions) {
    assert.equal(typeof question.reason, 'string', `${question.label} explains why it is unanswered`);
    assert.ok(!(question.label in map.fields), `${question.label} is never filled`);
  }
  for (const key of Object.keys(map.fields)) {
    assert.ok(!blockedKeys.has(key), `${key} is not a blocked topic`);
  }
});

test('lever answers the saved identity controls and keeps the letter for the posting', () => {
  const map = lever.buildMap(PROFILE);
  const identity = answers(PROFILE);

  assert.equal(map.fields['Full name'], identity.fullName);
  assert.equal(map.fields.Email, identity.email);
  assert.equal(map.fields.Phone, identity.phone);
  assert.equal(map.fields['Current location'], identity.location);
  assert.equal(map.fields['LinkedIn URL'], PROFILE.identity.links.linkedin.value);
  assert.equal(map.fields['GitHub URL'], PROFILE.identity.links.github.value);
  assert.deepEqual(map.fields['Resume/CV'], { __file: PROFILE.work.resumePath.value });
  assert.deepEqual(map.missing, []);

  // No source names an employer, so the control is a question with a reason.
  const company = map.questions.find((question) => question.label === 'Current company');
  assert.ok(company, 'Current company is reported as a question');
  assert.equal(typeof company.reason, 'string');

  // The letter is per posting: present when written, otherwise open.
  const withLetter = lever.buildMap(PROFILE, { coverLetter: 'Dear team,', controls: ['Additional information'] });
  assert.equal(withLetter.fields['Additional information'], 'Dear team,');

  const withoutLetter = lever.buildMap(PROFILE, { controls: ['Additional information'] });
  assert.ok(!('Additional information' in withoutLetter.fields));
  assert.ok(withoutLetter.questions.some((question) => question.label === 'Additional information'));
});

test('greenhouse fills the saved snapshot from the map and never submits', async () => {
  const page = await openSnapshot('greenhouse');
  const identity = answers(PROFILE);

  // The city is a react-select whose options Greenhouse loads from its own API;
  // the snapshot is offline, so the option click has nothing to pick. The map
  // still carries the answer — the fill step owns the widget, not the map.
  await greenhouse.prepare(page);
  const map = greenhouse.buildMap(PROFILE);
  const fillable = Object.fromEntries(Object.entries(map.fields).filter(([label]) => label !== 'Location (City)'));

  const result = await fillForm(page, { fields: fillable, fieldsDir: ROOT });
  const filled = result.filled.map((entry) => entry.field);
  for (const field of ['First Name', 'Last Name', 'Email', 'Phone', 'Resume/CV', 'LinkedIn Profile']) {
    assert.ok(filled.includes(field), `${field} was filled`);
  }

  const dom = await page.evaluate(() => ({
    firstName: document.getElementById('first_name')?.value,
    lastName: document.getElementById('last_name')?.value,
    email: document.getElementById('email')?.value,
    phone: document.getElementById('phone')?.value,
    linkedin: document.getElementById('question_39004000002')?.value,
    resume: document.getElementById('resume')?.files.length,
    submitted: window.__submitted,
  }));

  assert.equal(dom.firstName, identity.firstName);
  assert.equal(dom.lastName, identity.lastName);
  assert.equal(dom.email, identity.email);
  assert.equal(dom.phone, identity.phone);
  assert.equal(dom.linkedin, PROFILE.identity.links.linkedin.value);
  assert.equal(dom.resume, 1, 'the resume file landed on the upload input');
  assert.equal(dom.submitted, false, 'filling never sends the form');
});

test('lever fills the saved snapshot from the map and never submits', async () => {
  const page = await openSnapshot('lever');
  const identity = answers(PROFILE);
  const map = lever.buildMap(PROFILE);

  const result = await fillForm(page, { fields: map.fields, fieldsDir: ROOT });
  const filled = result.filled.map((entry) => entry.field);
  for (const field of ['Full name', 'Email', 'Phone', 'Current location', 'Resume/CV', 'LinkedIn URL']) {
    assert.ok(filled.includes(field), `${field} was filled`);
  }

  const dom = await page.evaluate(() => ({
    fullName: document.querySelector('input[name="name"]')?.value,
    email: document.querySelector('input[name="email"]')?.value,
    phone: document.querySelector('input[name="phone"]')?.value,
    location: document.querySelector('input[name="location"]')?.value,
    resume: document.querySelector('input[name="resume"]')?.files.length,
    linkedin: [...document.querySelectorAll('.application-field input')].find((input) =>
      input.closest('li')?.textContent?.includes('LinkedIn URL'))?.value,
    submitted: window.__submitted,
  }));

  assert.equal(dom.fullName, identity.fullName);
  assert.equal(dom.email, identity.email);
  assert.equal(dom.phone, identity.phone);
  assert.equal(dom.location, identity.location);
  assert.equal(dom.linkedin, PROFILE.identity.links.linkedin.value);
  assert.equal(dom.resume, 1, 'the resume file landed on the upload input');
  assert.equal(dom.submitted, false, 'filling never sends the form');
});
