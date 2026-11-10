/**
 * Dealls. Measured 2026-11: `https://dealls.com/opportunities` answers 404 for
 * that path but serves a Next.js page with `__NEXT_DATA__`, so the real search
 * URL is unknown and the payload is the promising path.
 *
 * Disabled on purpose: the JSON-first strategy (`via: 'session-json'`) was not
 * implemented because no verified `__NEXT_DATA__` job-array path exists yet.
 *
 * TODO(headed): with a logged-in profile, confirm each item and delete it:
 *  1. searchUrl — the actual opportunities search route (the measured path is a
 *     404) and its keyword/location/page parameters.
 *  2. __NEXT_DATA__ — the path to the job array inside the parsed payload, e.g.
 *     `props.pageProps.jobs`; when found, `session.mjs` can read it instead of
 *     the DOM and this source becomes `via: 'session-json'`.
 *  3. cards — the job card container selector, needed only as the DOM fallback.
 *  4. fields.id/title/company/location/posted/url — selectors relative to the card.
 *  5. pagination — route parameter versus infinite scroll.
 */
export default {
  name: 'dealls',
  via: 'session',
  verified: false,
  searchUrl: null,
  cards: null,
  fields: { id: null, title: null, company: null, location: null, posted: null, url: null },
};
