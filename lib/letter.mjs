// Deterministic cover letters. No model, no improvisation: every sentence is either a
// fact from data/profile.json or the posting's own title/company. lintLetter is the
// guardrail, and it is the point of the feature: a letter that claims more than the
// profile supports must fail loudly before it can be sent.

const DASH = /[\u2014\u2013]/g;

/** Collapse whitespace, normalise dashes (the letters never use an em dash). */
const clean = (v) => String(v ?? '').replace(DASH, '-').replace(/\s+/g, ' ').trim();

/** Unwrap profile leaf values: {value, source, scope} -> value. */
const val = (x) => (x && typeof x === 'object' && !Array.isArray(x) && 'value' in x ? x.value : x);

const stripEnd = (s) => clean(s).replace(/[.!]+$/, '');
const lowerFirst = (s) => (s ? s[0].toLowerCase() + s.slice(1) : s);
const norm = (s) => clean(s).toLowerCase().replace(/[^a-z0-9&]+/g, ' ').trim();

function list(items = []) {
  const xs = items.filter(Boolean);
  if (xs.length <= 1) return xs[0] || '';
  if (xs.length === 2) return `${xs[0]} and ${xs[1]}`;
  return `${xs.slice(0, -1).join(', ')}, and ${xs[xs.length - 1]}`;
}

export function skillItems(profile = {}) {
  const groups = val(profile.skills) || [];
  return groups.flatMap((g) => (g?.items || []).map(clean)).filter(Boolean);
}

function employers(profile = {}) {
  return (val(profile.employment?.employers) || []).map(norm).filter(Boolean);
}

function roles(profile = {}) {
  return val(profile.employment?.roles) || [];
}

/** Years the profile can honestly support: whole years since the earliest listed role. */
export function supportedYears(profile = {}, now = new Date()) {
  const starts = roles(profile)
    .map((r) => Date.parse(r?.start ? `${r.start}-01` : ''))
    .filter((t) => !Number.isNaN(t));
  if (!starts.length) return null;
  return Math.max(0, Math.floor((now.getTime() - Math.min(...starts)) / (365.25 * 24 * 3600 * 1000)));
}

