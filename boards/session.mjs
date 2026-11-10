/**
 * Authenticated HTML scrape, driven entirely by a source config (S9.1). Nothing
 * here knows a board name: the config supplies the URL template, the card
 * selector, the per-field extractors and the pagination.
 *
 * A config that has not survived a headed verification run must not be scraped:
 * guessing selectors silently returns wrong jobs, so an unverified config fails
 * before a browser is ever launched.
 */
import { launch } from '../scripts/browser.mjs';

export const UNVERIFIED = 'unverified config';

const REQUIRED_FIELDS = ['id', 'title', 'company', 'location', 'posted', 'url'];

/** Everything a headed run still has to confirm, so the error names the gap. */
export function unverifiedParts(config) {
  const missing = [];
  if (config.verified !== true) missing.push('verified');
  if (!config.searchUrl) missing.push('searchUrl');
  if (!config.cards) missing.push('cards');
  for (const field of REQUIRED_FIELDS) {
    if (config.fields?.[field] == null) missing.push(`fields.${field}`);
  }
  return missing;
}

export function assertVerified(config) {
  const missing = unverifiedParts(config);
  if (missing.length === 0) return;
  // The message stays stable for the per-source report; the detail names the gap.
  const error = new Error(UNVERIFIED);
  error.detail = missing.join(', ');
  throw error;
}

/**
 * Field specs travel to the page as JSON: a CSS selector becomes a lookup, an
 * extractor becomes its source text rebuilt with `new Function` inside the page
 * (closures would not survive serialization, so extractors must be pure).
 */
function serialiseFields(fields) {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      typeof value === 'function' ? { fn: String(value) } : { selector: value },
    ]),
  );
}

// Runs in the browser: do not reference anything outside this function.
function readCards(els, fields) {
  return els.map((el) =>
    Object.fromEntries(
      Object.entries(fields).map(([key, field]) => {
        if (field.selector != null) {
          return [key, el.querySelector(field.selector)?.textContent?.trim() ?? null];
        }
        // eslint-disable-next-line no-new-func -- the extractor is authored in this repo, not user input
        return [key, new Function('el', `return (${field.fn})(el);`)(el)];
      }),
    ),
  );
}

function pageUrl(config, { query, location, page, previous }) {
  if (page > 1 && typeof config.nextPageUrl === 'function' && previous) {
    const next = config.nextPageUrl({ url: previous, page });
    if (next) return next;
  }
  return typeof config.searchUrl === 'function'
    ? config.searchUrl({ query, location, page })
    : config.searchUrl;
}

function absoluteUrl(href, base) {
  if (!href) return '';
  try {
    return new URL(href, base).toString();
  } catch {
    return '';
  }
}

/**
 * Scrape one board's search pages. Returns rows without `source`/`via`; the
 * registry stamps those so every board shares one candidate shape (S9.2).
 */
export async function scrape(
  config,
  {
    queries = [''],
    location = 'Indonesia',
    pages = 1,
    fetchImpl = globalThis.fetch,
    launchImpl = launch,
    delayMs = 0,
    timeoutMs = config.timeoutMs ?? 20000,
  } = {},
) {
  assertVerified(config);

  const fields = serialiseFields(config.fields);
  const context = await launchImpl({ headless: true });
  const rows = [];
  const seen = new Set();

  try {
    const page = context.pages?.()[0] ?? (await context.newPage());

    for (const query of queries) {
      let previous = null;
      for (let pageNo = 1; pageNo <= pages; pageNo += 1) {
        const url = pageUrl(config, { query, location, page: pageNo, previous });
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        try {
          await page.waitForSelector(config.cards, { timeout: timeoutMs });
        } catch {
          throw new Error(
            `card selector never appeared: ${config.cards} (session expired or the layout changed)`,
          );
        }

        const cards = await page.$$eval(config.cards, readCards, fields);
        const base = page.url();

        for (const card of cards) {
          const title = String(card.title ?? '').trim();
          const urlForCard = absoluteUrl(card.url, base);
          if (!title || !urlForCard) continue;
          const id = String(card.id ?? '').trim() || urlForCard;
          if (seen.has(id)) continue;
          seen.add(id);
          rows.push({
            id,
            title,
            company: String(card.company ?? '').trim(),
            location: String(card.location ?? '').trim(),
            posted: String(card.posted ?? '').trim(),
            url: urlForCard,
          });
        }

        previous = url;
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  } finally {
    await context.close();
  }

  return rows;
}
