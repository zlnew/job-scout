#!/usr/bin/env node
// Local dashboard for the job-apply harness.
//
//   npm run dash            # http://127.0.0.1:4970
//   JOB_APPLY_PORT=5000 npm run dash
//
// node:http only: no framework, no build step, no npm dependency. It binds the
// loopback interface, because it can create a Gmail draft. It never sends mail and
// it never guesses a recipient address: an address comes from the posting text or
// from a human paste, otherwise the Draft button stays disabled.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PATHS, loadProfile, whereLabel, postingId } from '../lib/store.mjs';
import {
  openDb,
  closeDb,
  listPostings,
  listApplications,
  getPosting,
  upsertPostings,
  upsertApplication,
} from '../lib/db.mjs';
import { scoreJob } from '../lib/score.mjs';
import { scanFungsi, createGmailDraft } from '../lib/sources.mjs';
import { buildLetter, lintLetter } from '../lib/letter.mjs';
import { DEFAULT_SEARCHES } from '../lib/searches.mjs';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 4970;

/** Statuses the Mark control may write. The full lifecycle lives in bin/track.mjs. */
export const STATUSES = ['applied', 'replied', 'interview', 'offer', 'rejected', 'closed'];
const OPEN = new Set(['to-apply', 'drafted', 'applied', 'replied', 'interview']);
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const DRAFT_NOTICE = 'Open Gmail and press send — this tool never sends.';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- helpers ----------

export function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

/** Only http(s) links are rendered; anything else becomes a plain, dead-free label. */
function safeUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The only place an address may come from: the posting's own text. There is no
 * guessing, no domain inference, and no fallback. Postings that publish nothing
 * (all 50 current ones) get null, and the dashboard says so.
 */
export function contactEmail(posting = {}) {
  const text = String(posting.description ?? '');
  const m = text.match(EMAIL_IN_TEXT);
  return m ? m[0] : null;
}

export function normalizeAddress(value) {
  const raw = String(value ?? '').trim();
  return EMAIL_RE.test(raw) ? raw : null;
}

// ---------- board model ----------

/** Join postings to their application row and score each posting live. */
export function buildBoard({ postings = [], applications = [], profile = {} } = {}) {
  const byPosting = new Map();
  for (const app of applications) {
    if (app?.posting_id && !byPosting.has(app.posting_id)) byPosting.set(app.posting_id, app);
  }
  return postings
    .map((posting) => {
      const id = posting.id || postingId(posting);
      const verdict = scoreJob(posting, profile);
      const app = byPosting.get(id) || null;
      return { posting: { ...posting, id }, verdict, app, contact: contactEmail(posting) };
    })
    .sort((a, b) => {
      if (b.verdict.score !== a.verdict.score) return b.verdict.score - a.verdict.score;
      return String(b.posting.published || '').localeCompare(String(a.posting.published || ''));
    });
}

export function summarize(rows = []) {
  const open = rows.filter(({ app }) => !app || !app.status || OPEN.has(app.status)).length;
  const apply = rows.filter(({ verdict }) => verdict.decision === 'apply').length;
  return { postings: rows.length, open, apply };
}

export function lastReportFile(dir = PATHS.out) {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => /^report-[\w.-]+\.md$/.test(f))
      .sort();
    return files.length ? files[files.length - 1] : null;
  } catch {
    return null;
  }
}

// ---------- rendering ----------

function scoreCell(verdict) {
  const decision = escapeHtml(verdict.decision);
  return `<span class="dec d-${decision}"><strong>${Number(verdict.score) || 0}</strong> ${decision}</span>`;
}

function statusCell(app) {
  const status = app?.status ? String(app.status) : 'new';
  const slug = status.replace(/[^a-z-]/gi, '');
  return `<span class="st st-${slug}">${escapeHtml(status)}</span>`;
}

function statusOptions(app) {
  const current = app?.status || '';
  return STATUSES.map(
    (s) => `<option value="${s}"${s === current ? ' selected' : ''}>${s}</option>`,
  ).join('');
}

