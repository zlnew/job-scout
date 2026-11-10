/**
 * Generic form execution: consent walls, gate clicks, control dumping, and
 * label-based filling. ATS adapters supply the field map; this module owns the
 * browser mechanics and never clicks a submit-like control while filling.
 */
import { resolve } from 'node:path';

const CONSENT_ACCEPT = /^(accept all|accept|agree|allow all|got it|i understand|terima|setuju|ok)/i;

// A normal control fails in seconds; a 30s timeout per field turned one bad map
// into a multi-minute hang. Comboboxes need their own, longer option wait.
const FILL_TIMEOUT = 5_000;
const OPTION_TIMEOUT = 8_000;
const OPTION_SELECTOR = '[role="option"]:visible, [role="listbox"] li:visible, ul[role="listbox"] > *:visible';

const escapeAttr = (value) => String(value).replaceAll('"', '\\"');

// Words that carry no meaning in a question label, so word-based matching ignores them.
const LABEL_STOPWORDS = new Set([
  'who', 'what', 'have', 'with', 'your', 'the', 'and', 'for', 'you', 'does', 'this',
  'that', 'are', 'was', 'were', 'of', 'to', 'in', 'on', 'by', 'form', 'please', 'all',
]);

const labelWords = (value) => String(value).toLowerCase().replaceAll(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);

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
    const isAnswered = (el) => {
      if (el.type === 'file') return Boolean(el.files?.length);
      // A radio group is answered by any member: testing each radio alone reports
      // the unchecked sibling of a group the applicant already answered.
      if (el.type === 'radio') {
        if (el.checked) return true;
        if (el.name && document.querySelector(`input[name="${CSS.escape(el.name)}"]:checked`)) return true;
        const group = el.closest('fieldset, [role="radiogroup"]');
        return Boolean(group?.querySelector('[role="radio"][aria-checked="true"]'));
      }
      if (el.type === 'checkbox') return el.checked;
      return Boolean(String(el.value ?? '').trim());
    };

    const names = [...document.querySelectorAll('input, select, textarea')]
      .filter((el) => el.required || el.getAttribute('aria-required') === 'true')
      .filter((el) => !isAnswered(el))
      .map((el) => el.name || el.id || el.getAttribute('aria-label') || el.type);
    return [...new Set(names)];
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
    if (count === 0) continue;

    // A decoy control can share the label: intl-tel-input puts a "Change country for phone
    // number" button ahead of the phone input, and getByLabel matches both. Always prefer a
    // real form control so the value lands somewhere the form actually submits.
    for (let index = 0; index < Math.min(count, 10); index += 1) {
      const candidate = locator.nth(index);
      try {
        const tag = await candidate.evaluate((el) => el.tagName.toLowerCase());
        if (tag === 'input' || tag === 'select' || tag === 'textarea') return { locator: candidate, via, count };
      } catch {
        // detached node; try the next candidate
      }
    }

    return { locator: locator.first(), via: `${via} (non-control)`, count };
  }

  // A live label can wrap the question in extra wording ("State the names of
  // employees in our company who have family ties with your relatives!"), so the
  // map's shorter label is not a substring of it. Match on every significant word
  // instead, and only when exactly one control matches: ambiguity is a miss, not
  // a guess.
  const words = labelWords(key).filter((word) => word.length > 2 && !LABEL_STOPWORDS.has(word));
  if (words.length > 0) {
    const index = await page
      .evaluate((wanted) => {
        const text = (el) => {
          const ids = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
          const labelled = ids.map((id) => document.getElementById(id)?.innerText ?? '').join(' ');
          const explicit = el.id ? (document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.innerText ?? '') : '';
          const wrapper = el.closest('label')?.innerText ?? '';
          return `${labelled} ${explicit} ${wrapper} ${el.getAttribute('aria-label') ?? ''}`.toLowerCase();
        };
        const nodes = [...document.querySelectorAll('input, select, textarea')];
        const hits = nodes.map((el, at) => [el, at]).filter(([el]) => wanted.every((word) => text(el).includes(word)));
        return hits.length === 1 ? hits[0][1] : -1;
      }, words)
      .catch(() => -1);
    if (index >= 0) return { locator: page.locator('input, select, textarea').nth(index), via: 'label words', count: 1 };
  }
  return null;
}

/**
 * Readonly comboboxes (React select widgets on Workable) ignore `fill()`:
 * they need a click, an option click, and a check that the value moved. Keep
 * the state reader tiny so the verification uses the same fields the widget does.
 */
const comboState = (locator) =>
  locator.evaluate((el) => ({
    value: String(el.value ?? ''),
    active: el.getAttribute('aria-activedescendant') ?? '',
  }));

