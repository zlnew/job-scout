/**
 * Screening-question registry. Every question an ATS renders is matched here
 * against a profile key; only an answer with `confirmed` or `derived` provenance
 * (S2/L4) may be filled. A question with no usable answer is reported, never
 * guessed, and an EEO or salary-history question is reported even when its key
 * appears in `blockedTopics`.
 *
 * Adapters call `resolveQuestion`; `describe` is the human-facing gap list that
 * `doctor`/`prepare` will print.
 */

const USABLE_SOURCES = new Set(['confirmed', 'derived']);

const isAnswer = (node) => Boolean(node) && typeof node === 'object' && !Array.isArray(node) && Object.hasOwn(node, 'value');

/**
 * Ordered: the first pattern that matches a label owns it, so a specific
 * question (salary history) must precede any broader one (current salary).
 * `key` is a dot-path into `data/profile.json` or a `blockedTopics` key.
 */
export const SCREENING = [
  { pattern: /\bnotice\s*period\b/i, key: 'work.noticePeriod', label: 'Notice Period' },
  {
    pattern: /\b(work|right\s+to\s+work)\s+eligibility\b|\bauthori[sz]ed\s+to\s+work\b|\bwork\s+authori[sz]ation\b|\blegally\s+(able|authori[sz]ed)\s+to\s+work\b/i,
    key: 'work.authorizedIn',
    label: 'Work Eligibility',
  },
  { pattern: /\b(nationality|citizenship)\b/i, key: 'work.citizenship', label: 'Nationality' },
  {
    pattern: /\b(total\s+(working\s+)?experience|years?\s+of\s+experience|work\s+experience)\b/i,
    key: 'titles.yearsExperience',
    label: 'Total Working Experience',
  },
  { pattern: /\b(university|school|college|institution)\b/i, key: 'education[0].school', label: 'University' },
  { pattern: /\b(degree|education\s+level|qualification)\b/i, key: 'education[0].degree', label: 'Education Degree' },
  { pattern: /\bgpa\b|\bgrade\s+point\b/i, key: 'education[0].gpa', label: 'GPA' },
  {
    pattern: /\b(year\s+of\s+graduation|graduation\s+(year|date)|graduated\s+(in|on|year))\b/i,
    key: 'education[0].end',
    label: 'Year of Graduation',
  },
  { pattern: /\brelocat/i, key: 'work.relocate', label: 'Willing to Relocate' },
  {
    pattern: /\b(start\s*(date|availability)|available\s+to\s+start|earliest\s+start)\b/i,
    key: 'work.startAvailability',
    label: 'Start Availability',
  },

  // Salary first: the numeric expectations and history are blocked outright.
  {
    pattern: /\bsalary\s*history\b|\bprevious\s*salary\b|\bcompensation\s*history\b/i,
    key: 'answers.salaryHistory',
    label: 'Salary History',
  },
  { pattern: /\bcurrent\b.*\bsalary\b/i, key: 'answers.currentSalary', label: 'Current monthly salary' },
  {
    pattern: /\bexpected\b.*\bsalary\b|\bsalary\s*expectation\b/i,
    key: 'answers.expectedSalaryNumeric',
    label: 'Expected monthly salary',
  },

  // Personal and EEO data: no answer exists and none may be inferred.
  { pattern: /\bbirth\s*(date|day)\b/i, key: 'answers.birthDate', label: 'Birth Date' },
  { pattern: /\bbirth\s*place\b|\bplace\s*of\s*birth\b/i, key: 'answers.birthPlace', label: 'Birth Place' },
  { pattern: /\bage\b/i, key: 'answers.age', label: 'Age' },
  { pattern: /\bgender\b|\bsex\b/i, key: 'answers.gender', label: 'Gender' },
  { pattern: /\brace\b/i, key: 'answers.race', label: 'Race' },
  { pattern: /\bethnicity\b/i, key: 'answers.ethnicity', label: 'Ethnicity' },
  { pattern: /\breligion\b/i, key: 'answers.religion', label: 'Religion' },
  { pattern: /\bmarital\s*status\b/i, key: 'answers.maritalStatus', label: 'Marital Status' },
  { pattern: /\bdisabilit(y|ies)\b/i, key: 'answers.disabilityStatus', label: 'Disability Status' },
  { pattern: /\bveteran\b/i, key: 'answers.veteranStatus', label: 'Veteran Status' },
  { pattern: /\b(photo|photograph|headshot|picture)\b/i, key: 'answers.photo', label: 'Photo' },
  { pattern: /\b(ktp|npwp|national\s*id|identity\s*card)\b/i, key: 'answers.nationalId', label: 'National ID' },
  { pattern: /\bbank\s*(account|details)?\b|\baccount\s*number\b/i, key: 'answers.bankAccount', label: 'Bank Account' },
  { pattern: /\b(references?|referees?)\b/i, key: 'answers.references', label: 'References' },
  { pattern: /\btime\s*zone\b|\boverlap\b/i, key: 'answers.timezoneOverlap', label: 'Timezone Overlap' },
  { pattern: /\b(willing\s+to\s+travel|travel\s+requirement)\b/i, key: 'answers.willingToTravel', label: 'Willing to Travel' },
  { pattern: /\bcriminal\b|\bconviction\b/i, key: 'answers.criminalRecord', label: 'Criminal Record' },
  { pattern: /\bsecurity\s+clearance\b|\bclearance\b/i, key: 'answers.securityClearance', label: 'Security Clearance' },
  { pattern: /family\s+ties|relatives?\s+working/i, key: 'answers.familyTies', label: 'Family ties to employees' },
  { pattern: /data\s*processing|privacy\s+(consent|notice|policy)|consent\s+to\s+process/i, key: 'answers.dataProcessingConsent', label: 'Data processing consent' },
  { pattern: /\bmajor\b|field\s+of\s+study|\bdiscipline\b/i, key: 'answers.majorOfStudy', label: 'Major of Study' },
  { pattern: /job\s+vacancy\s+to\s+apply|position\s+(applied|you\s+are\s+applying)|which\s+role/i, key: 'answers.jobVacancy', label: 'Job vacancy to apply' },
];