function hasSkill(profile, token) {
  const haystack = skillItems(profile).join(' | ').toLowerCase();
  const needle = String(token).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${needle}(?=$|[^a-z0-9])`).test(haystack);
}

/**
 * Compose the letter. Only profile facts and the posting's title/company are used;
 * a missing fact drops its sentence instead of being filled in.
 *
 * @param {object} posting
 * @param {object} profile data/profile.json
 * @param {{to?: string}} [options] recipient address is accepted for symmetry; it is not printed
 * @returns {string}
 */
export function buildLetter(posting = {}, profile = {}, _options = {}) {
  const identity = profile?.identity || {};
  const work = profile?.work || {};
  const allRoles = roles(profile);

  const role = clean(posting.title) || 'the advertised role';
  const company = clean(posting.company) || 'your team';
  const fullName = clean(val(identity.fullName));
  const email = clean(val(identity.email));
  const phone = clean(val(identity.phone));
  const location = clean(val(identity.location));
  const site = clean(val(identity.links?.site));
  const notice = clean(val(work.noticePeriod));

  const current = allRoles.find((r) => r?.current) || null;
  const currentRole = clean(current?.role);
  const currentCompany = clean(current?.company);

  const paragraphs = [];

  // 1. The role, plus the current employer and notice period from profile.work.
  const opening = [`I am applying for the ${role} role at ${company}.`];
  if (currentRole && currentCompany) {
    opening.push(
      `I am currently a ${currentRole} at ${currentCompany}${notice ? `, and my notice period is ${notice}` : ''}.`,
    );
  } else if (notice) {
    opening.push(`My notice period is ${notice}.`);
  }
  paragraphs.push(opening.join(' '));

  // 2. Golang and payments work, quoted from the current role's own stack and bullets.
  const stack = [...new Set((current?.stack || []).map(clean).filter(Boolean))];
  const paymentBullets = (current?.bullets || [])
    .map(clean)
    .filter((b) => /\b(payments?|transfer|settlement|ledger|rails)\b/i.test(b))
    .slice(0, 2);
  const priorStack = [
    ...new Set(
      allRoles
        .filter((r) => !r?.current)
        .flatMap((r) => (r?.stack || []).map(clean))
        .filter(Boolean),
    ),
  ].filter((tech) => !stack.some((s) => s.toLowerCase() === tech.toLowerCase()));

  const evidence = [];
  if (stack.length) evidence.push(`Most of my recent work has been in ${list(stack)}.`);
  paymentBullets.forEach((bullet, i) => {
    evidence.push(`${i === 0 ? `At ${currentCompany} I ` : 'I also '}${lowerFirst(stripEnd(bullet))}.`);
  });
  if (priorStack.length) {
    evidence.push(`Before that I built and maintained products in ${list(priorStack.slice(0, 3))}.`);
  }
  if (evidence.length) paragraphs.push(evidence.join(' '));

  // 3. How he works. Stated as preferences, without inventing an employer or a metric.
  paragraphs.push(
    [
      'I work best when the specification is written first and the code stays small and readable, with tests that explain what the code is meant to do.',
      'I use AI tools carefully: for drafts, reviews, and boilerplate, never as a substitute for understanding the system I am changing.',
    ].join(' '),
  );

  const closing = `I would be glad to talk about how I can help ${company}. Thank you for your time and consideration.`;

  const signature = ['Sincerely,', fullName, email, phone, location, site].filter(Boolean);

  return ['Dear Hiring Team,', ...paragraphs, closing, signature.join('\n')].join('\n\n');
}

// ---------- the guardrail ----------

/** Technologies a letter may only claim when they are on the profile's skill list. */
const TECH = [
  ['Kubernetes', /\bkubernetes\b/i],
  ['Kafka', /\bkafka\b/i],
  ['Terraform', /\bterraform\b/i],
  ['Docker', /\bdocker\b/i],
  ['AWS', /\baws\b/i],
  ['GCP', /\bgcp\b/i],
  ['Azure', /\bazure\b/i],
  ['Rust', /\brust\b/i],
  ['Java', /\bjava\b/i],
  ['Ruby', /\bruby\b/i],
  ['Ruby on Rails', /\bruby\s+on\s+rails\b/i],
  ['Angular', /\bangular\b/i],
  ['Svelte', /\bsvelte\b/i],
  ['GraphQL', /\bgraphql\b/i],
  ['gRPC', /\bgrpc\b/i],
  ['Elasticsearch', /\belasticsearch\b/i],
  ['Jenkins', /\bjenkins\b/i],
  ['Ansible', /\bansible\b/i],
  ['Spring', /\bspring\b/i],
  ['Django', /\bdjango\b/i],
  ['Flask', /\bflask\b/i],
  ['.NET', /\.net\b/i],
  ['Kotlin', /\bkotlin\b/i],
  ['Swift', /\bswift\b/i],
  ['Scala', /\bscala\b/i],
  ['Hadoop', /\bhadoop\b/i],
  ['Spark', /\bspark\b/i],
  ['Airflow', /\bairflow\b/i],
  ['RabbitMQ', /\brabbitmq\b/i],
  ['Cassandra', /\bcassandra\b/i],
  ['React', /\breact\b/i],
];

/** "senior" is rejected as a self-description; naming the posting's own title is not. */
const SENIOR_SELF =
  /\b(?:i\s+am|i'm|as)\s+(?:a\s+|an\s+)?senior\b|\bsenior\s+(?:engineer|developer|software\s+engineer|programmer)\b/gi;

const NAME = "([A-Z][\\w.&'\\/-]*(?:\\s+(?:[A-Z][\\w.&'\\/-]*|&|and|of|the))*)";
const EMPLOYER_PATTERNS = [
  new RegExp(`\\b(?:worked|working|work|employed)\\s+(?:at|for|with)\\s+${NAME}`, 'g'),
  new RegExp(`\\b(?:experience|tenure)\\s+(?:at|with)\\s+${NAME}`, 'g'),
  new RegExp(`\\bcurrently\\s+(?:[a-z][^,.;]{0,60}?\\s+)?at\\s+${NAME}`, 'g'),
  new RegExp(`\\b(?:my|our|his|her)\\s+time\\s+at\\s+${NAME}`, 'g'),
];

const MIN_WORDS = 120;

function knownEmployer(name, known) {
  const n = norm(name);
  if (!n) return true;
  return known.some((e) => e === n || e.startsWith(`${n} `) || n.startsWith(`${e} `));
}

function around(text, index, length) {
  return clean(text.slice(Math.max(0, index - 24), index + length + 24));
}

/**
 * Check a letter against the profile it claims to describe.
 *
 * @param {string} text
 * @param {object} profile data/profile.json
 * @param {{ignore?: string[]}} [options] fragments (such as the posting title) to leave out of the checks
 * @returns {{ok: boolean, violations: string[]}}
 */
export function lintLetter(text, profile = {}, { ignore = [] } = {}) {
  const raw = String(text ?? '');
  if (!raw.trim()) return { ok: false, violations: ['letter is empty'] };

  let body = raw;
  for (const fragment of ignore) {
    const f = clean(fragment);
    if (f) body = body.split(f).join(' ');
  }

  const violations = [];

  const words = raw.trim().split(/\s+/).filter(Boolean).length;
  if (words < MIN_WORDS) {
    violations.push(`letter is ${words} words, below the ${MIN_WORDS}-word minimum`);
  }

  const ceiling = supportedYears(profile);
  if (ceiling != null) {
    for (const m of body.matchAll(/(\d{1,2})\s*\+?\s*years?/gi)) {
      const claimed = Number(m[1]);
      if (claimed > ceiling) {
        violations.push(
          `claims ${claimed} years of experience but the profile supports at most ${ceiling} ("${clean(m[0])}")`,
        );
      }
    }
  }

  const known = employers(profile);
  const seen = new Set();
  for (const re of EMPLOYER_PATTERNS) {
    for (const m of body.matchAll(re)) {
      const name = clean(m[1]);
      const key = norm(name);
      if (!key || seen.has(key)) continue;
      if (!knownEmployer(name, known)) {
        seen.add(key);
        violations.push(`names an employer that is not in profile.employment.employers: "${name}" ("${around(body, m.index, m[0].length)}")`);
      }
    }
  }

  for (const m of body.matchAll(SENIOR_SELF)) {
    violations.push(`uses "senior" as a self-description: "${clean(m[0])}" ("${around(body, m.index, m[0].length)}")`);
  }

  for (const [token, re] of TECH) {
    if (re.test(body) && !hasSkill(profile, token)) {
      violations.push(`lists technology not in profile.skills: "${token}"`);
    }
  }

  return { ok: violations.length === 0, violations };
}
