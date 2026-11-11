// Deterministic scoring rubric for job-apply v2.
//
// Source of truth for the *policy* is data/answers.md (Maul-confirmed answers).
// Source of truth for the *facts* is data/profile.json.
// This module is pure: (posting, profile) -> verdict. No I/O, so it is testable.

export const WEIGHTS = {
  level: 20,
  stack: 25,
  domain: 20,
  geo: 15,
  recency: 10,
  comp: 10,
};

const TITLE_OK = /\b(backend|back-end|back end|platform|product engineer|full[- ]?stack|software engineer)\b/i;
const TITLE_REJECT =
  /\b(mobile|android|ios|flutter|react native|qa|qc|tester|test engineer|devops|sre|site reliability|data engineer|data scientist|machine learning|\bml\b|designer|sales|marketing|intern|internship|magang|manager|head of|principal|architect)\b/i;

const STACK = [
  [/\bgolang\b|\bgo\b/i, 'golang', 10],
  [/python/i, 'python', 8],
  [/typescript|javascript|\bnode\.?js\b/i, 'js/ts/node', 8],
  [/\bvue\b/i, 'vue', 7],
  [/laravel|\bphp\b/i, 'laravel/php', 6],
  [/postgres|mysql|mongodb|redis/i, 'databases', 5],
  [/rest|openapi|grpc|websocket/i, 'api', 5],
];

const DOMAIN = [
  [/\b(payment|payments|fintech|financial|banking|bank|lending|loan|wallet|settlement|remittance|insurance)\b/i, 'fintech', 20],
  [/\b(saas|b2b|platform|marketplace)\b/i, 'product', 11],
];

const JABODETABEK = /jakarta|bekasi|bogor|depok|tangerang|bintaro|jabodetabek|serpong|cikarang/i;
const INDONESIA = /indonesia|jakarta|bekasi|bandung|surabaya|yogyakarta|bali|denpasar|medan|semarang|tangerang|depok|bogor/i;
const FOREIGN = /\b(singapore|malaysia|vietnam|thailand|philippines|india|australia|united states|usa|uk|europe|dubai|japan|korea)\b/i;

/** "5-7 years", "minimum 5 years", "3+ years of experience" -> 5, 5, 3 */
export function parseMinYears(text = '') {
  const patterns = [
    /(\d+)\s*(?:-|–|to)\s*(\d+)\s*\+?\s*years?/i,
    /(?:minimum|min\.?|at least)\s*(?:of\s*)?(\d+)\s*\+?\s*years?/i,
    /(\d+)\s*\+\s*years?/i,
    /(\d+)\s*years?\s*(?:of\s*)?(?:experience|exp\b)/i,
  ];
  const found = [];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) found.push(Number(m[1]));
  }
  return found.length ? Math.min(...found) : null;
}

/** 12000000 | "Rp 12.000.000" | "IDR 12,000,000" | "Rp 300.000 a day" -> monthly IDR */
export function parseSalaryIdr(salaryText = '') {
  if (!salaryText) return null;
  const perDay = /a day|per day|\/day|daily/i.test(salaryText);
  const perYear = /a year|per year|annually|\/year/i.test(salaryText);
  const nums = [...salaryText.matchAll(/(\d[\d.,]{2,})/g)]
    .map((m) => Number(m[1].replace(/[.,]/g, '')))
    .filter((n) => n > 1000);
  if (!nums.length) return null;
  const base = Math.min(...nums);
  if (perDay) return Math.round(base * 22);
  if (perYear) return Math.round(base / 12);
  return base;
}

