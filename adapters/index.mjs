/**
 * Adapter registry. Adapters are the only extension point (S3): a new ATS is one
 * module plus one saved snapshot, and nothing in core learns an ATS name.
 *
 * Contract every adapter must satisfy:
 *   name          string   stable id, used in reports and the ledger
 *   supportsSubmit boolean whether the adapter may ever auto-submit (S1)
 *   detect(url)   boolean  claims one URL; the registry picks the first claim
 *   buildMap(profile, posting) -> { fields, questions, blocked, missing }
 *   prepare(page) / submit(page)  optional browser steps
 */
import generic from './generic.mjs';
import workable from './workable.mjs';

/** Ordered: most specific adapter first, the label-based fallback last. */
export const ADAPTERS = [workable, generic];

const REQUIRED = { name: 'string', supportsSubmit: 'boolean', detect: 'function', buildMap: 'function' };
const OPTIONAL = ['prepare', 'submit'];

/**
 * Throw naming every member the adapter lacks or mistypes. Tests and `doctor`
 * share it so a half-written adapter fails at the boundary, not mid-application.
 */
export function assertAdapterContract(adapter) {
  const problems = [];
  const label = adapter?.name ? `adapter "${adapter.name}"` : 'adapter';

  for (const [member, type] of Object.entries(REQUIRED)) {
    if (!(member in (adapter ?? {}))) problems.push(`${member} is missing`);
    else if (typeof adapter[member] !== type) problems.push(`${member} must be a ${type}, got ${typeof adapter[member]}`);
  }
  for (const member of OPTIONAL) {
    if (member in (adapter ?? {}) && typeof adapter[member] !== 'function') {
      problems.push(`${member} is optional but must be a function, got ${typeof adapter[member]}`);
    }
  }

  if (problems.length > 0) throw new Error(`${label} violates the adapter contract: ${problems.join(', ')}`);
  return adapter;
}

/**
 * The adapter that claims this URL, else the generic fallback. A detector that
 * throws on a malformed URL simply does not claim it — discovery feeds this
 * registry URLs it scraped from pages.
 */
export function findAdapter(url) {
  for (const adapter of ADAPTERS) {
    let claimed = false;
    try {
      claimed = adapter.detect(url) === true;
    } catch {
      claimed = false;
    }
    if (claimed) return adapter;
  }
  return generic;
}
