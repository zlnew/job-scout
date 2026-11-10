/**
 * Reusable cover-letter generator: real resume bullets + real skill overlap + one researched line.
 *
 *   node scripts/cover.mjs --company "Kredivo Group" --role "Backend Engineer" \
 *     --jd postings/4440204415.txt --angle backend \
 *     --why "Kredivo lends to underbanked borrowers at real scale."
 *
 * Deterministic on purpose: no invented metrics, no claimed technology, and it refuses to write
 * a letter without the researched company line. Review the output before sending.
 *
 * The letter is also stored as a revision of the matching application's letter
 * (S7), so the app can show and edit it. `--out` alone means "just this file",
 * which is what a draft run wants; name --letters to record a draft too.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { identityKey } from '../core/guard.mjs';
import { appendRevision, LETTERS_DIR } from '../core/letters.mjs';
import { readStore } from '../core/ledger.mjs';
import { parseArgs } from './browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const STORE = join(ROOT, 'applications.json');
export const DEFAULT_CAREER = join(ROOT, '..', 'repo/neo-portfolio/content/career.json');

const ANGLES = {
  backend: 'Three years of backend work, most of it on systems where correctness matters more than velocity.',
  platform: 'I build and operate the platform layer: deployments, telemetry, and the tooling around them.',
  product: 'I work end to end — backend, the interface, and the person who has to use it.',
  fullstack: 'I work end to end — backend, the interface, and the person who has to use it.',
};

// Technology the JD may ask for that should never be claimed unless it is on the resume.
const TECH_VOCAB = [
  'kubernetes', 'k8s', 'kafka', 'rabbitmq', 'nats', 'grpc', 'terraform', 'helm', 'ansible',
  'aws', 'gcp', 'azure', 'jenkins', 'github actions', 'prometheus', 'grafana', 'elasticsearch',
  'spark', 'airflow', 'graphql', 'java', 'kotlin', 'scala', 'rust', 'node', 'ruby', 'rails',
  'c#', '.net', 'flutter', 'react native', 'next.js', 'nuxt', 'svelte',
];

const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'you', 'your', 'our', 'are', 'will', 'that', 'this', 'have', 'has', 'from', 'not', 'but', 'all', 'any', 'can', 'who', 'their', 'them', 'they', 'its', 'about', 'work', 'working', 'role', 'team', 'teams', 'including', 'required', 'nice', 'must', 'need']);

// Generic infrastructure that is not the "stack this role runs on".
const SKILL_NOISE = new Set(['git', 'linux', 'nginx']);

const tokens = (text) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word))
    // Crude plural folding so "payments" in a JD matches "payment" in a bullet.
    .map((word) => (word.length > 3 ? word.replace(/s$/, '') : word));

const decapitalise = (sentence) => `${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}`;

const shortCompany = (name) => {
  const parenthetical = name.match(/\(([^)]+)\)/);
  if (parenthetical) return parenthetical[1].trim();
  return name.replace(/^PT\s+/i, '').split(/\s+/).slice(0, 2).join(' ');
};

/** Resume technology names, without parentheticals ("Go (Golang)" → "Go"). */
const skillNames = (career) =>
  (career.skills ?? []).flatMap((group) => group.items ?? []).map((item) => item.replace(/\s*\(.*?\)\s*$/, '').trim());