async function isCombobox(locator) {
  try {
    return await locator.evaluate((el) => {
      if (el.readOnly === true && el.getAttribute('role') === 'combobox') return true;
      if (el.getAttribute('role') === 'combobox') return true;
      if (el.getAttribute('aria-haspopup') === 'listbox') return true;
      // The library wrapper names the widget; a class containing "select" is not a
      // signal, because intl-tel-input's "iti--has-country-selector" phone wrapper
      // matched it and turned the phone input into a combobox that never opened.
      if (el.closest('[data-input-type="select"]')) return true;
      return Boolean(el.closest('[role="combobox"]'));
    });
  } catch {
    return false;
  }
}

/** The option list a widget owns, or null when it opens one elsewhere on the page. */
async function ownedList(page, locator) {
  const id = await locator
    .evaluate((el) => {
      const ids = `${el.getAttribute('aria-controls') ?? ''} ${el.getAttribute('aria-owns') ?? ''}`.trim();
      return ids.split(/\s+/).find((value) => value && document.getElementById(value)) ?? '';
    })
    .catch(() => '');
  return id ? page.locator(`[id="${escapeAttr(id)}"]`) : null;
}

const optionTexts = async (options) =>
  (await options.allInnerTexts()).map((text) => text.replace(/\s+/g, ' ').trim());

/** Exact, then case-insensitive, then prefix, then substring. */
function bestOption(texts, wanted) {
  const lower = wanted.toLowerCase();
  let index = texts.findIndex((text) => text === wanted);
  if (index < 0) index = texts.findIndex((text) => text.toLowerCase() === lower);
  if (index < 0) index = texts.findIndex((text) => text.toLowerCase().startsWith(lower));
  if (index < 0) index = texts.findIndex((text) => text.toLowerCase().includes(lower));
  return index;
}

/**
 * Open a combobox and click the option that best matches `value`: exact text,
 * then case-insensitive, then prefix, then substring. Throws when no option
 * matches so the caller reports the field instead of leaving the dropdown
 * half-set.
 */
async function fillCombobox(page, locator, value) {
  const before = await comboState(locator);
  const wanted = String(value).trim();

  await locator.click({ timeout: FILL_TIMEOUT });
  // Only the opened list is visible; a page-wide selector would otherwise pick a
  // hidden option from another combobox and time out waiting for it. Prefer the
  // listbox this widget owns when it declares one.
  const list = await ownedList(page, locator);
  const options = list ? list.locator('[role="option"]') : page.locator(OPTION_SELECTOR);
  await options.first().waitFor({ state: 'visible', timeout: OPTION_TIMEOUT });

  let texts = await optionTexts(options);
  let index = bestOption(texts, wanted);
  if (index < 0) {
    // A long or virtualised list mounts its tail only once it is scrolled.
    await options.last().scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(300);
    texts = await optionTexts(options);
    index = bestOption(texts, wanted);
  }
  if (index < 0) throw new Error(`no matching option: "${wanted}" (the list offers: ${texts.join(' / ')})`);

  // Workable restores the applicant's draft, so the widget can already hold the
  // right option. Clicking it again leaves the value untouched, which the old
  // check read as a failure on every prefilled question.
  if (before.value.trim().toLowerCase() === texts[index].trim().toLowerCase()) {
    await page.keyboard.press('Escape').catch(() => {});
    return;
  }

  await options.nth(index).click({ timeout: FILL_TIMEOUT });
  // React applies the selection after the click handler returns, not before.
  await page.waitForTimeout(150);

  const after = await comboState(locator);
  const applied = after.value.trim().toLowerCase() === texts[index].trim().toLowerCase();
  if (applied || after.value !== before.value || after.active !== before.active) return;
  throw new Error(`combobox value did not change after selecting "${wanted}"`);
}

/** Where a radio group lives: Workable wraps consent in a fieldset/role=radiogroup. */
async function radioGroupFor(locator) {
  let node = locator;
  for (let depth = 0; depth < 4; depth += 1) {
    const role = await node.evaluate((el) => el.getAttribute('role')).catch(() => null);
    if (role === 'radiogroup') return node;
    node = node.locator('xpath=..');
    const tag = await node.evaluate((el) => el.tagName?.toLowerCase()).catch(() => null);
    if (tag === 'fieldset') return node;
  }
  return null;
}

