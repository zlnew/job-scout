/**
 * LinkedIn as a board, not a script: guest search, JD fetch, and apply-target
 * resolution. Every network call takes an injectable `fetchImpl`, so tests can
 * replay saved HTML without touching LinkedIn.
 *
 * The module never imports playwright-core; `resolveApplyTarget` only uses the
 * page object the caller already opened through scripts/browser.mjs.
 */

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0 Safari/537.36';

export const DEFAULT_QUERIES = [
  'backend engineer golang',
  'backend engineer fintech',
  'platform engineer',
  'product engineer golang',
  'software engineer golang',
  'api integration engineer',
];

const ALLOW = /(backend|back-end|platform|product engineer|full.?stack|software engineer|golang|go developer|api|integration)/i;
const DENY = /(devops|sre$|site reliability|data engineer|data scientist|android|ios|mobile|flutter|qa\b|quality assurance|manager|head of|principal|director|intern|magang)/i;
const SEARCH_DELAY_MS = 1200;
// LinkedIn renders opaque class names, so affordances are matched by their text only.
const APPLY_LABEL = /\b(apply|easy apply|apply now|apply on company|lamar)\b/i;
const EASY_APPLY_LABEL = /easy\s*apply/i;
const CLICK_TIMEOUT = 20000;

export class SessionExpired extends Error {}

const strip = (s) => s.replaceAll(/<[^>]+>/g, ' ').replaceAll(/\s+/g, ' ').trim();

