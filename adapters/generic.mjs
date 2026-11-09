/**
 * Label-based fallback adapter: best effort over the standard application
 * fields, never auto-submit (an unrecognised form is a human's call).
 *
 * It also hosts the label-map helpers shared by label-driven adapters, so the
 * S2 rule — an answer exists only with `confirmed` or `derived` provenance —
 * lives in exactly one place instead of being re-implemented per adapter.
 */

const USABLE_SOURCES = new Set(['confirmed', 'derived']);

const isAnswer = (node) =>
  Boolean(node) && typeof node === 'object' && !Array.isArray(node) && Object.hasOwn(node, 'value');

/**
 * Read one profile answer by dotted path, e.g. `identity.email` or
 * `education[0].school`.
 *
 * Answer nodes are `{ value, source, scope }` wrappers. Lists such as
 * `education` are the value of a single answer, so their items inherit that
 * answer's provenance; anything without usable provenance reads as absent,
 * which is what S2 requires of a field map.
 */
export function readAnswer(profile, path) {
  // The capture group makes the dot alternative yield `undefined` entries.
  const steps = path.split(/\.|\[(\d+)\]/).filter((step) => step !== '' && step !== undefined);
  let node = profile;
  let source = null;

  for (const step of steps) {
    if (isAnswer(node)) {
      source = node.source;
      node = node.value;
    }
    if (node === null || node === undefined) return null;
    node = node[step];
  }
  if (isAnswer(node)) {
    source = node.source;
    node = node.value;
  }

  if (!USABLE_SOURCES.has(source) || node === null || node === undefined) return null;
  return node;
}

/** `blockedTopics` as `key -> reason`: the questions S2 forbids answering. */
export function blockedReasons(profile) {
  return new Map((profile.blockedTopics ?? []).map((entry) => [entry.key, entry.reason]));
}

/**
 * ATS forms render only the questions a posting enabled, so a static map would
 * report fields the page never had. When the caller passes the controls it
 * found, keep only the entries whose label one of them mentions.
 */
export function narrowToControls(controls) {
  if (!Array.isArray(controls) || controls.length === 0) return () => true;
  const texts = controls.map((control) => String(control).toLowerCase());
  return (label) => texts.some((text) => text.includes(label.toLowerCase()));
}

const STANDARD_FIELDS = [
  { label: 'Full name', path: 'identity.fullName' },
  { label: 'First name', path: 'identity.firstName' },
  { label: 'Last name', path: 'identity.lastName' },
  { label: 'Email', path: 'identity.email' },
  { label: 'Phone', path: 'identity.phone' },
  { label: 'Location', path: 'identity.location' },
  { label: 'City', path: 'identity.city' },
  { label: 'LinkedIn', path: 'identity.links.linkedin' },
  { label: 'Website', path: 'identity.links.site' },
  { label: 'Resume', path: 'work.resumePath', file: true },
];

export function buildMap(profile, posting = {}) {
  const fields = {};
  const questions = [];
  const missing = new Set();
  const present = narrowToControls(posting.controls);

  for (const entry of STANDARD_FIELDS) {
    if (!present(entry.label)) continue;
    const value = readAnswer(profile, entry.path);
    if (value === null) {
      missing.add(entry.path);
      continue;
    }
    fields[entry.label] = entry.file ? { __file: value } : value;
  }

  if (posting.coverLetter && present('Cover letter')) fields['Cover letter'] = posting.coverLetter;

  questions.push({
    label: 'any control this adapter did not fill',
    key: 'unrecognisedControls',
    reason:
      'the generic adapter matches standard labels only; a human must review every unfilled control before this form is submitted',
  });

  // A generic form never auto-submits, so blocked questions stay implicit: the
  // caller cannot reach a submit step without a human reading the page.
  return { fields, questions, blocked: [], missing: [...missing] };
}

export default {
  name: 'generic',
  supportsSubmit: false,
  // The registry falls back to this adapter; it never claims a URL of its own.
  detect: () => false,
  buildMap,
};
