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
import { DEFAULT_QUERIES, fetchJobDescription, rankTitle, searchJobs } from '../boards/linkedin.mjs';
import { parseArgs } from './browser.mjs';

const args = parseArgs(process.argv.slice(2));
const location = args.location ?? 'Indonesia';
const pages = Number(args.pages ?? 1);
const queries = String(args.queries ?? DEFAULT_QUERIES.join('|')).split('|').map((q) => q.trim());

const candidates = await searchJobs({ queries, location, pages });

const outDir = resolve(import.meta.dirname, '..', 'postings');
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 10);
writeFileSync(`${outDir}/sweep-${stamp}.json`, `${JSON.stringify(candidates, null, 2)}\n`);

console.log(`${candidates.length} candidates (${location})\n`);
for (const c of candidates) console.log(`${rankTitle(c.title)}  ${c.posted}  ${c.company.slice(0, 28).padEnd(28)}  ${c.title.slice(0, 52).padEnd(52)}  ${c.id}`);

if (args.jd) {
  const top = candidates.slice(0, Number(args.jd));
  console.log(`\nfetching ${top.length} JD bodies…`);
  for (const c of top) {
    try {
      c.jd = await fetchJobDescription(c.id);
      writeFileSync(`${outDir}/${c.id}.txt`, `${c.title}\n${c.company} · ${c.location}\n${c.url}\n\n${c.jd}\n`);
      console.log(`  ${c.id} ${c.jd.length}b ${c.title.slice(0, 40)}`);
    } catch (error) {
      console.log(`  ${c.id} FAILED ${error.message}`);
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  writeFileSync(`${outDir}/sweep-${stamp}.json`, `${JSON.stringify(candidates, null, 2)}\n`);
}