async function get(url, fetchImpl) {
  const res = await fetchImpl(url, { headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

export function parseCards(html) {
  const cards = [];
  const chunks = html.split('data-entity-urn="urn:li:jobPosting:').slice(1);
  for (const chunk of chunks) {
    const id = chunk.match(/^(\d+)/)?.[1];
    if (!id) continue;
    const title = strip(chunk.match(/base-search-card__title">([\s\S]*?)<\/h3>/)?.[1] ?? '');
    const company = strip(chunk.match(/base-search-card__subtitle[\s\S]*?>([^<]*)<\/a>/)?.[1] ?? '');
    const loc = strip(chunk.match(/job-search-card__location">([\s\S]*?)<\/span>/)?.[1] ?? '');
    const posted = chunk.match(/datetime="([\d-]+)"/)?.[1] ?? '';
    cards.push({ id, title, company, location: loc, posted, url: `https://www.linkedin.com/jobs/view/${id}` });
  }
  return cards;
}

export const rankTitle = (title) => {
  if (/backend|back-end|golang|go developer/i.test(title)) return 3;
  if (/platform/i.test(title)) return 2;
  if (/product engineer|api|integration/i.test(title)) return 2;
  if (/full.?stack/i.test(title)) return 1;
  return 1; // bare "software engineer" — accepted when the JD is backend
};

/** Guest search across the default queries, filtered and ranked like the CLI. */
export async function searchJobs({
  queries = DEFAULT_QUERIES,
  location = 'Indonesia',
  pages = 1,
  fetchImpl = globalThis.fetch,
  delayMs = SEARCH_DELAY_MS,
} = {}) {
  const seen = new Map();
  for (const query of queries) {
    for (let page = 0; page < pages; page += 1) {
      const url = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(query)}&location=${encodeURIComponent(location)}&start=${page * 25}`;
      let html = '';
      try {
        html = await get(url, fetchImpl);
      } catch (error) {
        console.error(`skip ${query} p${page}: ${error.message}`);
        continue;
      }
      for (const card of parseCards(html)) {
        if (!card.title || seen.has(card.id)) continue;
        if (!ALLOW.test(card.title) || DENY.test(card.title)) continue;
        seen.set(card.id, { ...card, query });
      }
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  return [...seen.values()].sort((a, b) => rankTitle(b.title) - rankTitle(a.title) || b.posted.localeCompare(a.posted));
}

/** The guest JD endpoint returns an HTML fragment, not a JSON payload. */
export async function fetchJobDescription(id, { fetchImpl = globalThis.fetch } = {}) {
  const html = await get(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`, fetchImpl);
  const body = html.match(/class="show-more-less-html__markup[^"]*">([\s\S]*?)<\/div>/)?.[1] ?? '';
  return strip(body)
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&#39;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&nbsp;', ' ');
}

/** LinkedIn job ids are digits, whether typed or embedded in a job URL. */
export function jobIdFromInput({ id, url } = {}) {
  if (id !== undefined && id !== true) {
    const value = String(id).trim();
    if (!/^\d+$/.test(value)) throw new Error(`"${value}" is not a LinkedIn job id (digits only)`);
    return value;
  }
  if (url !== undefined && url !== true) {
    const fromUrl = jobIdFromUrl(String(url));
    if (fromUrl) return fromUrl;
    throw new Error(`"${url}" is not a LinkedIn job id or job URL`);
  }
  throw new Error('provide --id or --url (or --limit to resolve shortlisted rows)');
}

/** Null-returning variant so batch selection can skip rows that are not LinkedIn jobs. */
export function jobIdFromUrl(url) {
  return (
    String(url).match(/\/jobs\/view\/(\d+)/)?.[1] ??
    String(url).match(/[?&]currentJobId=(\d+)/)?.[1] ??
    null
  );
}

/** linkedin.com, its subdomains, and the licdn.com asset host are not employer ATSes. */
export function isLinkedInHost(url) {
  const value = String(url ?? '').trim();
  if (value === '') return false;
  let host;
  try {
    host = new URL(value).hostname.toLowerCase();
  } catch {
    // A relative href points at the job page itself, which is LinkedIn.
    return !/^[a-z][a-z0-9+.-]*:/i.test(value);
  }
  return /(^|\.)(linkedin|licdn)\.com$/.test(host);
}

/** Session expiry is fatal for the whole run: every later job would fail the same way. */
export function isAuthwallUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return false;
  }
  if (!/(^|\.)(linkedin|licdn)\.com$/i.test(parsed.hostname)) return false;
  return /^\/(authwall|login|signup|checkpoint|uas\/login)/i.test(parsed.pathname);
}

/**
 * LinkedIn wraps offsite applications in /safety/go?url=<encoded>, so the real ATS is hidden
 * inside a linkedin.com link. Unwrap repeatedly; anything else is returned untouched.
 */
export function unwrapRedirect(href) {
  let current = String(href ?? '').trim();
  for (let depth = 0; depth < 3; depth += 1) {
    let parsed;
    try {
      parsed = new URL(current);
    } catch {
      return current;
    }
    if (!isLinkedInHost(parsed.href) || !parsed.pathname.startsWith('/safety/go')) return current;
    const inner = parsed.searchParams.get('url');
    if (!inner) return current;
    current = inner;
  }
  return current;
}

/**
 * Decide the outcome from what the page showed. Precedence matters: an offsite href is
 * already the answer, a popup or navigation away is the next-strongest signal, and an
 * Easy Apply modal means there is no external URL to hand off.
 */
export function classifyApplyTarget({
  hrefs = [],
  buttonLabel = '',
  popupUrl = null,
  navigatedTo = null,
  sawEasyApplyModal = false,
} = {}) {
  const usable = hrefs
    .map((href) => unwrapRedirect(href))
    .filter((href) => href !== '' && href !== '#' && !href.startsWith('#') && !/^javascript:/i.test(href));
  const offsite = usable.filter((href) => !isLinkedInHost(href));
  if (offsite.length > 0) {
    const label = buttonLabel ? `"${buttonLabel.trim()}" -> ` : '';
    return { kind: 'ats', applyUrl: offsite[0], reason: `${label}offsite apply link` };
  }

  if (EASY_APPLY_LABEL.test(buttonLabel)) {
    return { kind: 'easy-apply', applyUrl: null, reason: 'LinkedIn Easy Apply button - complete it by hand' };
  }

  const target = popupUrl ?? navigatedTo;
  if (target && !isLinkedInHost(target)) {
    const via = popupUrl ? 'apply opened an external tab' : 'apply navigated off LinkedIn';
    return { kind: 'ats', applyUrl: String(target), reason: via };
  }

  if (sawEasyApplyModal) {
    return { kind: 'easy-apply', applyUrl: null, reason: 'LinkedIn Easy Apply form - complete it by hand' };
  }

  if (target) {
    return { kind: 'manual', applyUrl: null, reason: 'apply stayed on LinkedIn but no Easy Apply form appeared' };
  }
  return { kind: 'manual', applyUrl: null, reason: 'no offsite apply link or apply outcome found' };
}

/** Poll for any of the three outcomes instead of waiting on one event that may never fire. */
async function watchApplyOutcome(page, beforeUrl, timeoutMs = CLICK_TIMEOUT) {
  const context = page.context();
  const knownPages = new Set(context.pages());
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const popup = context.pages().find((candidate) => !knownPages.has(candidate));
    if (popup) {
      await popup.waitForLoadState('domcontentloaded').catch(() => {});
      const popupUrl = popup.url();
      await popup.close().catch(() => {});
      return { popupUrl, navigatedTo: null, sawEasyApplyModal: false };
    }
    const current = page.url();
    if (current !== beforeUrl) return { popupUrl: null, navigatedTo: current, sawEasyApplyModal: false };
    if (await hasEasyApplyModal(page)) return { popupUrl: null, navigatedTo: null, sawEasyApplyModal: true };
    await page.waitForTimeout(250);
  }

  return { popupUrl: null, navigatedTo: null, sawEasyApplyModal: false };
}

async function hasEasyApplyModal(page) {
  return page
    .evaluate(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], dialog[open], [data-test-modal]')];
      if (dialogs.some((node) => /easy apply|submit application|contact info|resume|cover letter/i.test(node.innerText ?? ''))) return true;
      return [...document.querySelectorAll('iframe[src]')].some((frame) => {
        try {
          const host = new URL(frame.getAttribute('src'), location.href).hostname;
          return host === 'linkedin.com' || host.endsWith('.linkedin.com');
        } catch {
          return false;
        }
      });
    })
    .catch(() => false);
}

/** Read anchors, buttons and role=button nodes: the apply affordance is a button on modern LinkedIn. */
async function readAffordances(page) {
  return page.$$eval('a[href], button, [role="button"]', (nodes) =>
    nodes.map((node) => ({
      tag: node.tagName.toLowerCase(),
      href: node.getAttribute('href') ?? '',
      text: `${node.textContent ?? ''} ${node.getAttribute('aria-label') ?? ''}`.replace(/\s+/g, ' ').trim(),
    })),
  );
}

/** Open one job page and report where its application really happens. */
export async function resolveApplyTarget({ id, page } = {}) {
  const url = `https://www.linkedin.com/jobs/view/${id}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('a[href], button', { timeout: 15000 }).catch(() => {});
  if (isAuthwallUrl(page.url())) throw new SessionExpired(`redirected to ${page.url()}`);

  const affordances = await readAffordances(page);
  const applyControls = affordances.filter((item) => APPLY_LABEL.test(item.text));

  // Never click when the label already tells us: Easy Apply has no external target.
  if (applyControls.some((item) => EASY_APPLY_LABEL.test(item.text))) {
    return { id, url, kind: 'easy-apply', applyUrl: null, reason: 'LinkedIn Easy Apply button - complete it by hand' };
  }

  const linkResult = classifyApplyTarget({
    hrefs: applyControls.filter((item) => item.tag === 'a').map((item) => item.href),
    buttonLabel: applyControls[0]?.text ?? '',
  });
  if (linkResult.kind === 'ats') return { id, url, ...linkResult };

  const control = page.locator('a[href], button, [role="button"]').filter({ hasText: APPLY_LABEL }).first();
  const found = await control.count().catch(() => 0);
  if (found === 0) {
    return { id, url, kind: 'manual', applyUrl: null, reason: 'no apply control found on the job page' };
  }

  // Listen before the click: the popup may appear immediately.
  const outcome = watchApplyOutcome(page, page.url());
  await control.click({ timeout: CLICK_TIMEOUT }).catch(() => {});
  const observed = await outcome;
  if (observed.navigatedTo && isAuthwallUrl(observed.navigatedTo)) {
    throw new SessionExpired(`redirected to ${observed.navigatedTo}`);
  }

  return { id, url, ...classifyApplyTarget({ buttonLabel: applyControls[0]?.text ?? '', ...observed }) };
}
