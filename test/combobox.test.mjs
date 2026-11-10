import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fillForm, requiredEmptyControls } from '../core/execute.mjs';

const SCRATCH = mkdtempSync(join(tmpdir(), 'combobox-'));
// browser.mjs resolves its persistent profile at import time; keep state off the repo.
process.env.JOB_APPLY_PROFILE = join(SCRATCH, 'profile');
const { launch } = await import('../scripts/browser.mjs');

let context = null;

async function open(html) {
  context ??= await launch({ headless: true });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.setContent(html);
  return page;
}

/** A readonly combobox: clicking opens the list, clicking an option sets the value. */
const fixture = ({ validate = true, prefill = '' } = {}) => `
<!doctype html>
<html><body>
  <label for="nationality">Nationality</label>
  <div class="select__container">
    <input id="nationality" role="combobox" readonly aria-expanded="false" aria-controls="nationality-list" value="${prefill}" />
    <ul id="nationality-list" role="listbox" hidden>
      <li role="option">Indonesian</li>
      <li role="option">Malaysian</li>
    </ul>
  </div>
  <script>
    // IIFE: setContent reuses the realm, so top-level consts would clash on a second load.
    (() => {
      const input = document.getElementById('nationality');
      const list = document.getElementById('nationality-list');
      window.__optionClicks = 0;
      input.addEventListener('click', () => { list.hidden = false; input.setAttribute('aria-expanded', 'true'); });
      list.addEventListener('click', (event) => {
        const option = event.target.closest('[role="option"]');
        if (!option) return;
        window.__optionClicks += 1;
        // A broken widget closes the list but never applies the selection.
        if (${validate}) {
          input.value = option.textContent;
          input.setAttribute('aria-activedescendant', 'option-' + option.textContent);
        }
        list.hidden = true;
      });
    })();
  </script>
</body></html>`;

test.after(async () => {
  await context?.close();
  rmSync(SCRATCH, { recursive: true, force: true });
});

test('a readonly combobox is filled by clicking the matching option and verified', async () => {
  const page = await open(fixture());
  const result = await fillForm(page, { fields: { Nationality: 'Indonesian' } });

  assert.deepEqual(result.missed, []);
  assert.deepEqual(result.filled.map((entry) => entry.field), ['Nationality']);
  assert.equal(result.filled[0].as, 'combobox');
  assert.equal(await page.locator('#nationality').inputValue(), 'Indonesian');
  assert.equal(await page.locator('#nationality').getAttribute('aria-activedescendant'), 'option-Indonesian');
});

test('an unmatched value is missed with the option reason and leaves the value empty', async () => {
  const page = await open(fixture());
  const result = await fillForm(page, { fields: { Nationality: 'Martian' } });

  assert.deepEqual(result.filled, []);
  assert.deepEqual(result.missed, [{ field: 'Nationality', required: false }]);
  assert.match(result.lastError, /Nationality: no matching option: "Martian"/);
  assert.equal(await page.locator('#nationality').inputValue(), '', 'no option was clicked, so nothing was half-set');
});

test('a combobox that ignores the option click is missed, never silently passed', async () => {
  const page = await open(fixture({ validate: false }));
  const result = await fillForm(page, { fields: { Nationality: 'Indonesian' } });

  assert.deepEqual(result.filled, [], 'an unchanged control is not a filled field');
  assert.deepEqual(result.missed, [{ field: 'Nationality', required: false }]);
  assert.match(result.lastError, /Nationality: combobox value did not change/);
  assert.equal(await page.locator('#nationality').inputValue(), '');
});

test('a combobox already holding the matching option is accepted without a second click', async () => {
  // Workable restores the applicant's draft, so the widget can already be right.
  const page = await open(fixture({ prefill: 'Indonesian' }));
  const result = await fillForm(page, { fields: { Nationality: 'Indonesia' } });

  assert.deepEqual(result.missed, [], 'a prefilled draft is not a failure');
  assert.equal(result.filled[0].as, 'combobox');
  assert.equal(await page.evaluate(() => window.__optionClicks), 0, 'the correct value is not clicked again');
  assert.equal(await page.locator('#nationality').inputValue(), 'Indonesian', 'the prefix match keeps the real option text');
});

/** A long list that mounts its tail only when scrolled, like a virtualised dropdown. */
const scrollFixture = () => `
<!doctype html>
<html><body>
  <label for="notice">Notice Period</label>
  <input id="notice" role="combobox" readonly aria-expanded="false" aria-controls="notice-list" value="" />
  <ul id="notice-list" role="listbox" hidden style="max-height:22px;overflow:auto"></ul>
  <script>
    (() => {
      const input = document.getElementById('notice');
      const list = document.getElementById('notice-list');
      const rest = ['2 Months', '3 Months'];
      const append = (texts) => {
        for (const text of texts) {
          const option = document.createElement('li');
          option.setAttribute('role', 'option');
          option.textContent = text;
          list.append(option);
        }
      };
      input.addEventListener('click', () => {
        if (list.hidden) { append(['Immediately', '1 Month']); list.hidden = false; }
      });
      list.addEventListener('scroll', () => { if (list.scrollTop > 0 && rest.length > 0) append(rest.splice(0)); });
      list.addEventListener('click', (event) => {
        const option = event.target.closest('[role="option"]');
        if (!option) return;
        input.value = option.textContent;
        list.hidden = true;
      });
    })();
  </script>
</body></html>`;

