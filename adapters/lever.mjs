/**
 * Lever adapter (jobs.lever.co). The posting page links to `<job>/apply`, which
 * renders the form directly — no consent wall, no gate click — as a list of
 * `li.application-question` blocks whose label wraps the control, so label-based
 * filling reaches every standard field.
 *
 * Custom questions live under `cards[<uuid>][field<n>]` names that change with
 * the posting, and only the label text is stable, so the map never keys on an
 * input name (S3).
 *
 * S2 governs every entry: a control resolves from a profile answer with usable
 * provenance, or it becomes a `question` for a human. Nothing is invented, and
 * a `blockedTopics` match is additionally reported as `blocked` because that
 * answer must never be supplied, not even manually.
 */
import { findSubmit } from '../core/execute.mjs';
import { resolveQuestion } from '../core/screening.mjs';
import { blockedReasons, narrowToControls, readAnswer } from './generic.mjs';

/** Label (and optional extra match terms) -> profile path, or the question key it needs. */
const CONTROLS = [
  // Lever asks for one full name instead of a first and a last name.
  { label: 'Full name', path: 'identity.fullName' },
  { label: 'Email', path: 'identity.email' },
  { label: 'Phone', path: 'identity.phone' },
  { label: 'Current location', path: 'identity.location' },
  { label: 'Resume/CV', path: 'work.resumePath', file: true },
  { label: 'LinkedIn URL', path: 'identity.links.linkedin' },
  { label: 'GitHub URL', path: 'identity.links.github' },
  { label: 'Portfolio URL', path: 'identity.links.site' },
  // Optional free-text field on older postings; no source states an employer.
  {
    label: 'Current company',
    ask: 'answers.currentCompany',
    reason: 'the profile states no current employer, and neo-portfolio is not a source for one',
  },
];

/** The one textarea Lever offers for a letter; the cover letter goes here when it exists. */
const COVER_LETTER = 'Additional information';

export function detect(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.hostname !== 'lever.co' && !parsed.hostname.endsWith('.lever.co')) return false;
  // Only the apply view renders a form; the posting itself is a description page.
  return /^\/[^/]+\/[^/]+\/apply\/?$/.test(parsed.pathname);
}

/** Click the real submit control. Only reached after `checkSubmission` passes (S1). */
export async function submit(page) {
  const button = await findSubmit(page);
  if (!button) throw new Error('lever: the form has no submit control');
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
  // A posting can render the same question under a label the table does not know;
  // remember what the first pass already decided so nothing is reported twice.
  const handled = new Set();

  for (const entry of CONTROLS) {
    if (!onForm(entry)) continue;
    handled.add(entry.label);

    // Identity and file controls are not screening questions: their value is a
    // profile answer with provenance, read straight from the path.
    if (entry.path) {
      const value = readAnswer(profile, entry.path);
      if (value === null) {
        missing.add(entry.path);
        continue;
      }
      fields[entry.label] = entry.file ? { __file: value } : value;
      continue;
    }

    // Every recognised question is classified by the shared registry (S2/L4):
    // only an answer with provenance is filled, everything else is reported.
    const result = resolveQuestion(entry.label, profile);
    if (result.status === 'answer') {
      fields[entry.label] = result.value;
      continue;
    }

    const question = {
      label: entry.label,
      key: result.key ?? entry.ask,
      // A registry miss has a generic reason; the adapter knows why it is open.
      reason: result.status === 'unknown' ? (entry.reason ?? result.reason) : result.reason,
    };
    questions.push(question);
    // A blockedTopics match is a question nobody may answer, not just an open one.
    if (blockedFor.has(question.key)) blocked.push(question);
  }

  // The letter is written per posting, so the textarea only gets a value when one
  // exists; an empty one stays open instead of submitting without it.
  if (present(COVER_LETTER)) {
    handled.add(COVER_LETTER);
    if (posting.coverLetter) fields[COVER_LETTER] = posting.coverLetter;
    else {
      questions.push({
        label: COVER_LETTER,
        key: 'coverLetter',
        reason: 'no cover letter has been written for this posting yet',
      });
    }
  }

  // Whatever else the posting renders is a question for a human: the registry
  // decides which of those it can answer (work authorization, EEO, ...). A
  // posting's radio pair or dropdown is not something a text answer can set, and
  // the fill step reports it rather than guessing (S2).
  for (const label of posting.controls ?? []) {
    const text = String(label);
    if ([...handled].some((known) => text.toLowerCase().includes(known.toLowerCase()))) continue;
    if (Object.hasOwn(fields, text)) continue;
    handled.add(text);

    const result = resolveQuestion(text, profile);
    if (result.status === 'answer') {
      fields[text] = result.value;
      continue;
    }
    const question = {
      label: text,
      key: result.key ?? text,
      reason: result.reason,
    };
    questions.push(question);
    if (blockedFor.has(question.key)) blocked.push(question);
  }

  return { fields, questions, blocked, missing: [...missing] };
}

export default {
  name: 'lever',
  // A map with nothing open is a form this adapter understands end to end, so
  // auto-submit may fire (S1). `checkSubmission` remains the final gate.
  supportsSubmit: true,
  detect,
  submit,
  buildMap,
};
