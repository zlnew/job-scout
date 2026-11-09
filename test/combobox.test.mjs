import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fillForm } from '../core/execute.mjs';

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
const fixture = ({ validate = true } = {}) => `
<!doctype html>
<html><body>
  <label for="nationality">Nationality</label>
  <div class="select__container">
    <input id="nationality" role="combobox" readonly aria-expanded="false" aria-controls="nationality-list" value="" />
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
      input.addEventListener('click', () => { list.hidden = false; input.setAttribute('aria-expanded', 'true'); });
      list.addEventListener('click', (event) => {
        const option = event.target.closest('[role="option"]');
        if (!option) return;
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
  assert.deepEqual(result.missed, ['Nationality']);
  assert.match(result.lastError, /Nationality: no matching option: "Martian"/);
  assert.equal(await page.locator('#nationality').inputValue(), '', 'no option was clicked, so nothing was half-set');
});

test('a combobox that ignores the option click is missed, never silently passed', async () => {
  const page = await open(fixture({ validate: false }));
  const result = await fillForm(page, { fields: { Nationality: 'Indonesian' } });

  assert.deepEqual(result.filled, [], 'an unchanged control is not a filled field');
  assert.deepEqual(result.missed, ['Nationality']);
  assert.match(result.lastError, /Nationality: combobox value did not change/);
  assert.equal(await page.locator('#nationality').inputValue(), '');
});
