/**
 * Read and revise one application's cover letter (S7).
 *
 *   node cli/letter.mjs list [--json]
 *   node cli/letter.mjs --id <job id | identity key> [--revision <n>] [--json]
 *   node cli/letter.mjs --id <job id> --generate --why "researched line" [--jd <file>] [--json]
 *   node cli/letter.mjs --id <job id> --set <file> [--note "what changed"] [--json]
 *
 * A letter is addressed by its application's identity key and every revision is
 * immutable, so "revision 2 of application X" names exactly one document that a
 * submission can record as the version it sent.
 * --json prints the structured result (S5) and nothing else on stdout.
 * Exit codes: 0 ok, 2 usage, unknown application, or no such letter/revision.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { jobIdFromUrl } from '../boards/linkedin.mjs';
import { identityKey } from '../core/guard.mjs';
import { LETTERS_DIR, appendRevision, listLetters, readLetter } from '../core/letters.mjs';
import { readStore } from '../core/ledger.mjs';
import { CodedError, fail, ok } from '../core/result.mjs';
import { generateFromFiles } from '../scripts/cover.mjs';
import { parseArgs } from '../scripts/browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const STORE = join(ROOT, 'applications.json');
const USAGE = [
  'usage: node cli/letter.mjs list [--json]',
  '       node cli/letter.mjs --id <job id | identity key> [--revision <n>] [--json]',
  '       node cli/letter.mjs --id <job id> --generate --why "researched line" [--jd <file>] [--json]',
  '       node cli/letter.mjs --id <job id> --set <file> [--note "what changed"] [--json]',
  '',
  '  --revision  print one stored revision instead of the current one',
  '  --generate  run scripts/cover.mjs and store the result as a generated revision',
  '  --set       store a file you edited as a new revision and make it current',
  '  --store     ledger to resolve the job id against (default applications.json)',
  '  --letters   letter store root (default data/letters)',
  '  --career    career file the generator reads',
  '  --json      print the structured result instead of a human line',
].join('\n');

const argv = process.argv.slice(2);
const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : null;
const args = parseArgs(command ? argv.slice(1) : argv);
const jsonOut = Boolean(args.json);
// In --json mode stdout carries exactly one result object, so no human line may
// slip in alongside it.
const log = (...parts) => {
  if (!jsonOut) console.log(...parts);
};
const emit = (result) => {
  if (jsonOut) process.stdout.write(`${JSON.stringify(result)}\n`);
};
const die = (status, result, lines) => {
  if (jsonOut) emit(result);
  else for (const line of lines) console.error(line);
  process.exit(status);
};

const root = resolve(args.letters ?? LETTERS_DIR);

if (args.help) {
  console.log(USAGE);
  process.exit(0);
}
if (command && command !== 'list') {
  die(2, fail('usage', { message: `unknown command "${command}"\n${USAGE}` }), [USAGE]);
}

if (command === 'list') {
  const letters = listLetters({ root });
  emit(ok('letters-listed', letters));
  if (letters.length === 0) {
    log('no letters stored yet');
    log('generate one: node cli/letter.mjs --id <id> --generate --why "researched line"');
  } else {
    for (const letter of letters) {
      log(`${letter.company} - ${letter.role}: revision ${letter.current} of ${letter.revisions} (${letter.words} words)`);
    }
  }
  process.exit(0);
}

if (!args.id) {
  die(2, fail('usage', { message: USAGE }), [USAGE]);
}
const actions = [args.generate, args.set, args.revision !== undefined].filter(Boolean).length;
if (actions > 1) {
  const message = '--generate, --set and --revision are separate commands; run one at a time';
  die(2, fail('usage', { message }), [message, USAGE]);
}

/** Resolve `--id` to the guard's identity key: a job id or URL is looked up in
 * the ledger, and an identity key from `list` reads straight back. */
function resolveTarget(raw) {
  const id = String(raw).trim();
  const record = readStore(resolve(args.store ?? STORE)).find((candidate) => {
    const key = candidate.identityKey ?? identityKey(candidate);
    return key === id || String(candidate.linkedinId ?? '') === id || jobIdFromUrl(candidate.url ?? '') === id;
  });
  if (record) return { key: record.identityKey ?? identityKey(record), record };
  if (existsSync(join(root, id, 'index.json'))) return { key: id, record: null };
  return null;
}

const target = resolveTarget(args.id);
if (!target) {
  const message = `no ledger record or stored letter matches ${args.id}`;
  die(2, fail('record-not-found', { message }), [message]);
}
const { key, record } = target;

// A new revision is always written against an application record, which is what
// keeps the letter bound to the same identity the ledger uses.
if ((args.generate || args.set) && !record) {
  const message = `no ledger record matches ${args.id}; a new revision needs one`;
  die(2, fail('record-not-found', { message }), [message, 'run: node cli/scan.mjs --write']);
}

try {
  if (args.generate) {
    if (!args.why) {
      die(2, fail('usage', { message: `--generate needs --why "the researched company line"` }), ['missing --why', USAGE]);
    }
    const jdPath = args.jd ? resolve(args.jd) : record.jd ? resolve(ROOT, record.jd) : null;
    if (!jdPath || !existsSync(jdPath)) {
      const message = `no job description to generate from: pass --jd <file> (record has ${JSON.stringify(record.jd ?? null)})`;
      die(2, fail('usage', { message }), [message]);
    }

    const generated = generateFromFiles({
      company: record.company,
      role: record.role,
      why: args.why,
      angle: args.angle,
      jd: jdPath,
      career: args.career ?? undefined,
    });
    const revision = appendRevision(
      key,
      { text: generated.text, origin: 'generated', note: args.why },
      { root, company: record.company, role: record.role },
    );

    emit(ok('letter-generated', {
      identityKey: key,
      company: record.company,
      role: record.role,
      revision,
      words: generated.wordCount,
      warnings: generated.warnings,
      text: generated.text,
    }));
    log(`${record.company} - ${record.role}: revision ${revision} stored (${generated.wordCount} words)`);
    if (generated.warnings.length > 0) log(`gaps in the JD you cannot claim: ${generated.warnings.join(', ')}`);
    log('');
    log(generated.text.trimEnd());
    process.exit(0);
  }

  if (args.set) {
    const path = resolve(args.set);
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      const message = `cannot read ${path}: ${error.message}`;
      die(2, fail('usage', { message }), [message]);
    }
    const revision = appendRevision(
      key,
      { text, origin: 'edited', note: args.note },
      { root, company: record.company, role: record.role },
    );

    emit(ok('letter-edited', {
      identityKey: key,
      company: record.company,
      role: record.role,
      revision,
      words: text.trim().split(/\s+/).length,
      text,
    }));
    log(`${record.company} - ${record.role}: revision ${revision} stored from ${path}`);
    process.exit(0);
  }

  const letter = readLetter(key, args.revision, { root });
  emit(ok('letter-shown', {
    identityKey: key,
    company: letter.company,
    role: letter.role,
    revision: letter.revision,
    current: letter.current,
    origin: letter.origin,
    createdAt: letter.createdAt,
    words: letter.words,
    text: letter.text,
    path: letter.path,
  }));
  log(`${letter.company} - ${letter.role}: revision ${letter.revision} of ${letter.current} (${letter.words} words, ${letter.origin})`);
  log('');
  log(letter.text.trimEnd());
  process.exit(0);
} catch (error) {
  if (!(error instanceof CodedError)) throw error;
  die(2, error.toResult(), [error.message, `fix: ${error.fix}`]);
}
