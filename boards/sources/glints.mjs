/**
 * Glints (Indonesia). Measured 2026-11: the explore page 302s an
 * unauthenticated request, so this board needs the persistent Playwright
 * profile (S9.1 `via: 'session'`). No public search JSON exists.
 *
 * TODO(headed): with a logged-in profile, confirm each item and delete it:
 *  1. searchUrl — the exact query parameter names for keyword and location, and
 *     whether `page` is 1-based. Only the `/id/opportunities/jobs/explore` path
 *     is measured; the parameter names below are placeholders.
 *  2. cards — the job card container selector on the explore grid.
 *  3. fields.id/title/company/location/posted/url — selectors relative to that
 *     card, or `(el) => value` extractors when the value is not in the DOM text.
 *  4. pagination — whether `?page=N` is a route or the grid is infinite-scroll
 *     (then provide `nextPageUrl({ url, page })` instead).
 */
export default {
  name: 'glints',
  via: 'session',
  verified: false,
  searchUrl: ({ query, location, page }) =>
    `https://glints.com/id/opportunities/jobs/explore?keyword=${encodeURIComponent(query)}&location=${encodeURIComponent(location)}&page=${page}`,
  cards: null,
  fields: { id: null, title: null, company: null, location: null, posted: null, url: null },
};
