/**
 * Export cookies from THIS machine's harness profile, as JSON suitable for import-cookies.mjs
 * on another machine. Use it on the machine where you actually logged in.
 *
 *   node scripts/export-cookies.mjs --domain linkedin.com --out /tmp/li.json
 *   node scripts/export-cookies.mjs --domain linkedin.com --stdout | ssh other "cd job-apply && node scripts/import-cookies.mjs -"
 *
 * Close the login window first: Chromium locks a profile directory it already has open.
 */
import { writeFileSync } from 'node:fs';
import { launch, parseArgs } from './browser.mjs';

/** Keep cookies belonging to the requested domain and its subdomains. */
export function selectCookies(cookies, domain) {
  if (!domain) return cookies;
  const needle = String(domain).replace(/^\./, '').toLowerCase();
  return cookies.filter((cookie) => String(cookie.domain ?? '').replace(/^\./, '').toLowerCase().endsWith(needle));
}

const invokedDirectly = process.argv[1] && new URL(import.meta.url).pathname === process.argv[1];
if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  let context;
  try {
    context = await launch({ headless: true });
  } catch (error) {
    console.error(`cannot open the profile: ${error.message}`);
    console.error('if a login window is still open, close it first — Chromium locks ./profile.');
    process.exit(2);
  }

  try {
    const all = await context.cookies();
    const picked = selectCookies(all, args.domain);
    if (picked.length === 0) {
      console.error(`no cookies${args.domain ? ` for ${args.domain}` : ''} in this profile — log in first (npm run login).`);
      process.exit(1);
    }

    const json = `${JSON.stringify(picked, null, 2)}\n`;
    if (args.stdout) process.stdout.write(json);
    else {
      const out = String(args.out ?? `cookies-${args.domain ?? 'all'}.json`);
      writeFileSync(out, json);
      console.error(`${picked.length} cookies → ${out} (no secrets printed to stdout)`);
    }
  } finally {
    await context.close();
  }
}
