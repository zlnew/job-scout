/**
 * Generic form execution: consent walls, gate clicks, control dumping, and
 * label-based filling. ATS adapters supply the field map; this module owns the
 * browser mechanics and never clicks a submit-like control while filling.
 */
import { resolve } from 'node:path';

const CONSENT_ACCEPT = /^(accept all|accept|agree|allow all|got it|i understand|terima|setuju|ok)/i;

const escapeAttr = (value) => String(value).replaceAll('"', '\\"');

/** Cookie walls intercept clicks; accept one if it is blocking the way. Failures are ignored. */
export async function dismissConsent(page) {
  for (const scope of ['[data-ui="cookie-consent"]', '#onetrust-banner-sdk', '[aria-label*="ookie" i]', '[class*="cookie" i]', '[role="dialog"]']) {
    const button = page.locator(`${scope} button`).filter({ hasText: CONSENT_ACCEPT }).first();
    try {
      if ((await button.count()) > 0) {
        await button.click({ timeout: 3000 });
        await page.waitForTimeout(300);
        return true;
      }
    } catch {
      // overlay already gone or the button is decorative
    }
  }
  return false;
}

/**
 * Many ATS landing pages reveal the form only after a click ("Apply for this
 * job"). Returns false when the gate never appears so the CLI can exit 4.
 */
export async function openGate(page, text) {
  const gate = page.locator('a, button, [role="button"]').filter({ hasText: new RegExp(String(text), 'i') }).first();
  // React ATS pages render the control after hydration, so wait instead of sampling once.
  try {
    await gate.waitFor({ state: 'visible', timeout: 20_000 });
  } catch {
    return false;
  }
  try {
    await gate.click({ timeout: 15_000 });
  } catch {
    // A late overlay can still swallow the first click.
    await dismissConsent(page);
    await gate.click({ force: true, timeout: 10_000 });
  }
  await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(1500);
  return true;
}

/** Print the form's real controls so a field map can be generated instead of guessed. */
export async function dumpControls(page) {
  return page.$$eval('input, textarea, select', (nodes) =>
    nodes.map((node) => {
      const id = node.id;
      const explicit = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
      const wrapper = node.closest('label');
      return {
        tag: node.tagName.toLowerCase(),
        type: node.type || '',
        name: node.name || '',
        placeholder: node.getAttribute('placeholder') || '',
        ariaLabel: node.getAttribute('aria-label') || '',
        label: (explicit?.innerText || wrapper?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 70),
        required: node.required || node.getAttribute('aria-required') === 'true',
      };
    }),
  );
}

/** Required controls that are still blank, named as a human would see them. */
export async function requiredEmptyControls(page) {
  return page.evaluate(() => {
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
}

/** The real submit control, or null when the form has none. */
export async function findSubmit(page) {
  const button = page.locator('button[type=submit], input[type=submit]').first();
  return (await button.count()) > 0 ? button : null;
}

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

/**
 * Fill a form from a label/name/placeholder map. Fields written as
 * {"__file": "path"} set a file input; submit-like controls are skipped, never
 * clicked, because sending is the caller's explicit decision.
 */
export async function fillForm(page, { fields, fieldsDir }) {
  const result = { filled: [], missed: [], ambiguous: [], skipped: [] };

  for (const [key, raw] of Object.entries(fields)) {
    const value = raw && typeof raw === 'object' && '__file' in raw ? raw.__file : raw;
    const found = await locate(page, key);

    if (!found) {
      result.missed.push(key);
      continue;
    }
    if (found.count > 1) result.ambiguous.push({ field: key, matches: found.count, via: found.via });

    const meta = await found.locator.evaluate((el) => ({
      tag: el.tagName.toLowerCase(),
      type: (el.getAttribute('type') ?? '').toLowerCase(),
    }));

    // Never trigger navigation or sending from the filler.
    if (meta.tag === 'button' || ['submit', 'button', 'image', 'reset'].includes(meta.type)) {
      result.skipped.push({ field: key, reason: `${meta.tag}[type=${meta.type || 'none'}]` });
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
      result.filled.push({ field: key, via: found.via, as: meta.tag === 'select' ? 'select' : meta.type || meta.tag });
    } catch (error) {
      result.missed.push(key);
      result.lastError = `${key}: ${error.message.split('\n')[0]}`;
    }
  }

  return result;
}
