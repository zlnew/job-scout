import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  classifyApplyTarget,
  isAuthwallUrl,
  isLinkedInHost,
  jobIdFromInput,
  mergeResolution,
  pendingResolutions,
  serializeStore,
  unwrapRedirect,
} from './../scripts/resolve.mjs';

const ROOT = resolve(import.meta.dirname, '..');

test('jobIdFromInput reads a raw id or any LinkedIn job URL shape', () => {
  assert.equal(jobIdFromInput({ id: '4440204415' }), '4440204415');
  assert.equal(jobIdFromInput({ url: 'https://www.linkedin.com/jobs/view/4440204415' }), '4440204415');
  assert.equal(jobIdFromInput({ url: 'https://www.linkedin.com/jobs/view/4440204415/' }), '4440204415');
  assert.equal(jobIdFromInput({ url: 'https://www.linkedin.com/jobs/view/4440204415?trk=x' }), '4440204415');
  assert.equal(jobIdFromInput({ url: 'https://www.linkedin.com/jobs/search/?currentJobId=4440204415' }), '4440204415');
});

test('jobIdFromInput rejects missing or non-numeric input', () => {
  assert.throws(() => jobIdFromInput({}), /provide --id or --url/);
  assert.throws(() => jobIdFromInput({ id: 'abc' }), /not a LinkedIn job id/);
  assert.throws(() => jobIdFromInput({ url: 'https://www.linkedin.com/feed' }), /not a LinkedIn job id/);
  assert.throws(() => jobIdFromInput({ url: 'https://boards.greenhouse.io/acme/jobs/1' }), /not a LinkedIn job id/);
});

test('isLinkedInHost covers linkedin.com subdomains and licdn.com only', () => {
  assert.equal(isLinkedInHost('https://www.linkedin.com/jobs/view/1'), true);
  assert.equal(isLinkedInHost('https://linkedin.com/jobs/view/1'), true);
  assert.equal(isLinkedInHost('https://media.licdn.com/asset'), true);
  assert.equal(isLinkedInHost('https://boards.greenhouse.io/acme'), false);
  assert.equal(isLinkedInHost('https://linkedin.com.evil.example/jobs'), false);
  assert.equal(isLinkedInHost('javascript:void(0)'), false);
  assert.equal(isLinkedInHost(''), false);
});

test('classifyApplyTarget prefers a non-LinkedIn href over LinkedIn ones', () => {
  const result = classifyApplyTarget({
    hrefs: ['https://www.linkedin.com/jobs/view/1', 'https://boards.greenhouse.io/acme/jobs/7', 'https://jobs.lever.co/acme/9'],
    buttonLabel: 'Apply on company site',
  });

  assert.equal(result.kind, 'ats');
  assert.equal(result.applyUrl, 'https://boards.greenhouse.io/acme/jobs/7');
  assert.ok(result.reason.length > 0);
});

test('classifyApplyTarget ignores empty, fragment, and javascript hrefs', () => {
  const result = classifyApplyTarget({ hrefs: ['', '#', '#apply', 'javascript:void(0)'] });

  assert.equal(result.kind, 'manual');
  assert.equal(result.applyUrl, null);
});

test('classifyApplyTarget classifies a popup or same-tab navigation off LinkedIn', () => {
  const popup = classifyApplyTarget({ popupUrl: 'https://acme.myworkdayjobs.com/apply' });
  assert.equal(popup.kind, 'ats');
  assert.equal(popup.applyUrl, 'https://acme.myworkdayjobs.com/apply');

  const navigation = classifyApplyTarget({ navigatedTo: 'https://jobs.lever.co/acme/9' });
  assert.equal(navigation.kind, 'ats');
  assert.equal(navigation.applyUrl, 'https://jobs.lever.co/acme/9');
});

test('classifyApplyTarget falls through href to popup to Easy Apply to manual', () => {
  // An offsite href wins even when a popup also opened somewhere.
  const hrefWins = classifyApplyTarget({
    hrefs: ['https://boards.greenhouse.io/acme/jobs/7'],
    popupUrl: 'https://other.example/apply',
    sawEasyApplyModal: true,
  });
  assert.equal(hrefWins.applyUrl, 'https://boards.greenhouse.io/acme/jobs/7');

  // A LinkedIn popup is not offsite; the Easy Apply form decides next.
  const linkedinPopup = classifyApplyTarget({
    popupUrl: 'https://www.linkedin.com/jobs/view/2',
    sawEasyApplyModal: true,
  });
  assert.equal(linkedinPopup.kind, 'easy-apply');
  assert.equal(linkedinPopup.applyUrl, null);

  const linkedinPopupOnly = classifyApplyTarget({ popupUrl: 'https://www.linkedin.com/jobs/view/2' });
  assert.equal(linkedinPopupOnly.kind, 'manual');
});

test('classifyApplyTarget reports Easy Apply as a form this harness never submits', () => {
  const result = classifyApplyTarget({ sawEasyApplyModal: true });

  assert.equal(result.kind, 'easy-apply');
  assert.equal(result.applyUrl, null);
  assert.match(result.reason, /Easy Apply/);
});

test('isAuthwallUrl spots login and checkpoint redirects', () => {
  assert.equal(isAuthwallUrl('https://www.linkedin.com/authwall?trk=guest_homepage'), true);
  assert.equal(isAuthwallUrl('https://www.linkedin.com/login?session_redirect=x'), true);
  assert.equal(isAuthwallUrl('https://www.linkedin.com/checkpoint/challenge/1'), true);
  assert.equal(isAuthwallUrl('https://www.linkedin.com/jobs/view/4440204415'), false);
  assert.equal(isAuthwallUrl('https://boards.greenhouse.io/acme/jobs/7'), false);
});