function rowHtml({ posting, verdict, app, contact }) {
  const id = escapeHtml(posting.id);
  const title = escapeHtml(posting.title || '(untitled)');
  const company = escapeHtml(posting.company || '—');
  const where = escapeHtml(whereLabel(posting));
  const posted = escapeHtml(posting.published || '—');
  const salary = posting.salary ? escapeHtml(posting.salary) : '—';
  const url = safeUrl(posting.url);
  const openSite = url
    ? `<a class="btn" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Open site</a>`
    : '<span class="btn is-off" title="This posting has no usable link.">Open site</span>';
  const text = [posting.title, posting.company, posting.city].filter(Boolean).join(' ').toLowerCase();
  const address = contact || '';

  return `<tr data-score="${Number(verdict.score) || 0}" data-decision="${escapeHtml(verdict.decision)}" data-status="${escapeHtml(app?.status || 'new')}" data-text="${escapeHtml(text)}">
  <td class="c-score">${scoreCell(verdict)}</td>
  <td class="c-title">${title}</td>
  <td class="c-company">${company}</td>
  <td class="c-where">${where}</td>
  <td class="c-date">${posted}</td>
  <td class="c-salary">${salary}</td>
  <td class="c-status">${statusCell(app)}</td>
  <td class="c-actions">
    <div class="actions">
      ${openSite}
      <button type="button" class="btn" data-action="letter" data-id="${id}">Letter</button>
      <span class="draft">
        <input class="addr" type="email" value="${escapeHtml(address)}" placeholder="recipient address" aria-label="Recipient address for ${title}" autocomplete="off">
        <button type="button" class="btn" data-action="draft" data-id="${id}"${
          address ? '' : ' disabled title="No email address was published in this posting. Paste one to enable."'
        }>Draft mail</button>
        <span class="hint"${address ? ' hidden' : ''}>no address published</span>
      </span>
      <label class="mark">Mark
        <select data-action="status" data-id="${id}" aria-label="Application status for ${title}">
          <option value="">choose</option>
          ${statusOptions(app)}
        </select>
      </label>
    </div>
  </td>
</tr>`;
}

