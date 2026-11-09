/**
 * Discover where a LinkedIn posting's application actually happens: an employer ATS
 * URL, LinkedIn's own Easy Apply form, or neither. It only reads the page and, at most,
 * clicks the apply control once - it never fills or submits a form.
 *
 *   node scripts/resolve.mjs --id 4440204415 [--write]
 *   node scripts/resolve.mjs --url https://www.linkedin.com/jobs/view/4440204415 [--write]
 *   node scripts/resolve.mjs --limit 5 [--write]
 *
 * Without --write the result is printed and nothing is stored. Easy Apply stays manual:
 * the harness refuses to automate it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, parseArgs } from './browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const STORE = join(ROOT, 'applications.json');
// LinkedIn renders opaque class names, so affordances are matched by their text only.
const APPLY_LABEL = /\b(apply|easy apply|apply now|apply on company|lamar)\b/i;
const EASY_APPLY_LABEL = /easy\s*apply/i;
const CLICK_TIMEOUT = 20000;

const USAGE = [
  'usage: node scripts/resolve.mjs --id <job id> [--write]',
  '       node scripts/resolve.mjs --url <linkedin job url> [--write]',
  '       node scripts/resolve.mjs --limit <n> [--write]',
].join('\n');

class SessionExpired extends Error {}

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
function jobIdFromUrl(url) {
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

/** Rows worth resolving: shortlisted LinkedIn jobs that still have no discovered ATS URL. */
export function pendingResolutions(records, limit = 5) {
  const ids = [];
  for (const record of records) {
    if (record.status !== 'shortlisted' || record.applyUrl) continue;
    const id = jobIdFromUrl(record.url ?? '');
    if (!id) continue;
    ids.push(id);
    if (ids.length >= limit) break;
  }
  return ids;
}

/** Return a new record list with one resolution applied; every other field is preserved. */
export function mergeResolution(records, result, resolvedAt = new Date().toISOString().slice(0, 10)) {
  const target = String(result.id);
  return records.map((record) => {
    if (jobIdFromUrl(record.url ?? '') !== target) return record;
    return {
      ...record,
      applyUrl: result.kind === 'ats' ? result.applyUrl : null,
      applyKind: result.kind,
      resolvedAt,
    };
  });
}

/** The store keeps 2-space JSON and one trailing newline; diffs stay readable. */
export function serializeStore(store) {
  return `${JSON.stringify(store, null, 2)}\n`;
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

async function resolveJob(page, id) {
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

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  const wantsBatch = args.limit !== undefined;

  let ids = [];
  try {
    if (wantsBatch) {
      const limit = Number(args.limit);
      if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be a positive whole number');
      const store = JSON.parse(readFileSync(STORE, 'utf8'));
      ids = pendingResolutions(store.applications ?? [], limit);
    } else {
      ids = [jobIdFromInput(args)];
    }
  } catch (error) {
    console.error(`resolve: ${error.message}`);
    console.error(USAGE);
    process.exit(2);
  }

  if (ids.length === 0) {
    console.log('nothing to resolve: no shortlisted LinkedIn rows are missing applyUrl');
    process.exit(0);
  }

  let context;
  try {
    context = await launch({ headless: true });
  } catch (error) {
    console.error(`resolve: ${error.message}`);
    process.exit(1);
  }

  const page = await context.newPage();
  const results = [];
  try {
    for (const id of ids) {
      try {
        const result = await resolveJob(page, id);
        results.push(result);
        console.log(JSON.stringify(result));
      } catch (error) {
        if (error instanceof SessionExpired) throw error;
        // One broken page should not hide the rest of a batch.
        const result = { id, url: `https://www.linkedin.com/jobs/view/${id}`, kind: 'manual', applyUrl: null, reason: `page failed: ${error.message}` };
        results.push(result);
        console.log(JSON.stringify(result));
      }
    }
  } catch (error) {
    if (!(error instanceof SessionExpired)) throw error;
    console.error(`session expired (${error.message}) - re-import cookies, then rerun.`);
    console.error('  npm run import-cookies -- cookies.json --verify https://www.linkedin.com/feed');
    await context.close().catch(() => {});
    process.exit(4);
  }

  if (args.write) {
    const store = JSON.parse(readFileSync(STORE, 'utf8'));
    let records = store.applications ?? [];
    for (const result of results) records = mergeResolution(records, result);
    const written = serializeStore({ ...store, applications: records });
    writeFileSync(STORE, written);
    console.error(`wrote ${results.length} resolution(s) to ${STORE}`);
  }

  await context.close().catch(() => {});
}
