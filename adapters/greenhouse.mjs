/**
 * Greenhouse adapter (boards.greenhouse.io, job-boards.greenhouse.io). The
 * posting page renders the whole form inline (`#application-form`), so there is
 * no gate to click and no consent wall: the only page preparation is naming the
 * two upload controls (see `prepare`).
 *
 * Custom questions arrive as `.field-wrapper` blocks whose label text is the
 * only stable identifier — the `question_<digits>` ids are per-posting — so the
 * map keys on labels and never on ids or input names (S3).
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
  { label: 'First Name', path: 'identity.firstName' },
  { label: 'Last Name', path: 'identity.lastName' },
  { label: 'Email', path: 'identity.email' },
  { label: 'Phone', path: 'identity.phone' },
  // Greenhouse renders the city as a react-select over their own location list,
  // which is why the profile carries `identity.city` separately from the
  // free-text `identity.location` the other adapters use.
  { label: 'Location (City)', path: 'identity.city' },
  { label: 'Resume/CV', path: 'work.resumePath', file: true },
  // Education controls are react-selects over Greenhouse's own school list.
  { label: 'School', ask: 'education[0].school' },
  { label: 'Degree', ask: 'education[0].degree' },
  // No profile answer splits the major out of the one degree string.
  {
    label: 'Discipline',
    ask: 'majorOfStudy',
    reason: 'the profile records one degree string (B.Sc. Software Engineering); the major on its own is not a stated answer',
  },

  // Per-posting custom questions that resolve from the profile when the posting
  // renders them. Everything else on the form is classified from `posting.controls`.
  { label: 'LinkedIn Profile', path: 'identity.links.linkedin', match: ['LinkedIn'] },
  { label: 'Website', path: 'identity.links.site', match: ['Portfolio', 'Personal website'] },
];

export function detect(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  // Any greenhouse.io host serves a board; only a job path renders the form.
  if (parsed.hostname !== 'greenhouse.io' && !parsed.hostname.endsWith('.greenhouse.io')) return false;
  return /^\/[^/]+\/jobs\/[^/]+/.test(parsed.pathname);
}

/**
 * Both upload groups label their file input "Attach", so a label-based filler
 * cannot tell the résumé from the cover letter and would send the résumé twice.
 * The group heading is the stable, human-visible name, so copy it onto the input
 * before anything locates the control by label.
 */
export async function prepare(page) {
  const uploads = await page.evaluate((pairs) => {
    let tagged = 0;
    for (const [id, label] of pairs) {
      const input = document.getElementById(id);
      if (!input) continue;
      input.setAttribute('aria-label', label);
      tagged += 1;
    }
    return tagged;
  }, [['resume', 'Resume/CV'], ['cover_letter', 'Cover Letter']]);
  return { uploads };
}

/** Click the real submit control. Only reached after `checkSubmission` passes (S1). */
export async function submit(page) {
  const button = await findSubmit(page);
  if (!button) throw new Error('greenhouse: the form has no submit control');
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

  // The cover letter is written per posting, so the control only gets a value
  // when one exists; an empty upload stays open instead of submitting without it.
  if (present('Cover Letter')) {
    handled.add('Cover Letter');
    if (posting.coverLetter) fields['Cover Letter'] = posting.coverLetter;
    else {
      questions.push({
        label: 'Cover Letter',
        key: 'coverLetter',
        reason: 'no cover letter has been written for this posting yet',
      });
    }
  }

  // Whatever else the posting renders is a question for a human: the registry
  // decides which of those it can answer (EEO, work history, salary, ...).
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
  name: 'greenhouse',
  // A map with nothing open is a form this adapter understands end to end, so
  // auto-submit may fire (S1). `checkSubmission` remains the final gate.
  supportsSubmit: true,
  detect,
  prepare,
  submit,
  buildMap,
};
