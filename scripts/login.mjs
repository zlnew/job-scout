/**
 * Open a site in the persistent profile so logins survive for later runs.
 *
 *   npm run login                     # LinkedIn (default)
 *   npm run login -- --site glints    # linkedin | glints | kalibrr | dealls
 *   npm run login -- --site https://example.com/login
 *
 * Log in by hand, then close the window. Never script credentials here.
 */
import { hasDisplay, launch, parseArgs } from './browser.mjs';

// Root domains for the boards that have no stable login path worth hardcoding.
export const SITES = {
  linkedin: 'https://www.linkedin.com/login',
  glints: 'https://glints.com',
  kalibrr: 'https://www.kalibrr.com',
  dealls: 'https://dealls.com',
};

export function resolveTarget(args = {}, positional = []) {
  const requested = args.site ?? positional[0] ?? 'linkedin';
  if (/^https?:\/\//i.test(requested)) return requested;
  const url = SITES[String(requested).toLowerCase()];
  if (!url) {
    throw new Error(`unknown site "${requested}". use one of: ${Object.keys(SITES).join(', ')} — or pass a full URL`);
  }
  return url;
}

const invokedDirectly = process.argv[1] && new URL(import.meta.url).pathname === process.argv[1];
if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  let url;
  try {
    url = resolveTarget(args, process.argv.slice(2).filter((token) => !token.startsWith('--')));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }

  if (!hasDisplay() && !args.headless) {
    console.error('no display on this machine, so a headed browser cannot open here.');
    console.error('options:');
    console.error('  1. log in on your own machine and import the cookies:  node scripts/import-cookies.mjs cookies.json');
    console.error('  2. run this harness on the machine with a browser instead');
    console.error('  3. xvfb-run -a npm run login           (virtual display, still blind)');
    console.error('  4. ssh -X into this box, then npm run login  (needs X11 forwarding)');
    process.exit(2);
  }

  const waitMs = Number(args.wait ?? 600) * 1000;
  const context = await launch({ headless: false });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  console.log(`${url}\nlog in by hand — the session is saved to ./profile. Close the window when done (timeout ${waitMs / 1000}s).`);
  await page.waitForEvent('close', { timeout: waitMs }).catch(() => console.log('timeout reached; closing'));
  await context.close();
}
