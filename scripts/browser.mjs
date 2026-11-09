import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const CACHE = join(homedir(), '.cache/ms-playwright');

/** Newest chromium already downloaded by playwright, wherever it lives. */
export function chromePath() {
  const candidates = [];
  for (const dir of readdirSync(CACHE).filter((name) => name.startsWith('chromium-'))) {
    let entries = [];
    try {
      entries = readdirSync(join(CACHE, dir));
    } catch {
      continue;
    }
    for (const sub of entries) {
      const binary = join(CACHE, dir, sub, 'chrome');
      try {
        if (statSync(binary).isFile()) candidates.push(binary);
      } catch {
        // not a chrome dir
      }
    }
  }
  return candidates.sort().at(-1) ?? null;
}

/** A real X server (or ssh -X) is required for a headed browser. */
export const hasDisplay = () => Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

/** Persistent profile: logins survive between runs. Gitignored — it holds session cookies. */
export const PROFILE = process.env.JOB_APPLY_PROFILE ?? resolve(import.meta.dirname, '..', 'profile');

/**
 * Where to get a browser from: explicit binary > explicit channel > playwright cache > system Chrome.
 * A machine with Google Chrome installed needs no 150MB download.
 */
export function launchTarget({ env = process.env, findCached = chromePath } = {}) {
  if (env.JOB_APPLY_CHROME) return { executablePath: env.JOB_APPLY_CHROME };
  if (env.JOB_APPLY_CHANNEL) return { channel: env.JOB_APPLY_CHANNEL };
  const cached = findCached();
  if (cached) return { executablePath: cached };
  return { channel: 'chrome' };
}

export async function launch({ headless = false } = {}) {
  const target = launchTarget();
  try {
    return await chromium.launchPersistentContext(PROFILE, {
      ...target,
      headless,
      viewport: { width: 1280, height: 900 },
      slowMo: headless ? 0 : 40,
    });
  } catch (error) {
    if (!/Executable doesn't exist|no chromium|channel/i.test(error.message)) throw error;
    throw new Error(
      [
        'no usable browser found.',
        'fix with one of:',
        '  npm i -D playwright && npx playwright install chromium   # download playwright chromium',
        '  JOB_APPLY_CHANNEL=chromium npm run login                 # use a system chromium build',
        '  JOB_APPLY_CHROME=/path/to/chrome npm run login           # point at a binary',
      ].join('\n'),
    );
  }
}

/** Minimal `--key value` / `--key=value` / `--flag` parser. */
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const [key, inline] = token.slice(2).split('=');
    if (inline !== undefined) out[key] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
      out[key] = argv[i + 1];
      i += 1;
    } else out[key] = true;
  }
  return out;
}