export function generateLetter({ career, jd, company, role, why, angle = 'backend' }) {
  const jdLower = jd.toLowerCase();
  const jdTokens = new Set(tokens(jd));

  // Rank real bullets by overlap with the JD. The current role always leads: recent, relevant
  // work beats a bigger keyword hit in a past job.
  const ranked = (career.roles ?? []).flatMap((roleEntry, index) =>
    (roleEntry.bullets ?? []).map((bullet) => {
      const overlap = tokens(bullet).filter((token) => jdTokens.has(token)).length;
      return { roleEntry, bullet, weight: overlap * 10 + (roleEntry.current ? 1000 : 4 - index) };
    }),
  ).sort((a, b) => b.weight - a.weight);

  const picked = ranked.slice(0, 2);

  const evidenceParts = picked.map((entry, index) => {
    const name = shortCompany(entry.roleEntry.company ?? 'there');
    if (index === 0) return `At ${name} I ${decapitalise(entry.bullet)}`;
    const sameRole = entry.roleEntry === picked[0].roleEntry;
    return sameRole ? `I also ${decapitalise(entry.bullet)}` : `Earlier, at ${name} I ${decapitalise(entry.bullet)}`;
  });

  const overlapSkills = skillNames(career)
    .filter((skill) => !SKILL_NOISE.has(skill.toLowerCase()))
    .filter((skill) => new RegExp(`\\b${skill.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(jd))
    .slice(0, 4);

  const warnings = TECH_VOCAB.filter(
    (tech) => jdLower.includes(tech) && !skillNames(career).some((skill) => skill.toLowerCase() === tech),
  );

  const paragraphs = [
    `Dear ${company} team,\n\nI'm applying for the ${role} role at ${company}. ${ANGLES[angle] ?? ANGLES.backend}`,
    evidenceParts.join(' '),
    [
      overlapSkills.length === 1
        ? `I work with ${overlapSkills[0]}, which is the stack this role runs on.`
        : overlapSkills.length > 1
          ? `I work with ${overlapSkills.slice(0, -1).join(', ')} and ${overlapSkills.at(-1)}, which is the stack this role runs on.`
          : '',
      why,
      `I'm based in ${career.identity?.location ?? 'Bekasi, Indonesia'} and can start after one month's notice.`,
    ]
      .filter(Boolean)
      .join(' '),
  ];

  const text = `${paragraphs.join('\n\n')}\n`;
  return { text, wordCount: text.trim().split(/\s+/).length, warnings, evidence: picked.map((entry) => entry.bullet) };
}

/** Read the career and JD files and generate the letter: the one code path both
 * this script and cli/letter.mjs use, so what is printed is what is stored. */
export function generateFromFiles({ company, role, why, angle, jd, career = DEFAULT_CAREER }) {
  const careerData = JSON.parse(readFileSync(resolve(career), 'utf8'));
  return generateLetter({ career: careerData, jd: readFileSync(resolve(jd), 'utf8'), company, role, why, angle });
}

const slug = (value) => String(value).toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replaceAll(/^-|-$/g, '');

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  const missing = ['company', 'role', 'jd', 'why'].filter((key) => !args[key]);
  if (missing.length > 0) {
    console.error(`missing --${missing.join(', --')}`);
    console.error('usage: node scripts/cover.mjs --company X --role Y --jd postings/<id>.txt --why "researched line" [--angle backend|platform|product|fullstack] [--out file.md] [--store applications.json] [--letters <dir>]');
    process.exit(1);
  }

  const result = generateFromFiles({ company: args.company, role: args.role, why: args.why, angle: args.angle, jd: args.jd, career: args.career });
  const out = resolve(args.out ?? join(ROOT, 'cover-letters', `${slug(args.company)}-${slug(args.role)}.md`));

  const header = `<!-- generated by scripts/cover.mjs — review before sending\n     claimed from resume: ${result.evidence.length} bullet(s)\n     JD-only technology (do NOT claim): ${result.warnings.join(', ') || 'none'}\n     ${result.wordCount} words -->\n\n`;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${header}${result.text}`);

  console.log(`${result.wordCount} words → ${out}`);
  if (result.warnings.length > 0) console.log(`gaps in the JD you cannot claim: ${result.warnings.join(', ')}`);

  if (args.letters || !args.out) {
    const record = readStore(resolve(args.store ?? STORE)).find(
      (candidate) => slug(candidate.company) === slug(args.company) && slug(candidate.role) === slug(args.role),
    );
    if (!record) {
      console.log('not recorded: no ledger record for this company and role (run: node cli/scan.mjs --write)');
    } else {
      const root = resolve(args.letters ?? LETTERS_DIR);
      const key = record.identityKey ?? identityKey(record);
      const revision = appendRevision(
        key,
        { text: result.text, origin: 'generated', note: args.why },
        { root, company: record.company, role: record.role },
      );
      console.log(`revision ${revision} → ${join(root, key)}/v${revision}.md`);
    }
  }
}