/** A consent question is a radio group, not a text control: pick the yes/no wording. */
async function fillRadioGroup(page, locator, value) {
  const group = await radioGroupFor(locator);
  if (!group) return false;

  // The clickable is a role=radio wrapper; a plain radio group has only inputs.
  let radios = group.locator('[role="radio"]');
  if ((await radios.count()) === 0) radios = group.locator('input[type="radio"]');

  const matches = (text) => {
    if (value === true) return /^(yes|true|agree|accept)\b/i.test(text);
    if (value === false) return /^(no|false|decline|disagree)\b/i.test(text);
    return text.toLowerCase() === String(value).trim().toLowerCase();
  };

  const count = await radios.count();
  for (let index = 0; index < count; index += 1) {
    const radio = radios.nth(index);
    const text = (await radio.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (!matches(text)) continue;
    await radio.click({ timeout: FILL_TIMEOUT });
    await page.waitForTimeout(150);
    const answered = await group.evaluate((el) =>
      Boolean(el.querySelector('[role="radio"][aria-checked="true"], input[type="radio"]:checked')),
    );
    if (!answered) throw new Error(`the radio group did not take "${text}"`);
    return true;
  }
  throw new Error(`no "${String(value)}" option in the radio group (offers: ${count})`);
}

/**
 * react-datepicker ignores a value set programmatically and keeps only keystrokes;
 * its placeholder names the order the widget expects (MM/DD/YYYY here).
 */
async function fillDate(locator, placeholder, value) {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim());
  if (!iso) return null;
  const order = String(placeholder ?? '').toUpperCase();
  const typed = order.includes('MM/DD/YYYY') ? `${iso[2]}/${iso[3]}/${iso[1]}`
    : order.includes('DD/MM/YYYY') ? `${iso[3]}/${iso[2]}/${iso[1]}`
      : null;
  if (typed === null) return null;

  await locator.click({ timeout: FILL_TIMEOUT });
  await locator.press('ControlOrMeta+a');
  await locator.press('Backspace');
  await locator.pressSequentially(typed, { delay: 30 });
  if (!String(await locator.inputValue()).trim()) throw new Error(`the date field rejected ${typed}`);
  return typed;
}

/**
 * Whether the form itself demands an answer at this control. A miss has to carry
 * this: an unmatched optional control (Workable's "Job Vacancy to Apply" list
 * cannot hold the posted role) must warn, while a required one must refuse.
 * A radio's own `required` can sit on a sibling, so the whole group is inspected.
 */
async function controlRequired(locator) {
  return locator
    .evaluate((el) => {
      const demanded = (node) => node.required || node.getAttribute('aria-required') === 'true';
      if (demanded(el)) return true;
      const group = el.closest('fieldset, [role="radiogroup"]');
      if (group && group.getAttribute('aria-required') === 'true') return true;
      if (el.type !== 'radio') return false;
      if (el.name) {
        const same = `input[type="radio"][name="${CSS.escape(el.name)}"]`;
        return [...document.querySelectorAll(same)].some(demanded);
      }
      return Boolean(group && [...group.querySelectorAll('input[type="radio"]')].some(demanded));
    })
    .catch(() => false);
}

/**
 * Fill a form from a label/name/placeholder map. Fields written as
 * {"__file": "path"} set a file input; submit-like controls are skipped, never
 * clicked, because sending is the caller's explicit decision.
 *
 * Every `missed` entry is `{ field, required }` so the guard can separate a
 * refusal (required) from a warning (optional).
 */
export async function fillForm(page, { fields, fieldsDir }) {
  const result = { filled: [], missed: [], ambiguous: [], skipped: [] };

  for (const [key, raw] of Object.entries(fields)) {
    const value = raw && typeof raw === 'object' && '__file' in raw ? raw.__file : raw;
    const found = await locate(page, key);

    if (!found) {
      // Nothing matched this key, so no control proves the question optional:
      // a stale field map has to refuse rather than pass silently. A control
      // that exists but is optional is the case that only warns.
      result.missed.push({ field: key, required: true });
      continue;
    }
    if (found.count > 1) result.ambiguous.push({ field: key, matches: found.count, via: found.via });

    const meta = await found.locator.evaluate((el) => ({
      tag: el.tagName.toLowerCase(),
      type: (el.getAttribute('type') ?? '').toLowerCase(),
      role: el.getAttribute('role') ?? '',
      placeholder: el.getAttribute('placeholder') ?? '',
    }));

    // Never trigger navigation or sending from the filler.
    if (meta.tag === 'button' || ['submit', 'button', 'image', 'reset'].includes(meta.type)) {
      result.skipped.push({ field: key, reason: `${meta.tag}[type=${meta.type || 'none'}]` });
      continue;
    }

    let as = meta.tag === 'select' ? 'select' : meta.type || meta.tag;
    try {
      if (meta.role === 'radiogroup') {
        await fillRadioGroup(page, found.locator, value);
        as = 'radio';
      } else if (meta.tag === 'select') {
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
      } else if (await isCombobox(found.locator)) {
        // Before `fill()`: a readonly combobox times out on fill and never takes the value.
        await fillCombobox(page, found.locator, value);
        as = 'combobox';
      } else if ((await fillDate(found.locator, meta.placeholder, value)) !== null) {
        as = 'date';
      } else {
        await found.locator.fill(String(value), { timeout: FILL_TIMEOUT });
      }
      result.filled.push({ field: key, via: found.via, as });
    } catch (error) {
      result.missed.push({ field: key, required: await controlRequired(found.locator) });
      result.lastError = `${key}: ${error.message.split('\n')[0]}`;
    }
  }

  return result;
}
