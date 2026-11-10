/**
 * Kalibrr. Measured 2026-11: `/job-board/...` answers 308 without a session, so
 * the search page needs the persistent Playwright profile (S9.1
 * `via: 'session'`). No public search JSON exists.
 *
 * TODO(headed): with a logged-in profile, confirm each item and delete it:
 *  1. searchUrl — the full search route under `https://www.kalibrr.com/job-board/`
 *     (only that prefix is measured) plus its keyword/location/page parameters.
 *     `searchUrl` stays null until the shape is observed; guessing it would
 *     scrape the wrong page.
 *  2. cards — the job card container selector on the results list.
 *  3. fields.id/title/company/location/posted/url — selectors relative to that
 *     card.
 *  4. pagination — `?page=N` versus a "load more" button.
 */
export default {
  name: 'kalibrr',
  via: 'session',
  verified: false,
  searchUrl: null,
  cards: null,
  fields: { id: null, title: null, company: null, location: null, posted: null, url: null },
};