/**
 * Read a profile leaf the same way `readAnswer` does, but keep the provenance
 * so `resolveQuestion` can tell "no answer" from "answer with unusable source".
 * Unwrapping happens on the way down; the last wrapper seen owns the source.
 */
function readLeaf(profile, path) {
  const steps = path.split(/\.|\[(\d+)\]/).filter((step) => step !== '' && step !== undefined);
  let node = profile;
  let source = null;

  for (const step of steps) {
    if (isAnswer(node)) {
      source = node.source;
      node = node.value;
    }
    if (node === null || node === undefined) return { exists: false };
    node = node[step];
  }
  if (isAnswer(node)) {
    source = node.source;
    node = node.value;
  }

  if (node === null || node === undefined) return { exists: false };
  return { exists: true, value: node, source };
}

/**
 * Resolve one form label to a fillable answer, a blocker, or an unknown.
 * `blocked` is the safe outcome for anything the registry knows but cannot
 * source; only `answer` may put a value on a form.
 */
export function resolveQuestion(label, profile) {
  const text = String(label ?? '').trim();
  const entry = SCREENING.find((rule) => rule.pattern.test(text));
  if (!entry) return { status: 'unknown', reason: `no screening rule matches "${text}"` };

  const blockedFor = new Map((profile?.blockedTopics ?? []).map((item) => [item.key, item.reason]));
  if (blockedFor.has(entry.key)) {
    return { status: 'blocked', key: entry.key, reason: blockedFor.get(entry.key) };
  }

  const leaf = readLeaf(profile, entry.key);
  if (!leaf.exists) {
    return { status: 'blocked', key: entry.key, reason: `no answer in data/profile.json at ${entry.key}` };
  }
  if (!USABLE_SOURCES.has(leaf.source)) {
    return {
      status: 'blocked',
      key: entry.key,
      reason: `source ${JSON.stringify(leaf.source)} at ${entry.key} is not confirmed or derived`,
    };
  }

  return { status: 'answer', key: entry.key, value: leaf.value };
}

/**
 * The questions a human still has to answer: every registry entry that resolves
 * to blocked or unknown, deduplicated by key. Resolved questions are omitted so
 * the list shrinks as `data/profile.json` gains provenance.
 */
export function describe(profile) {
  const seen = new Set();
  const gaps = [];

  for (const entry of SCREENING) {
    if (seen.has(entry.key)) continue;
    seen.add(entry.key);

    const result = resolveQuestion(entry.label, profile);
    if (result.status === 'answer') continue;
    gaps.push({ label: entry.label, key: entry.key, status: result.status, reason: result.reason });
  }

  return gaps;
}
