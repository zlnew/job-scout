/**
 * Sweep LinkedIn's public job board for target roles and rank what comes back.
 *
 *   node scripts/sweep.mjs                      # Indonesia, default query set
 *   node scripts/sweep.mjs --location "Jakarta" --pages 2
 *   node scripts/sweep.mjs --jd 8               # also fetch JD bodies for the top 8
 *
 * Scoring of the JD text stays with the agent (see answers.md); this only collects,
 * filters by title/location, and ranks candidates.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from './browser.mjs';

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0 Safari/537.36';

const DEFAULT_QUERIES = [
  'backend engineer golang',
  'backend engineer fintech',
  'platform engineer',
  'product engineer golang',
  'software engineer golang',
  'api integration engineer',
];

const ALLOW = /(backend|back-end|platform|product engineer|full.?stack|software engineer|golang|go developer|api|integration)/i;
const DENY = /(devops|sre$|site reliability|data engineer|data scientist|android|ios|mobile|flutter|qa\b|quality assurance|manager|head of|principal|director|intern|magang)/i;

const args = parseArgs(process.argv.slice(2));
const location = args.location ?? 'Indonesia';
const pages = Number(args.pages ?? 1);
const queries = String(args.queries ?? DEFAULT_QUERIES.join('|')).split('|').map((q) => q.trim());

const strip = (s) => s.replaceAll(/<[^>]+>/g, ' ').replaceAll(/\s+/g, ' ').trim();

async function get(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

function parseCards(html) {
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

async function fetchJd(id) {
  const html = await get(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`);
  const body = html.match(/class="show-more-less-html__markup[^"]*">([\s\S]*?)<\/div>/)?.[1] ?? '';
  return strip(body)
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&#39;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&nbsp;', ' ');
}

const seen = new Map();
for (const query of queries) {
  for (let page = 0; page < pages; page += 1) {
    const url = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(query)}&location=${encodeURIComponent(location)}&start=${page * 25}`;
    let html = '';
    try {
      html = await get(url);
    } catch (error) {
      console.error(`skip ${query} p${page}: ${error.message}`);
      continue;
    }
    for (const card of parseCards(html)) {
      if (!card.title || seen.has(card.id)) continue;
      if (!ALLOW.test(card.title) || DENY.test(card.title)) continue;
      seen.set(card.id, { ...card, query });
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
}

const rank = (title) => {
  if (/backend|back-end|golang|go developer/i.test(title)) return 3;
  if (/platform/i.test(title)) return 2;
  if (/product engineer|api|integration/i.test(title)) return 2;
  if (/full.?stack/i.test(title)) return 1;
  return 1; // bare "software engineer" — accepted when the JD is backend
};

const candidates = [...seen.values()].sort((a, b) => rank(b.title) - rank(a.title) || b.posted.localeCompare(a.posted));

const outDir = resolve(import.meta.dirname, '..', 'postings');
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 10);
writeFileSync(`${outDir}/sweep-${stamp}.json`, `${JSON.stringify(candidates, null, 2)}\n`);

console.log(`${candidates.length} candidates (${location})\n`);
for (const c of candidates) console.log(`${rank(c.title)}  ${c.posted}  ${c.company.slice(0, 28).padEnd(28)}  ${c.title.slice(0, 52).padEnd(52)}  ${c.id}`);

if (args.jd) {
  const top = candidates.slice(0, Number(args.jd));
  console.log(`\nfetching ${top.length} JD bodies…`);
  for (const c of top) {
    try {
      c.jd = await fetchJd(c.id);
      writeFileSync(`${outDir}/${c.id}.txt`, `${c.title}\n${c.company} · ${c.location}\n${c.url}\n\n${c.jd}\n`);
      console.log(`  ${c.id} ${c.jd.length}b ${c.title.slice(0, 40)}`);
    } catch (error) {
      console.log(`  ${c.id} FAILED ${error.message}`);
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  writeFileSync(`${outDir}/sweep-${stamp}.json`, `${JSON.stringify(candidates, null, 2)}\n`);
}