const STYLE = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; padding: 16px 20px 40px; font: 14px/1.45 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #1b1b1b; background: #fff; }
h1 { font-size: 18px; margin: 0 0 4px; }
a { color: #0a4f8a; }
.top { display: flex; flex-wrap: wrap; gap: 12px; align-items: baseline; border-bottom: 1px solid #d8d8d8; padding-bottom: 10px; margin-bottom: 12px; }
.top .spacer { flex: 1 1 auto; }
.summary { color: #444; font-variant-numeric: tabular-nums; }
.tools { display: flex; gap: 10px; align-items: center; }
.filters { display: flex; flex-wrap: wrap; gap: 14px; align-items: end; margin-bottom: 12px; }
.filters label { display: flex; flex-direction: column; gap: 3px; font-size: 12px; color: #444; }
.filters input, .filters select, .btn, .addr, .mark select { font: inherit; padding: 5px 8px; border: 1px solid #9a9a9a; border-radius: 4px; background: #fff; color: inherit; min-height: 32px; }
.filters .check { flex-direction: row; align-items: center; gap: 6px; font-size: 13px; color: #1b1b1b; }
.filters .check input { min-height: 0; }
button { cursor: pointer; }
.btn { white-space: nowrap; text-decoration: none; display: inline-block; }
.btn:disabled { color: #6b6b6b; border-color: #b9b9b9; background: #f2f2f2; cursor: not-allowed; }
.btn.is-off { color: #6b6b6b; border-color: #c8c8c8; background: #f7f7f7; cursor: default; }
button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid #0a4f8a; outline-offset: 1px; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid #e4e4e4; vertical-align: top; }
th { font-size: 12px; text-transform: uppercase; letter-spacing: 0.03em; color: #555; background: #fafafa; position: sticky; top: 0; }
td.c-title { font-weight: 600; }
td.c-score, td.c-date, td.c-salary { white-space: nowrap; font-variant-numeric: tabular-nums; }
td.c-actions { min-width: 430px; }
.actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.draft { display: inline-flex; gap: 4px; align-items: center; flex-wrap: wrap; }
.addr { width: 170px; }
.hint { font-size: 11px; color: #6b4a00; }
.dec { white-space: nowrap; font-variant-numeric: tabular-nums; }
.d-apply { color: #0b6b3a; }
.d-review { color: #8a5a00; }
.d-skip { color: #555; }
.d-reject { color: #a11; }
.st { font-size: 12px; padding: 1px 6px; border: 1px solid #bbb; border-radius: 10px; white-space: nowrap; }
.st-new { color: #555; border-style: dashed; }
.st-applied, .st-replied, .st-interview, .st-offer { color: #0b4f8a; border-color: #7aa7cf; }
.st-rejected { color: #a11; border-color: #d99; }
.st-closed { color: #555; }
.mark { display: inline-flex; gap: 5px; align-items: center; font-size: 12px; color: #444; }
.empty { padding: 18px 8px; color: #444; }
.panel[hidden] { display: none; }
.panel { position: fixed; inset: 0; background: rgba(0,0,0,0.45); display: flex; align-items: center; justify-content: center; padding: 20px; }
.panel-body { background: #fff; border-radius: 6px; max-width: 760px; width: 100%; max-height: 86vh; overflow: auto; padding: 16px 18px; }
.panel-head { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; }
.panel-head h2 { font-size: 15px; margin: 0 0 6px; }
#panel-note { margin: 0 0 10px; color: #333; }
#panel-text { white-space: pre-wrap; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; background: #f7f7f7; border: 1px solid #e0e0e0; border-radius: 4px; padding: 10px; margin: 0 0 10px; }
.panel-actions { display: flex; gap: 8px; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
@media (max-width: 900px) {
  body { padding: 12px; }
  table, thead, tbody, tr, td { display: block; }
  thead { display: none; }
  tr { border: 1px solid #ddd; border-radius: 6px; margin-bottom: 10px; padding: 6px; }
  td { border: 0; padding: 3px 2px; }
  td.c-actions { min-width: 0; }
}
`;

const CLIENT_JS = `
(function () {
  var $ = function (sel) { return document.querySelector(sel); };
  var panel = $('#panel');
  var panelTitle = $('#panel-title');
  var panelNote = $('#panel-note');
  var panelText = $('#panel-text');
  var copyBtn = $('#copy');
  var reloadBtn = $('#reload');

  function openPanel(title, note, text, canCopy, canReload) {
    panelTitle.textContent = title;
    panelNote.textContent = note || '';
    panelNote.hidden = !note;
    panelText.textContent = text || '';
    panelText.hidden = !text;
    copyBtn.hidden = !canCopy;
    reloadBtn.hidden = !canReload;
    panel.hidden = false;
    panel.querySelector('.panel-body').focus();
  }

  function closePanel() {
    panel.hidden = true;
  }

  $('#panel-close').addEventListener('click', closePanel);
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !panel.hidden) closePanel();
  });
  copyBtn.addEventListener('click', async function () {
    try {
      await navigator.clipboard.writeText(panelText.textContent);
      copyBtn.textContent = 'Copied';
      setTimeout(function () { copyBtn.textContent = 'Copy'; }, 1500);
    } catch (err) {
      var range = document.createRange();
      range.selectNodeContents(panelText);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      copyBtn.textContent = 'Press Ctrl+C';
    }
  });
  reloadBtn.addEventListener('click', function () { location.reload(); });

  async function post(payload) {
    var res = await fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    var json = await res.json().catch(function () {
      return { error: 'The server returned a non-JSON response (' + res.status + ').' };
    });
    if (!res.ok) throw new Error(json.error || ('Request failed with ' + res.status));
    return json;
  }

  var rows = Array.prototype.slice.call(document.querySelectorAll('tbody tr[data-score]'));

  function applyFilters() {
    var q = $('#q').value.trim().toLowerCase();
    var min = Number($('#min').value || 0);
    var decision = $('#decision').value;
    var hideRejected = $('#hideRejected').checked;
    var shown = 0;
    rows.forEach(function (row) {
      var text = row.dataset.text || '';
      var score = Number(row.dataset.score || 0);
      var ok = true;
      if (q && text.indexOf(q) === -1) ok = false;
      if (ok && score < min) ok = false;
      if (ok && decision && row.dataset.decision !== decision) ok = false;
      if (ok && hideRejected && (row.dataset.decision === 'reject' || row.dataset.status === 'rejected')) ok = false;
      row.hidden = !ok;
      if (ok) shown += 1;
    });
    $('#empty').hidden = shown !== 0 || rows.length === 0;
  }

  ['q', 'min', 'decision', 'hideRejected'].forEach(function (id) {
    var el = document.getElementById(id);
    el.addEventListener('input', applyFilters);
    el.addEventListener('change', applyFilters);
  });
  if (rows.length) applyFilters();

  document.addEventListener('input', function (event) {
    var input = event.target.closest('input.addr');
    if (!input) return;
    var wrap = input.closest('.draft');
    var button = wrap.querySelector('button[data-action="draft"]');
    var hint = wrap.querySelector('.hint');
    var has = input.value.trim().length > 0;
    button.disabled = !has;
    button.title = has ? '' : 'No email address was published in this posting. Paste one to enable.';
    if (hint) hint.hidden = has;
  });

  document.addEventListener('click', async function (event) {
    var button = event.target.closest('button[data-action]');
    if (!button) return;
    var action = button.dataset.action;
    var id = button.dataset.id;

    if (action === 'letter') {
      button.disabled = true;
      try {
        var out = await post({ action: 'letter', id: id });
        var note = out.company + ' · ' + (out.lint.ok ? 'linter: clean' : 'linter: ' + out.lint.violations.join(' | '));
        openPanel('Cover letter: ' + out.title, note, out.letter, true, false);
      } catch (err) {
        openPanel('Could not build the letter', err.message, '', false, false);
      } finally {
        button.disabled = false;
      }
      return;
    }

    if (action === 'draft') {
      var wrap = button.closest('.draft');
      var input = wrap.querySelector('input.addr');
      var to = input.value.trim();
      if (!to) {
        openPanel('Draft mail needs an address', 'No recipient address was published in this posting. Paste the real address from the posting first.', '', false, false);
        return;
      }
      button.disabled = true;
      var label = button.textContent;
      button.textContent = 'Drafting...';
      try {
        var created = await post({ action: 'draft', id: id, to: to });
        openPanel('Draft created', '${'Open Gmail and press send — this tool never sends.'}', 'Draft id: ' + created.draft_id + '\\nTo: ' + created.to, true, true);
      } catch (err) {
        openPanel('Could not create the draft', err.message, '', false, false);
      } finally {
        button.disabled = false;
        button.textContent = label;
      }
    }
  });

  document.addEventListener('change', async function (event) {
    var select = event.target.closest('select[data-action="status"]');
    if (!select || !select.value) return;
    select.disabled = true;
    try {
      await post({ action: 'status', id: select.dataset.id, status: select.value });
      location.reload();
    } catch (err) {
      select.disabled = false;
      openPanel('Could not change the status', err.message, '', false, false);
    }
  });

  $('#scan').addEventListener('click', async function () {
    var button = $('#scan');
    button.disabled = true;
    button.textContent = 'Scanning...';
    try {
      var out = await post({ action: 'scan' });
      openPanel('Scan finished', out.scanned + ' postings scanned · ' + out.added + ' added · ' + out.updated + ' updated · ' + out.total + ' on the board', '', false, true);
    } catch (err) {
      openPanel('Scan failed', err.message, '', false, false);
    } finally {
      button.disabled = false;
      button.textContent = 'Scan now';
    }
  });
})();
`;

/** Server-rendered board. Every third-party string goes through escapeHtml. */
export function renderPage({ rows = [], summary = {}, lastReport = null } = {}) {
  const s = summarize(rows);
  const counts = {
    postings: summary.postings ?? s.postings,
    open: summary.open ?? s.open,
    apply: summary.apply ?? s.apply,
  };
  const body = rows.length
    ? rows.map(rowHtml).join('\n')
    : `<tr><td colspan="8" class="empty">No postings yet. Press "Scan now" to run the scan stage (the same searches as <code>npm run scan</code>).</td></tr>`;
  const report = lastReport
    ? `<a href="/report/${encodeURIComponent(lastReport)}">Last report: ${escapeHtml(lastReport)}</a>`
    : '<span class="summary">No report yet</span>';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Job board</title>
<style>${STYLE}</style>
</head>
<body>
<header class="top">
  <div>
    <h1>Job board</h1>
    <p class="summary" id="summary">${counts.postings} postings · ${counts.open} open · ${counts.apply} apply</p>
  </div>
  <span class="spacer"></span>
  <div class="tools">
    ${report}
    <button type="button" class="btn" id="scan">Scan now</button>
  </div>
</header>

<section class="filters" aria-label="Filters">
  <label for="q">Search <input id="q" type="search" placeholder="title, company, city" autocomplete="off"></label>
  <label for="min">Min score <input id="min" type="number" inputmode="numeric" min="0" max="100" step="1" value="0"></label>
  <label for="decision">Decision
    <select id="decision">
      <option value="">all</option>
      <option value="apply">apply</option>
      <option value="review">review</option>
      <option value="skip">skip</option>
      <option value="reject">reject</option>
    </select>
  </label>
  <label class="check" for="hideRejected"><input id="hideRejected" type="checkbox"> Hide rejected</label>
</section>

<table>
  <thead>
    <tr><th>Score</th><th>Title</th><th>Company</th><th>Where</th><th>Posted</th><th>Salary</th><th>Status</th><th>Actions</th></tr>
  </thead>
  <tbody>
${body}
  </tbody>
</table>
<p id="empty" class="empty" hidden>No postings match these filters.</p>

<div class="panel" id="panel" hidden role="dialog" aria-modal="true" aria-labelledby="panel-title" tabindex="-1">
  <div class="panel-body" tabindex="-1">
    <div class="panel-head">
      <h2 id="panel-title">Panel</h2>
      <button type="button" class="btn" id="panel-close">Close</button>
    </div>
    <p id="panel-note" hidden></p>
    <pre id="panel-text" hidden></pre>
    <div class="panel-actions">
      <button type="button" class="btn" id="copy" hidden>Copy</button>
      <button type="button" class="btn" id="reload" hidden>Reload board</button>
    </div>
  </div>
</div>

<script>${CLIENT_JS}</script>
</body>
</html>`;
}

// ---------- actions ----------

/**
 * Move a posting to a status. If the posting has no application row yet it is created
 * with channel "site" and status "to-apply" first, so the transition always has a row
 * (and therefore an event) to land on.
 */
export function applyStatus(id, status, profile = loadProfile()) {
  const postingId = String(id ?? '').trim();
  if (!postingId) throw new HttpError(400, 'action "status" needs a posting id');
  if (!STATUSES.includes(status)) {
    throw new HttpError(400, `unknown status "${String(status)}"; expected one of ${STATUSES.join(', ')}`);
  }
  const posting = getPosting(postingId);
  if (!posting) throw new HttpError(404, `no posting with id "${postingId}"`);

  const existing = listApplications().find((a) => a.posting_id === postingId);
  let created = false;
  if (!existing) {
    const verdict = scoreJob(posting, profile);
    upsertApplication({
      posting_id: postingId,
      company: posting.company,
      role: posting.title,
      channel: 'site',
      status: 'to-apply',
      score: verdict.score,
      url: posting.url,
      posted: posting.published,
    });
    created = true;
  }
  const result = upsertApplication({ posting_id: postingId, status });
  return {
    ok: true,
    id: postingId,
    status: result.status,
    previous_status: result.previous_status,
    status_changed: result.status_changed,
    application_id: result.id,
    created,
  };
}

export function letterFor(id, profile = loadProfile()) {
  const postingId = String(id ?? '').trim();
  if (!postingId) throw new HttpError(400, 'action "letter" needs a posting id');
  const posting = getPosting(postingId);
  if (!posting) throw new HttpError(404, `no posting with id "${postingId}"`);
  const letter = buildLetter(posting, profile, {});
  const lint = lintLetter(letter, profile, { ignore: [posting.title] });
  return { ok: true, id: postingId, title: posting.title, company: posting.company, letter, lint };
}

/**
 * Create a Gmail draft. The address must come from the posting text or from the
 * pasted value; with neither, this refuses with 400 and no Gmail call is made.
 */
export async function draftFor(id, to) {
  const postingId = String(id ?? '').trim();
  if (!postingId) throw new HttpError(400, 'action "draft" needs a posting id');
  const posting = getPosting(postingId);
  if (!posting) throw new HttpError(404, `no posting with id "${postingId}"`);

  const pasted = String(to ?? '').trim();
  const address = pasted ? normalizeAddress(pasted) : contactEmail(posting);
  if (pasted && !address) {
    throw new HttpError(400, `"${pasted}" is not a valid email address`);
  }
  if (!address) {
    throw new HttpError(
      400,
      'No recipient address. This posting publishes none and none was pasted, and this tool never invents one. Paste the real address from the posting into the address field first.',
    );
  }

  const profile = loadProfile();
  const letter = buildLetter(posting, profile, { to: address });
  const subject = `Application: ${posting.title}${posting.company ? ` at ${posting.company}` : ''}`;

  let draft;
  try {
    draft = await createGmailDraft({
      to: address,
      subject,
      body: letter,
      attachmentPath: PATHS.resume,
      attachmentName: 'resume.pdf',
    });
  } catch (err) {
    throw new HttpError(502, `Gmail draft failed: ${err.message}`);
  }

  const draftId = draft?.draftId ?? draft?.id ?? null;
  const existing = listApplications().find((a) => a.posting_id === postingId);
  if (!existing) {
    const verdict = scoreJob(posting, profile);
    upsertApplication({
      posting_id: postingId,
      company: posting.company,
      role: posting.title,
      channel: 'email',
      status: 'drafted',
      score: verdict.score,
      to_addr: address,
      subject,
      draft_id: draftId,
      url: posting.url,
      posted: posting.published,
    });
  } else {
    upsertApplication({ posting_id: postingId, status: 'drafted', to_addr: address, subject, draft_id: draftId });
  }

  return { ok: true, id: postingId, draft_id: draftId, to: address, subject, note: DRAFT_NOTICE };
}

async function runScan() {
  const jobs = await scanFungsi(DEFAULT_SEARCHES, { details: true });
  openDb();
  const { added, updated } = upsertPostings(jobs);
  return { ok: true, scanned: jobs.length, added, updated, total: listPostings().length };
}

export function boardSnapshot() {
  openDb();
  const profile = loadProfile();
  const rows = buildBoard({ postings: listPostings(), applications: listApplications(), profile });
  return { rows, summary: summarize(rows), lastReport: lastReportFile() };
}

// ---------- HTTP ----------

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendHtml(res, html) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(html);
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', (err) => reject(err));
  });
}

async function handleAction(req, res) {
  const text = await readBody(req);
  let body;
  try {
    body = JSON.parse(text || '{}');
  } catch {
    throw new HttpError(400, 'request body is not valid JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'request body must be a JSON object');
  }

  let result;
  switch (body.action) {
    case 'scan':
      result = await runScan();
      break;
    case 'status':
      result = applyStatus(body.id, body.status);
      break;
    case 'letter':
      result = letterFor(body.id);
      break;
    case 'draft':
      result = await draftFor(body.id, body.to);
      break;
    default:
      throw new HttpError(
        400,
        `unknown action "${String(body.action)}"; expected one of scan, status, letter, draft`,
      );
  }
  sendJson(res, 200, result);
}

export function createHandler() {
  return async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${HOST}`);

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const { rows, summary, lastReport } = boardSnapshot();
        return sendHtml(res, renderPage({ rows, summary, lastReport }));
      }
      if (req.method === 'GET' && url.pathname === '/favicon.ico') {
        res.writeHead(204).end();
        return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/report/')) {
        const name = decodeURIComponent(url.pathname.slice('/report/'.length));
        if (!/^report-[\w.-]+\.md$/.test(name)) throw new HttpError(404, 'no such report');
        const file = path.join(PATHS.out, name);
        if (!fs.existsSync(file)) throw new HttpError(404, `no report named "${name}"`);
        const body = fs.readFileSync(file);
        res.writeHead(200, {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Length': body.length,
        });
        return res.end(body);
      }
      if (url.pathname === '/api/action') {
        if (req.method !== 'POST') throw new HttpError(405, `method ${req.method} not allowed on /api/action`);
        return await handleAction(req, res);
      }
      throw new HttpError(404, `no route for ${url.pathname}`);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error('[dash]', err);
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, status, { error: err.message || 'server error' });
    }
  };
}

export function startServer({ port = Number(process.env.JOB_APPLY_PORT) || DEFAULT_PORT, host = HOST } = {}) {
  const server = http.createServer(createHandler());
  server.listen(port, host, () => {
    console.log(`job-apply dashboard: http://${host}:${port}`);
    console.log(`database: ${PATHS.db}`);
  });
  const shutdown = () => {
    try {
      closeDb();
    } catch {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return server;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) startServer();
