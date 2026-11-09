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
  if (candidates.length === 0) {
    throw new Error(`no chromium binary under ${CACHE}; run: npx playwright install chromium`);
  }
  return candidates.sort().at(-1);
}

/** A real X server (or ssh -X) is required for a headed browser. */
export const hasDisplay = () => Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

/** Persistent profile: logins survive between runs. Gitignored — it holds session cookies. */
export const PROFILE = process.env.JOB_APPLY_PROFILE ?? resolve(import.meta.dirname, '..', 'profile');

export async function launch({ headless = false } = {}) {
  return chromium.launchPersistentContext(PROFILE, {
    executablePath: chromePath(),
    headless,
    viewport: { width: 1280, height: 900 },
    slowMo: headless ? 0 : 40,
  });
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