test('mergeResolution updates the matching record and leaves the rest untouched', () => {
  const records = [
    { company: 'A', status: 'shortlisted', url: 'https://www.linkedin.com/jobs/view/111', notes: 'keep' },
    { company: 'B', status: 'shortlisted', url: 'https://www.linkedin.com/jobs/view/222' },
  ];

  const merged = mergeResolution(
    records,
    {
      id: '222',
      kind: 'ats',
      applyUrl: 'https://boards.greenhouse.io/b/jobs/9',
    },
    '2000-01-02',
  );

  assert.equal(merged[0], records[0], 'unmatched records are not rewritten');
  assert.deepEqual(merged[0], records[0]);
  assert.deepEqual(merged[1], {
    company: 'B',
    status: 'shortlisted',
    url: 'https://www.linkedin.com/jobs/view/222',
    applyUrl: 'https://boards.greenhouse.io/b/jobs/9',
    applyKind: 'ats',
    resolvedAt: '2000-01-02',
  });
  assert.deepEqual(records[1], { company: 'B', status: 'shortlisted', url: 'https://www.linkedin.com/jobs/view/222' }, 'input is not mutated');
});

test('mergeResolution records a null applyUrl when no ATS was found', () => {
  const records = [{ company: 'A', url: 'https://www.linkedin.com/jobs/view/111' }];
  const merged = mergeResolution(records, {
    id: '111',
    kind: 'easy-apply',
    applyUrl: null,
    resolvedAt: '2026-11-09',
  });

  assert.equal(merged[0].applyKind, 'easy-apply');
  assert.equal(merged[0].applyUrl, null);
  assert.equal(merged[0].company, 'A');
});

test('pendingResolutions picks only shortlisted, unresolved LinkedIn rows', () => {
  const records = [
    { status: 'shortlisted', url: 'https://www.linkedin.com/jobs/view/111' },
    { status: 'shortlisted', url: 'https://www.linkedin.com/jobs/view/222', applyUrl: 'https://acme.example/apply' },
    { status: 'stretch', url: 'https://www.linkedin.com/jobs/view/333' },
    { status: 'shortlisted', url: 'https://boards.greenhouse.io/acme/jobs/7' },
    { status: 'shortlisted', url: 'https://www.linkedin.com/jobs/view/444' },
  ];

  assert.deepEqual(pendingResolutions(records, 5), ['111', '444']);
  assert.deepEqual(pendingResolutions(records, 1), ['111']);
});

test('serializeStore keeps 2-space JSON and a trailing newline', () => {
  const store = {
    updated: '2026-11-09',
    applications: [{ company: 'A', url: 'https://www.linkedin.com/jobs/view/111' }],
  };
  const text = serializeStore(store);

  assert.equal(text, `${JSON.stringify(store, null, 2)}\n`);
  assert.ok(text.endsWith('}\n'));
  assert.deepEqual(JSON.parse(text), store);
});

test('CLI without arguments prints usage and exits 2', () => {
  let status = 0;
  let stderr = '';
  try {
    execFileSync(process.execPath, [join(ROOT, 'scripts/resolve.mjs')], { cwd: ROOT, stdio: 'pipe' });
  } catch (error) {
    status = error.status ?? 1;
    stderr = String(error.stderr ?? '');
  }

  assert.equal(status, 2);
  assert.match(stderr, /usage: node scripts\/resolve\.mjs/);
});

test('an Easy Apply button is classified without clicking it', () => {
  const result = classifyApplyTarget({ buttonLabel: 'Easy Apply' });
  assert.equal(result.kind, 'easy-apply');
  assert.equal(result.applyUrl, null);
  assert.match(result.reason, /Easy Apply button/);
});

test('an Easy Apply label outranks an easy-apply modal heuristic', () => {
  assert.equal(classifyApplyTarget({ buttonLabel: 'Easy Apply', sawEasyApplyModal: true }).kind, 'easy-apply');
});

test('unwraps LinkedIn safety redirects to the real ATS', () => {
  const wrapped =
    'https://www.linkedin.com/safety/go/?url=https%3A%2F%2Fcareers%2Etraveloka%2Ecom%2Fjobs%2Fmj000346-software-backend-engineer%3FsourceToken%3Dabc&urlhash=xyz';
  assert.equal(unwrapRedirect(wrapped), 'https://careers.traveloka.com/jobs/mj000346-software-backend-engineer?sourceToken=abc');
  assert.equal(unwrapRedirect('https://boards.greenhouse.io/acme'), 'https://boards.greenhouse.io/acme');
  assert.equal(unwrapRedirect('https://www.linkedin.com/jobs/view/1'), 'https://www.linkedin.com/jobs/view/1');
  assert.equal(unwrapRedirect(''), '');
});

test('a wrapped offsite link classifies as an ATS target', () => {
  const href = 'https://www.linkedin.com/safety/go/?url=https%3A%2F%2Fcareers%2Etraveloka%2Ecom%2Fjobs%2Fmj000346';
  const result = classifyApplyTarget({ hrefs: [href], buttonLabel: 'Apply' });
  assert.equal(result.kind, 'ats');
  assert.equal(result.applyUrl, 'https://careers.traveloka.com/jobs/mj000346');
});