function daysSince(dateStr) {
  if (!dateStr) return null;
  const t = Date.parse(dateStr);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

/**
 * @param {object} job   posting record (see lib/store.mjs shape)
 * @param {object} profile data/profile.json
 * @returns {{score:number, decision:'apply'|'review'|'skip'|'reject', reasons:string[], flags:string[]}}
 */
export function scoreJob(job, profile = {}) {
  const reasons = [];
  const flags = [];
  const hardReject = (why) => {
    flags.push(why);
    return { score: 0, decision: 'reject', reasons: [...reasons, why], flags };
  };

  const title = job.title || '';
  const blob = [job.title, job.description, job.location, job.company].filter(Boolean).join(' \n ');

  // Title filter is hard (answers.md: "disqualify, no scoring").
  if (TITLE_REJECT.test(title)) return hardReject(`title not in accepted tracks: "${title}"`);
  if (!TITLE_OK.test(title)) return hardReject(`title does not match accepted track list: "${title}"`);

  // Years requirement: 5+ scores zero per confirmed policy.
  const minYears = parseMinYears(blob);
  if (minYears !== null && minYears >= 5) {
    return hardReject(`requires ${minYears}+ years; policy refuses 5+ regardless of fit`);
  }
  if (minYears !== null) reasons.push(`asks ${minYears}+ years (within 3-5 band)`);

  // Geography: relocation is a confirmed no.
  const geoText = [job.location, job.remote ? 'remote' : '', job.description].filter(Boolean).join(' ');
  const isRemote = job.remote === true || /\bfully remote|remote[- ]first|100% remote\b/i.test(geoText);
  const local = JABODETABEK.test(geoText) || /\bindonesia\b/i.test(geoText);
  const foreign = FOREIGN.test(geoText) && !INDONESIA.test(geoText);
  if (foreign && !isRemote) return hardReject('foreign employer without full remote; relocation not allowed');
  if (!local && !isRemote) return hardReject('no explicit Indonesia or remote signal');

  // Compensation: floor is a confirmed number.
  const floor = profile?.compensation?.floor?.value ?? 0;
  const monthly = job.salary_idr ?? parseSalaryIdr(job.salary || '');
  if (monthly !== null && floor && monthly < floor) {
    return hardReject(`listed ${Math.round(monthly / 1e6)}M is below the ${Math.round(floor / 1e6)}M floor`);
  }

  // --- weighted components ---
  let level;
  if (minYears === null) {
    level = 12;
    flags.push('years requirement not stated');
  } else if (minYears <= 3) level = WEIGHTS.level;
  else level = 15;

  const seniorTitle = /\b(senior|sr\.?|lead|staff|principal)\b/i.test(title);
  if (seniorTitle) {
    level -= 6;
    flags.push('senior-title: apply as mid, do not claim the level');
  }

  const stackHits = [];
  let stack = 0;
  for (const [re, label, pts] of STACK) {
    if (re.test(blob)) {
      stackHits.push(label);
      stack += pts;
    }
  }
  stack = Math.min(stack, WEIGHTS.stack);
  if (stackHits.length) reasons.push(`stack match: ${stackHits.join(', ')}`);
  if (stack < 10) flags.push('weak stack signal in posting text');

  const domainHits = [];
  let domain = 4;
  for (const [re, label, pts] of DOMAIN) {
    if (re.test(blob)) {
      domainHits.push(label);
      domain = Math.max(domain, pts);
    }
  }
  if (domainHits.length) reasons.push(`domain: ${domainHits.join(', ')}`);

  let geo;
  if (isRemote) {
    geo = WEIGHTS.geo;
    reasons.push('remote');
  } else if (/bekasi/i.test(geoText)) {
    geo = WEIGHTS.geo;
    reasons.push('Bekasi — home city');
  } else if (JABODETABEK.test(geoText)) {
    geo = 13;
    reasons.push('Jabodetabek on-site/hybrid');
  } else {
    geo = 5;
    reasons.push('Indonesia but outside Jabodetabek');
  }

  const age = daysSince(job.published);
  let recency;
  if (age === null) {
    recency = 5;
    flags.push('posting date unknown');
  } else if (age <= 14) recency = WEIGHTS.recency;
  else if (age <= 30) recency = 7;
  else if (age <= 45) recency = 5;
  else if (age <= 90) recency = 2;
  else recency = 0;
  if (age !== null && age > 45) flags.push(`stale: posted ${age} days ago`);

  const comp = monthly === null ? 5 : WEIGHTS.comp;
  if (monthly === null) flags.push('salary not disclosed');
  else reasons.push(`listed ~${(monthly / 1e6).toFixed(1)}M/month`);

  const score = Math.max(0, Math.min(100, Math.round(level + stack + domain + geo + recency + comp)));
  const decision = score >= 70 ? 'apply' : score >= 50 ? 'review' : 'skip';
  return { score, decision, reasons, flags, components: { level, stack, domain, geo, recency, comp } };
}
