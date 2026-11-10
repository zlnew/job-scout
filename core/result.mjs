/**
 * One result shape for every operation (S5). A caller branches on `code` and
 * renders `message` + `fix`; nothing downstream parses prose.
 *
 * `fix` must name the exact action or command that clears the problem, because
 * the UI shows it as the failure's only call to action (S2).
 */
export const CODES = Object.freeze({
  // Success codes name what now works and the next action, so the UI needs no
  // separate copy table.
  prepared: {
    message: 'the application is prepared',
    fix: 'run: node cli/apply.mjs --id <id>',
  },
  submitted: {
    message: 'the application was submitted',
    fix: 'record the outcome in Postings',
  },
  'dry-run-clean': {
    message: 'the form filled and the guard passed; nothing was submitted',
    fix: 'run again without --dry-run to submit',
  },
  scanned: {
    message: 'the sweep finished',
    fix: 'open Postings to score the candidates',
  },
  healthy: {
    message: 'every check passed',
    fix: 'no action needed',
  },
  'letters-listed': {
    message: 'the letter list is ready',
    fix: 'open an application to read or edit its letter',
  },
  'letter-shown': {
    message: 'the letter revision is shown',
    fix: 'run with --generate or --set <file> to add a revision',
  },
  'letter-generated': {
    message: 'a new generated revision was stored',
    fix: 'review it, then apply with that revision',
  },
  'letter-edited': {
    message: 'your edited revision was stored',
    fix: 'review it, then apply with that revision',
  },

  // Refusals and failures.
  usage: {
    message: 'the command line is missing required arguments',
    fix: 'run the command with --help to see the accepted arguments',
  },
  'session-expired': {
    message: 'the LinkedIn session expired or was rejected',
    fix: 'run: npm run login -- linkedin',
  },
  'record-not-found': {
    message: 'no ledger record matches that job id',
    fix: 'run: node cli/scan.mjs --write, or open Postings to add it',
  },
  'illegal-transition': {
    message: 'that status change is not allowed by the ledger',
    fix: 'open the application timeline in Postings to see the legal next status',
  },
  'not-prepared': {
    message: 'the record is not prepared for submission',
    fix: 'run: node cli/prepare.mjs --id <id> --write',
  },
  'blocked-question': {
    message: 'a question answered by a blocked topic stops the submission',
    fix: 'answer or confirm the blocked topic in Connections & rules, then run prepare again',
  },
  'required-empty': {
    message: 'a required form control is still empty',
    fix: 'fill the named control on the application form, then run apply again',
  },
  'required-unfilled': {
    message: 'the field map could not fill a required field',
    fix: 'add the missing answer to data/profile.json with provenance, then run prepare again',
  },
  'optional-unmatched': {
    message: 'an optional control was not matched',
    fix: 'review the named control on the form; it does not block submission',
  },
  'easy-apply': {
    message: 'LinkedIn Easy Apply is never automated',
    fix: 'open the posting yourself and apply by hand',
  },
  'duplicate-application': {
    message: 'this posting is already submitted',
    fix: 'open the application in Postings to see its timeline',
  },
  'provenance-invalid': {
    message: 'an answer has no confirmed or derived provenance',
    fix: 'set source to "confirmed" or "derived" with an explicit scope in data/profile.json',
  },
  'adapter-unverified': {
    message: 'this form has no verified submit path',
    fix: 'fill and submit the form by hand, then record the outcome in Postings',
  },
  'submit-unconfirmed': {
    message: 'the submit control was clicked but no confirmation appeared',
    fix: 'check the posting tab; if it went through, set the status in Postings',
  },
  'source-failed': {
    message: 'a job source did not respond',
    fix: 'run node cli/scan.mjs again; if it keeps failing, re-auth the source in Connections & rules',
  },
  'store-corrupt': {
    message: 'a data file is not valid JSON',
    fix: 'restore the newest file from data/backups, then run node cli/doctor.mjs',
  },
  'store-schema': {
    message: 'the data file schema is not supported by this build',
    fix: 'run node cli/doctor.mjs and restore the matching schema from data/backups',
  },
  'letter-not-found': {
    message: 'no letter is stored for that application',
    fix: 'run: node cli/letter.mjs --id <id> --generate --why "…"',
  },
  'letter-revision-not-found': {
    message: 'that letter revision does not exist',
    fix: 'open the application letter in Postings to see its revisions',
  },
  'letter-empty': {
    message: 'a letter revision needs text',
    fix: 'pass a file with the letter text: --set <file>',
  },
  'letter-invalid': {
    message: 'the letter store refused that revision',
    fix: 'use origin "generated" or "edited" and a real application identity',
  },
});

function codeOf(code) {
  const entry = CODES[code];
  if (!entry) throw new Error(`unknown result code ${JSON.stringify(code)}`);
  return entry;
}

/** A success result; `value` is the caller's payload and `meta` extra keys. */
export function ok(code, value, meta = {}) {
  const entry = codeOf(code);
  return { ok: true, code, message: entry.message, fix: entry.fix, ...(value !== undefined ? { value } : {}), ...meta };
}

/** A failure result. Callers override the message when they can name the field. */
export function fail(code, { message, fix, detail } = {}) {
  return new CodedError(code, { message, fix, detail }).toResult();
}

/** One guard reason: the same code/message/fix shape the UI renders. */
export function reason(code, { message, fix, field } = {}) {
  const entry = codeOf(code);
  return { code, message: message ?? entry.message, fix: fix ?? entry.fix, ...(field !== undefined ? { field } : {}) };
}

/**
 * A refusal whose first reason is the headline. Every reason stays available so
 * a screen can show all of them, not just the one that happened first.
 */
export function refusal(reasons, warnings = [], value) {
  const first = reasons[0];
  return {
    ok: false,
    code: first?.code,
    message: first?.message ?? 'refused',
    fix: first?.fix ?? 'review the reasons',
    ...(value !== undefined ? { value } : {}),
    reasons,
    warnings,
  };
}

/**
 * An Error that carries the coded shape. Ledger rules throw it so a CLI can
 * print the same message + fix a screen would.
 */
export class CodedError extends Error {
  constructor(code, { message, fix, detail } = {}) {
    const entry = codeOf(code);
    super(message ?? entry.message);
    this.name = 'CodedError';
    this.code = code;
    this.fix = fix ?? entry.fix;
    if (detail !== undefined) this.detail = detail;
  }

  toResult() {
    return {
      ok: false,
      code: this.code,
      message: this.message,
      fix: this.fix,
      ...(this.detail !== undefined ? { detail: this.detail } : {}),
    };
  }
}
