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
import { checkSubmission } from '../core/guard.mjs';
import {
  dismissConsent,
  dumpControls,
  fillForm,
  findSubmit,
  openGate,
  requiredEmptyControls,
} from '../core/execute.mjs';

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
// --dump only inspects the form, so it must work without a field map.
const fields = args.dump ? {} : JSON.parse(readFileSync(fieldsPath, 'utf8'));
const fieldsDir = dirname(fieldsPath);

const hostSlug = new URL(args.url).hostname.replaceAll(/[^a-z0-9]+/gi, '-') || 'local';
const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
const shotPath = resolve(args.shot ?? `screenshots/${stamp}-${hostSlug}.png`);
const reportPath = resolve(args.report ?? `screenshots/${stamp}-${hostSlug}.report.json`);

const report = { url: args.url, fields: fieldsPath, filled: [], missed: [], ambiguous: [], skipped: [], submitted: null, shot: null };

const context = await launch({ headless: Boolean(args.headless) });
const page = context.pages()[0] ?? (await context.newPage());
page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));

try {
  await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(args.headless ? 200 : 800);

  await dismissConsent(page);

  if (args.click) {
    if (!(await openGate(page, args.click))) {
      console.error(`--click "${args.click}" matched nothing on ${args.url}`);
      await context.close();
      process.exit(4);
    }
    report.clicked = String(args.click);
  }

  if (args.dump) {
    console.log(JSON.stringify(await dumpControls(page), null, 2));
    await context.close();
    process.exit(0);
  }

  const filled = await fillForm(page, { fields, fieldsDir });
  report.filled = filled.filled;
  report.missed = filled.missed;
  report.ambiguous = filled.ambiguous;
  report.skipped = filled.skipped;
  if (filled.lastError) report.lastError = filled.lastError;

  if (args.hold && !ALLOW_SUBMIT) {
    console.log('form filled — review it in the browser, then close the window');
    await page.waitForEvent('close', { timeout: Number(args['hold-ms'] ?? 600_000) }).catch(() => {});
  }

  if (ALLOW_SUBMIT) {
    // Refuse to send anything a human has not been able to verify.
    // Keep the old order: a missed field blocks before required controls are probed.
    const requiredEmpty = report.missed.length > 0 ? [] : await requiredEmptyControls(page);
    const guard = checkSubmission({ kind: 'ats', missed: report.missed, requiredEmpty });

    if (!guard.ok) {
      report.submitBlocked = guard.reasons.map((entry) => entry.message).join('; ');
      report.submitBlockedFixes = guard.reasons.map((entry) => entry.fix);
    } else {
      const button = await findSubmit(page);
      if (!button) {
        report.submitBlocked = 'no submit control found';
      } else {
        console.log(`SUBMITTING: ${args.url} — ${report.filled.length} fields filled, 0 missed`);
        await button.click();
        await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
        await page.waitForTimeout(1200);
        report.submitClicked = true;
      }
    }
    if (report.submitBlocked) {
      console.error(`refusing to submit — ${report.submitBlocked}`);
      for (const fix of report.submitBlockedFixes ?? []) console.error(`  fix: ${fix}`);
    }
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
