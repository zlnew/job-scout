/**
 * Workable adapter (apply.workable.com). The gateway to every Workable posting:
 * consent wall, "Apply for this job" gate, then a React form whose custom
 * questions are named `CA_<digits>` — only their labels are stable, so the map
 * below keys on labels and never on input names (S3).
 *
 * S2 governs every entry: a control resolves from a profile answer with usable
 * provenance, or it becomes a `question` for a human. Nothing is invented, and
 * a `blockedTopics` match is additionally reported as `blocked` because that
 * answer must never be supplied, not even manually.
 */
import { dismissConsent, findSubmit, openGate } from '../core/execute.mjs';
import { blockedReasons, narrowToControls, readAnswer } from './generic.mjs';

/** Label (and optional extra match terms) -> profile path, or the question key it needs. */
const CONTROLS = [
  { label: 'First name', path: 'identity.firstName' },
  { label: 'Last name', path: 'identity.lastName' },
  { label: 'Email', path: 'identity.email' },
  // The phone input shares its label text with intl-tel-input's country button,
  // which sits first in the DOM; label-based filling skips the button and leaves
  // the number empty, so the guard refuses this form instead of sending it.
  { label: 'Phone', path: 'identity.phone' },
  { label: 'Address', path: 'identity.location' },
  { label: 'City', path: 'identity.city' },
  { label: 'LinkedIn URL', path: 'identity.links.linkedin' },
  { label: 'Website', path: 'identity.links.site' },
  { label: 'Resume', path: 'work.resumePath', file: true },
  // Custom questions render as readonly comboboxes: the answers below are right,
  // but setting them needs an adapter-level option click (the fill step's job).
  { label: 'Nationality', path: 'work.citizenship' },
  { label: 'Notice Period', path: 'work.noticePeriod' },
  { label: 'Work Eligibility', path: 'work.authorizedIn' },
  { label: 'Total Working Experience', path: 'titles.yearsExperience' },
  { label: 'University', path: 'education[0].school' },
  { label: 'Education Degree', path: 'education[0].degree' },
  { label: 'GPA', path: 'education[0].gpa' },
  { label: 'Year of Graduation', path: 'education[0].end' },

  // Screener questions: recognised, but no profile answer exists for them.
  { label: 'Birth Place', ask: 'birthPlace' },
  { label: 'Birth Date', ask: 'birthDate' },
  { label: 'Gender', ask: 'gender' },
  { label: 'Religion', ask: 'religion' },
  { label: 'Marital Status', ask: 'maritalStatus' },
  { label: 'Current monthly salary', ask: 'currentSalary', match: ['Current monthly salary in IDR'] },
  { label: 'Expected monthly salary', ask: 'expectedSalaryNumeric', match: ['Expected monthly salary In IDR'] },
  {
    label: 'Major of Study',
    ask: 'majorOfStudy',
    reason: 'the profile records one degree string (B.Sc. Software Engineering); the major on its own is not a stated answer',
  },
  {
    label: 'Job Vacancy to Apply',
    ask: 'jobVacancy',
    reason: 'the posting is not mapped to a Workable vacancy id yet, and guessing one would misroute the application',
  },
  {
    label: 'Employees who have family ties with your relatives',
    ask: 'relativeEmployees',
    match: ['family ties'],
    reason: 'a personal fact about relatives inside the company that no source states',
  },
  {
    label: 'By submitting this form',
    ask: 'dataProcessingConsent',
    match: ['By submitting this form', 'Personal Data'],
    reason: 'a data-processing consent the applicant must give personally, not the agent',
  },
];

export function detect(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.hostname === 'apply.workable.com') return true;
  // Careers pages live on <company>.workable.com; only the apply paths are forms.
  return /(^|\.)workable\.com$/.test(parsed.hostname) && /^\/(apply|j)(\/|$)/.test(parsed.pathname);
}

/** Workable gates the form behind a cookie wall and an "Apply for this job" button. */
export async function prepare(page) {
  await dismissConsent(page);
  const gate = await openGate(page, 'apply for this job');
  return { gate };
}

/** Click the real submit control. Only reached after `checkSubmission` passes (S1). */
export async function submit(page) {
  const button = await findSubmit(page);
  if (!button) throw new Error('workable: the form has no submit control');
  await button.click();
}

export function buildMap(profile, posting = {}) {
  const fields = {};
  const questions = [];
  const blocked = [];
  const missing = new Set();
  const blockedFor = blockedReasons(profile);
  const present = narrowToControls(posting.controls);
  const onForm = (entry) => [entry.label, ...(entry.match ?? [])].some(present);

  for (const entry of CONTROLS) {
    if (!onForm(entry)) continue;

    if (entry.ask) {
      const reason = blockedFor.get(entry.ask) ?? entry.reason;
      const question = { label: entry.label, key: entry.ask, reason };
      questions.push(question);
      // A blockedTopics match is a question nobody may answer, not just an open one.
      if (blockedFor.has(entry.ask)) blocked.push(question);
      continue;
    }

    const value = readAnswer(profile, entry.path);
    if (value === null) {
      missing.add(entry.path);
      continue;
    }
    fields[entry.label] = entry.file ? { __file: value } : value;
  }

  // The cover letter is generated per posting, so it only exists when one was written.
  if (posting.coverLetter && present('Cover letter')) fields['Cover letter'] = posting.coverLetter;

  return { fields, questions, blocked, missing: [...missing] };
}

export default {
  name: 'workable',
  // Meaningful only for a map with no questions, blocked or missing entries;
  // `checkSubmission` from core/guard.mjs stays the final authority.
  supportsSubmit: true,
  detect,
  buildMap,
  prepare,
  submit,
};