test('an option that mounts only after scrolling is still found', async () => {
  const page = await open(scrollFixture());
  const result = await fillForm(page, { fields: { 'Notice Period': '3 months' } });

  assert.deepEqual(result.missed, []);
  assert.equal(await page.locator('#notice').inputValue(), '3 Months');
});

/** react-datepicker discards any value that arrived without keystrokes. */
const dateFixture = () => `
<!doctype html>
<html><body>
  <label for="dob">Birth Date</label>
  <input id="dob" name="dob" placeholder="MM/DD/YYYY" />
  <script>
    (() => {
      const el = document.getElementById('dob');
      let typed = false;
      el.addEventListener('keydown', () => { typed = true; });
      el.addEventListener('input', () => { if (!typed) el.value = ''; });
    })();
  </script>
</body></html>`;

test('an ISO date is typed in the order the widget expects', async () => {
  const page = await open(dateFixture());
  await page.locator('#dob').fill('2002-04-03');
  assert.equal(await page.locator('#dob').inputValue(), '', 'the fixture rejects a programmatic value, like the live widget');

  const result = await fillForm(page, { fields: { 'Birth Date': '2002-04-03' } });

  assert.deepEqual(result.missed, []);
  assert.equal(result.filled[0].as, 'date');
  assert.equal(await page.locator('#dob').inputValue(), '04/03/2002');
});

/** A consent question: a radiogroup labelled by the whole consent sentence. */
const consentFixture = () => `
<!doctype html>
<html><body>
  <span id="consent_label">By submitting this form, you affirm that all personal data is true.</span>
  <fieldset role="radiogroup" aria-labelledby="consent_label" data-ui="CA_44774">
    <div role="radio" aria-checked="false" tabindex="0" aria-labelledby="consent_label yes_label">
      <label><input type="radio" name="CA_44774" value="true" required aria-hidden="true" tabindex="-1"><span id="yes_label">YES</span></label>
    </div>
    <div role="radio" aria-checked="false" tabindex="0" aria-labelledby="consent_label no_label">
      <label><input type="radio" name="CA_44774" value="false" required aria-hidden="true" tabindex="-1"><span id="no_label">NO</span></label>
    </div>
  </fieldset>
  <script>
    (() => {
      const radios = [...document.querySelectorAll('[role="radio"]')];
      for (const wrapper of radios) {
        wrapper.addEventListener('click', () => {
          for (const other of radios) other.setAttribute('aria-checked', 'false');
          wrapper.setAttribute('aria-checked', 'true');
        });
      }
    })();
  </script>
</body></html>`;

test('a consent radio group is answered by its yes/no wording, not filled as text', async () => {
  const page = await open(consentFixture());
  const result = await fillForm(page, { fields: { 'By submitting this form': true } });

  assert.deepEqual(result.missed, []);
  assert.equal(result.filled[0].as, 'radio');
  assert.equal(await page.locator('[role="radio"]').first().getAttribute('aria-checked'), 'true');
  assert.deepEqual(await requiredEmptyControls(page), [], 'the answered group is no longer a required-empty control');
});

test('an unanswered radio group is reported once, not once per radio', async () => {
  const page = await open(consentFixture());

  assert.deepEqual(await requiredEmptyControls(page), ['CA_44774']);
});

test('a label that only wraps the manifest wording still resolves by its significant words', async () => {
  const page = await open(`
<!doctype html><html><body>
  <span id="ties_label">State the names of employees in our company who have family ties with your relatives! (If yes, please mention the name, position, and your relationship.)</span>
  <textarea name="CA_44769" aria-labelledby="ties_label" required></textarea>
</body></html>`);
  const result = await fillForm(page, { fields: { 'Employees who have family ties with your relatives': 'None' } });

  assert.deepEqual(result.missed, []);
  assert.equal(result.filled[0].via, 'label words');
  assert.equal(await page.locator('textarea').inputValue(), 'None');
});

test('word matching refuses to pick between two controls that both mention it', async () => {
  const page = await open(`
<!doctype html><html><body>
  <span id="ties_a">Employees with family ties with your relatives?</span>
  <textarea name="CA_1" aria-labelledby="ties_a"></textarea>
  <span id="ties_b">Other employees with family ties with your relatives?</span>
  <textarea name="CA_2" aria-labelledby="ties_b"></textarea>
</body></html>`);
  const result = await fillForm(page, { fields: { 'Employees who have family ties with your relatives': 'None' } });

  assert.deepEqual(result.filled, []);
  assert.deepEqual(
    result.missed,
    [{ field: 'Employees who have family ties with your relatives', required: true }],
    'ambiguity blocks instead of guessing',
  );
  assert.equal(await page.locator('textarea').first().inputValue(), '');
  assert.equal(await page.locator('textarea').nth(1).inputValue(), '');
});

test('a control the form does not render is still reported, never silently passed', async () => {
  const page = await open('<label for="city">City</label><input id="city" />');
  const result = await fillForm(page, { fields: { Address: 'Bekasi, Indonesia', City: 'Bekasi' } });

  assert.deepEqual(result.missed, [{ field: 'Address', required: true }]);
  assert.equal(await page.locator('#city').inputValue(), 'Bekasi');
});
