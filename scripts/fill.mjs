/**
 * Prefill a job application form. Fills fields, screenshots the result, and never
 * clicks submit — a human reviews and sends.
 *
 *   node scripts/fill.mjs --url <url> --fields fields.json [--headless] [--shot out.png]
 *
 * fields.json maps a form label (or input name, or placeholder) to a value.
 * Fields written as {"__file": "path"} set a file input.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { launch, parseArgs } from './browser.mjs';

const args = parseArgs(process.argv.slice(2));
if (!args.url) {
  console.error('usage: node scripts/fill.mjs --url <url> --fields <fields.json> [--headless] [--submit] [--hold]');
  process.exit(2);
}

// --submit is opt-in and never applies to LinkedIn itself (Easy Apply risks the account).
const ALLOW_SUBMIT = Boolean(args.submit);
if (ALLOW_SUBMIT) {
  const host = new URL(args.url).hostname;
  if (/(^|\.)linkedin\.com$/i.test(host)) {
    console.error('refusing --submit on linkedin.com: Easy Apply automation risks the account.');
    console.error('open the posting yourself, or resolve the employer ATS URL and run --submit there.');
    process.exit(2);
  }
}

const fieldsPath = resolve(args.fields ?? 'fields.json');
const fields = JSON.parse(readFileSync(fieldsPath, 'utf8'));
const fieldsDir = dirname(fieldsPath);

const hostSlug = new URL(args.url).hostname.replaceAll(/[^a-z0-9]+/gi, '-') || 'local';
const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
const shotPath = resolve(args.shot ?? `screenshots/${stamp}-${hostSlug}.png`);
const reportPath = resolve(args.report ?? `screenshots/${stamp}-${hostSlug}.report.json`);

const escapeAttr = (value) => String(value).replaceAll('"', '\\"');

/** Find one fillable element for a key, in the order a human would recognise it. */
async function locate(page, key) {
  const strategies = [
    ['label', () => page.getByLabel(key, { exact: false })],
    ['name', () => page.locator(`[name="${escapeAttr(key)}"]`)],
    ['placeholder', () => page.getByPlaceholder(key, { exact: false })],
    ['aria-label', () => page.locator(`[aria-label*="${escapeAttr(key)}" i]`)],
  ];
  for (const [via, make] of strategies) {
    const locator = make();
    let count = 0;
    try {
      count = await locator.count();
    } catch {
      continue;
    }
    if (count > 0) return { locator: locator.first(), via, count };
  }
  return null;
}

const report = { url: args.url, fields: fieldsPath, filled: [], missed: [], ambiguous: [], skipped: [], submitted: null, shot: null };

const context = await launch({ headless: Boolean(args.headless) });
const page = context.pages()[0] ?? (await context.newPage());
page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));

try {
  await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(args.headless ? 200 : 800);

  for (const [key, raw] of Object.entries(fields)) {
    const value = raw && typeof raw === 'object' && '__file' in raw ? raw.__file : raw;
    const found = await locate(page, key);

    if (!found) {
      report.missed.push(key);
      continue;
    }
    if (found.count > 1) report.ambiguous.push({ field: key, matches: found.count, via: found.via });

    const meta = await found.locator.evaluate((el) => ({
      tag: el.tagName.toLowerCase(),
      type: (el.getAttribute('type') ?? '').toLowerCase(),
    }));

    // Never trigger navigation or sending from the filler.
    if (meta.tag === 'button' || ['submit', 'button', 'image', 'reset'].includes(meta.type)) {
      report.skipped.push({ field: key, reason: `${meta.tag}[type=${meta.type || 'none'}]` });
      continue;
    }

    try {
      if (meta.tag === 'select') {
        try {
          await found.locator.selectOption({ label: String(value) });
        } catch {
          await found.locator.selectOption(String(value));
        }
      } else if (meta.type === 'file') {
        await found.locator.setInputFiles(resolve(fieldsDir, String(value)));
      } else if (meta.type === 'checkbox' || meta.type === 'radio') {
        if (value) await found.locator.check();
        else await found.locator.uncheck();
      } else {
        await found.locator.fill(String(value));
      }
      report.filled.push({ field: key, via: found.via, as: meta.tag === 'select' ? 'select' : meta.type || meta.tag });
    } catch (error) {
      report.missed.push(key);
      report.lastError = `${key}: ${error.message.split('\n')[0]}`;
    }
  }

  if (args.hold && !ALLOW_SUBMIT) {
    console.log('form filled — review it in the browser, then close the window');
    await page.waitForEvent('close', { timeout: Number(args['hold-ms'] ?? 600_000) }).catch(() => {});
  }

  if (ALLOW_SUBMIT) {
    // Refuse to send anything a human has not been able to verify.
    if (report.missed.length > 0) {
      report.submitBlocked = `unfilled fields: ${report.missed.join(', ')}`;
    } else {
      const requiredEmpty = await page.evaluate(() => {
        const controls = [...document.querySelectorAll('input, select, textarea')];
        return controls
          .filter((el) => el.required || el.getAttribute('aria-required') === 'true')
          .filter((el) => {
            if (el.type === 'file') return !el.files?.length;
            if (el.type === 'checkbox' || el.type === 'radio') return !el.checked;
            return !String(el.value ?? '').trim();
          })
          .map((el) => el.name || el.id || el.getAttribute('aria-label') || el.type);
      });
      if (requiredEmpty.length > 0) {
        report.submitBlocked = `required fields empty: ${requiredEmpty.join(', ')}`;
      } else {
        const button = page.locator('button[type=submit], input[type=submit]').first();
        if ((await button.count()) === 0) {
          report.submitBlocked = 'no submit control found';
        } else {
          console.log(`SUBMITTING: ${args.url} — ${report.filled.length} fields filled, 0 missed`);
          await button.click();
          await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
          await page.waitForTimeout(1200);
          report.submitClicked = true;
        }
      }
    }
    if (report.submitBlocked) console.error(`refusing to submit — ${report.submitBlocked}`);
  }

  report.submitted = await page.evaluate(() => document.body?.dataset?.submitted ?? null);
  mkdirSync(dirname(shotPath), { recursive: true });
  await page.screenshot({ path: shotPath, fullPage: true });
  report.shot = shotPath;
} finally {
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  await context.close();
}

console.log(JSON.stringify({ filled: report.filled.length, missed: report.missed, ambiguous: report.ambiguous.length, submitClicked: report.submitClicked ?? false, submitBlocked: report.submitBlocked ?? null, shot: report.shot, report: reportPath }, null, 2));
if (report.submitBlocked) process.exit(3);
if (report.missed.length > 0) {
  console.error(`NEEDS_REVIEW: ${report.missed.length} field(s) could not be filled — fill them by hand.`);
  process.exit(1);
}
