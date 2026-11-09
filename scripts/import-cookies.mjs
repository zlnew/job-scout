/**
 * Seed the persistent profile with cookies exported from a browser on another machine.
 * Use this when the box running the harness has no display (headless server, plain SSH).
 *
 *   1. On your laptop: log into the site.
 *   2. Export cookies for that domain as JSON (Cookie-Editor → Export, or Playwright storage state).
 *   3. Copy the file here, then:
 *
 *   node scripts/import-cookies.mjs cookies.json --verify https://www.linkedin.com/feed
 *
 * Verification is the point: it proves the imported session actually works before you rely on it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launch, parseArgs } from './browser.mjs';

const SAME_SITE = {
  no_restriction: 'None',
  none: 'None',
  lax: 'Lax',
  strict: 'Strict',
  unspecified: undefined,
  undefined: undefined,
};

/** Accept a Cookie-Editor array or a Playwright storage-state object. */
export function normalizeCookies(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.cookies) ? raw.cookies : null;
  if (!list) return { cookies: [], rejected: [{ reason: 'expected a JSON array of cookies or { cookies: [...] }' }] };

  const cookies = [];
  const rejected = [];

  for (const entry of list) {
    if (!entry || typeof entry.name !== 'string' || typeof entry.value !== 'string' || entry.name === '') {
      rejected.push({ name: entry?.name ?? '(unnamed)', reason: 'missing name or value' });
      continue;
    }
    if (!entry.domain && !entry.url) {
      rejected.push({ name: entry.name, reason: 'missing domain' });
      continue;
    }

    const sameSite = SAME_SITE[String(entry.sameSite ?? 'unspecified').toLowerCase()];
    const cookie = {
      name: entry.name,
      value: entry.value,
      path: entry.path || '/',
      httpOnly: Boolean(entry.httpOnly),
      secure: Boolean(entry.secure),
      expires: entry.session ? -1 : Math.floor(Number(entry.expirationDate ?? entry.expires ?? -1)),
    };
    if (entry.domain) cookie.domain = entry.domain;
    else cookie.url = entry.url;
    if (sameSite) cookie.sameSite = sameSite;
    // Chrome rejects SameSite=None without Secure.
    if (cookie.sameSite === 'None') cookie.secure = true;

    cookies.push(cookie);
  }

  return { cookies, rejected };
}

const invokedDirectly = process.argv[1] && new URL(import.meta.url).pathname === process.argv[1];
if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  const file = args.file ?? process.argv.slice(2).find((token) => !token.startsWith('--') && token !== args.verify);
  if (!file) {
    console.error('usage: node scripts/import-cookies.mjs <cookies.json> [--verify https://site/path]');
    process.exit(2);
  }

  // "-" reads the export from stdin, so it can be piped straight from the machine with the browser.
  let text;
  try {
    text = file === '-' ? readFileSync(0, 'utf8') : readFileSync(resolve(String(file)), 'utf8');
  } catch (error) {
    console.error(`cannot read ${file}: ${error.message}`);
    process.exit(2);
  }

  const bytes = Buffer.byteLength(text);
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (trimmed === '') {
    console.error(`${file === '-' ? 'stdin' : file} is empty (0 bytes) - nothing was pasted or piped.`);
    console.error('export cookies as JSON from the browser, then either scp the file or pipe it: pbpaste | ssh <server> "cd job-apply && node scripts/import-cookies.mjs - --verify <url>"');
    process.exit(2);
  }

  let raw;
  try {
    raw = JSON.parse(trimmed);
  } catch (error) {
    console.error(`${file === '-' ? 'stdin' : file} is not valid JSON (${bytes} bytes): ${error.message}`);
    console.error('Cookie-Editor: use Export -> JSON, not the Netscape/cookies.txt format.');
    process.exit(2);
  }

  const { cookies, rejected } = normalizeCookies(raw);
  if (rejected.length > 0) for (const item of rejected) console.error(`rejected ${item.name}: ${item.reason}`);
  if (cookies.length === 0) {
    console.error('no usable cookies in that file');
    process.exit(1);
  }

  const context = await launch({ headless: true });
  await context.addCookies(cookies);
  console.log(`imported ${cookies.length} cookies into ./profile`);

  if (args.verify) {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(String(args.verify), { waitUntil: 'domcontentloaded', timeout: 45_000 });
    const url = page.url();
    const loginWall = /\/(login|authwall|checkpoint|uas\/login)/i.test(url);
    console.log(loginWall ? `NOT logged in — redirected to ${url.replace(/\?.*$/, '')}` : `session works — landed on ${url.replace(/\?.*$/, '')}`);
    await page.screenshot({ path: 'screenshots/verify-session.png', fullPage: false }).catch(() => {});
    await context.close();
    process.exit(loginWall ? 1 : 0);
  }

  await context.close();
}
