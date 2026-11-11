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
  listProfileFields,
  setProfileFields,
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

/** The settings page, grouped for a human. Paths are the profile_fields keys. */
const SETTINGS_GROUPS = [
  {
    title: 'Personal',
    fields: [
      { path: 'identity.fullName', label: 'Full name', kind: 'text' },
      { path: 'identity.firstName', label: 'First name', kind: 'text' },
      { path: 'identity.lastName', label: 'Last name', kind: 'text' },
      { path: 'identity.email', label: 'Email', kind: 'text' },
      { path: 'identity.phone', label: 'Phone', kind: 'text' },
      { path: 'identity.location', label: 'Location', kind: 'text' },
      { path: 'identity.city', label: 'City', kind: 'text' },
      { path: 'identity.country', label: 'Country', kind: 'text' },
      { path: 'identity.links.site', label: 'Website', kind: 'text' },
      { path: 'identity.links.github', label: 'GitHub', kind: 'text' },
      { path: 'identity.links.linkedin', label: 'LinkedIn', kind: 'text' },
      { path: 'identity.links.whatsapp', label: 'WhatsApp', kind: 'text' },
    ],
  },
  {
    title: 'Work',
    fields: [
      { path: 'work.noticePeriod', label: 'Notice period', kind: 'text' },
      { path: 'work.startAvailability', label: 'Start availability', kind: 'text' },
      { path: 'work.resumePath', label: 'Resume path', kind: 'text' },
      { path: 'work.authorizedIn', label: 'Authorized in', kind: 'text' },
      { path: 'work.citizenship', label: 'Citizenship', kind: 'text' },
      { path: 'work.relocate', label: 'Willing to relocate', kind: 'bool' },
      { path: 'work.applicationsLanguage', label: 'Applications language', kind: 'text' },
    ],
  },
  {
    title: 'Compensation',
    fields: [
      { path: 'compensation.currency', label: 'Currency', kind: 'text' },
      { path: 'compensation.floor', label: 'Floor (IDR/month)', kind: 'number' },
      { path: 'compensation.target', label: 'Target (IDR/month)', kind: 'number' },
      { path: 'compensation.targetMin', label: 'Target minimum (IDR/month)', kind: 'number' },
      { path: 'compensation.targetMax', label: 'Target maximum (IDR/month)', kind: 'number' },
    ],
  },
  {
    title: 'Titles',
    fields: [
      { path: 'titles.level', label: 'Level', kind: 'text' },
      { path: 'titles.yearsExperience', label: 'Years of experience', kind: 'number' },
      { path: 'titles.trackOrder', label: 'Track order (JSON)', kind: 'json' },
      { path: 'titles.accepted', label: 'Accepted titles (comma separated)', kind: 'list' },
      { path: 'titles.bareSoftwareEngineer', label: 'Bare "Software Engineer"', kind: 'text' },
    ],
  },
  {
    title: 'Skills',
    fields: [
      { path: 'skills.languages', label: 'Languages', kind: 'list' },
      { path: 'skills.frameworks', label: 'Frameworks & libraries', kind: 'list' },
      { path: 'skills.data', label: 'Data & infrastructure', kind: 'list' },
      { path: 'skills.protocols', label: 'Protocols & APIs', kind: 'list' },
      { path: 'skills.domain', label: 'Domain & practices', kind: 'list' },
    ],
  },
];

const ARRAY_SETTING_PATHS = new Set([
  'titles.accepted',
  'skills.languages',
  'skills.frameworks',
  'skills.data',
  'skills.protocols',
  'skills.domain',
]);
const NUMBER_SETTING_PATHS = new Set([
  'compensation.floor',
  'compensation.target',
  'compensation.targetMin',
  'compensation.targetMax',
  'titles.yearsExperience',
]);

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
      const byScore = (Number(b.verdict.score) || 0) - (Number(a.verdict.score) || 0);
      if (byScore) return byScore;
      const byDate = textCmp(b.posting.published, a.posting.published);
      if (byDate) return byDate;
      const byTitle = textCmp(a.posting.title, b.posting.title);
      if (byTitle) return byTitle;
      return textCmp(a.posting.id, b.posting.id);
    });
}

export function summarize(rows = []) {
  const open = rows.filter(({ app }) => !app || !app.status || OPEN.has(app.status)).length;
  const apply = rows.filter(({ verdict }) => verdict.decision === 'apply').length;
  return { postings: rows.length, open, apply };
}

/** Pagination is server-side: only these page sizes are accepted. */
export const PER_CHOICES = [25, 50, 100];
export const DEFAULT_PER = 25;
const DECISIONS = ['apply', 'review', 'skip', 'reject'];
const SORTS = ['score', 'newest', 'title'];

const text = (value) => String(value ?? '').trim();
const textCmp = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), 'en');

/** Read the board query parameters, clamping every value to something valid. */
export function parseBoardQuery(searchParams = new URLSearchParams()) {
  const rawPer = Number.parseInt(text(searchParams.get('per')), 10);
  const rawPage = Number.parseInt(text(searchParams.get('page')), 10);
  const rawMin = Number.parseInt(text(searchParams.get('min')), 10);
  const decision = text(searchParams.get('decision'));
  const sort = text(searchParams.get('sort'));
  const hide = text(searchParams.get('hideRejected')).toLowerCase();
  return {
    page: Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1,
    per: PER_CHOICES.includes(rawPer) ? rawPer : DEFAULT_PER,
    min: Number.isFinite(rawMin) ? Math.max(0, Math.min(100, rawMin)) : 0,
    decision: DECISIONS.includes(decision) ? decision : '',
    hideRejected: hide === '1' || hide === 'on' || hide === 'true',
    q: text(searchParams.get('q')),
    sort: SORTS.includes(sort) ? sort : 'score',
  };
}

/** Apply the board filters before ordering and pagination. */
export function filterRows(rows = [], { q = '', min = 0, decision = '', hideRejected = false } = {}) {
  const needle = text(q).toLowerCase();
  return rows.filter(({ posting, app, verdict }) => {
    if (min > 0 && (Number(verdict.score) || 0) < min) return false;
    if (decision && verdict.decision !== decision) return false;
    if (hideRejected && (verdict.decision === 'reject' || app?.status === 'rejected')) return false;
    if (needle) {
      const hay = [posting.title, posting.company, posting.city, posting.description]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

/** Stable ordering: score desc, published desc, title, then id as a final tiebreak. */
export function sortRows(rows = [], sort = 'score') {
  return [...rows].sort((a, b) => {
    if (sort === 'newest') {
      const byDate = textCmp(b.posting.published, a.posting.published);
      if (byDate) return byDate;
    }
    if (sort === 'title') {
      const byTitle = textCmp(a.posting.title, b.posting.title);
      if (byTitle) return byTitle;
    }
    const byScore = (Number(b.verdict.score) || 0) - (Number(a.verdict.score) || 0);
    if (byScore) return byScore;
    const byDate = textCmp(b.posting.published, a.posting.published);
    if (byDate) return byDate;
    const byTitle = textCmp(a.posting.title, b.posting.title);
    if (byTitle) return byTitle;
    return textCmp(a.posting.id, b.posting.id);
  });
}

/** Slice a stable, filtered list into one page and clamp out-of-range requests. */
export function paginateRows(rows = [], page = 1, per = DEFAULT_PER) {
  const size = PER_CHOICES.includes(per) ? per : DEFAULT_PER;
  const total = rows.length;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const wanted = Number.parseInt(page, 10);
  const current = Math.min(Math.max(Number.isFinite(wanted) ? wanted : 1, 1), pageCount);
  const start = (current - 1) * size;
  return { page: current, per: size, total, pageCount, start, rows: rows.slice(start, start + size) };
}

/** Build a board URL that carries every active filter into the next page. */
export function boardHref(filters = {}, overrides = {}) {
  const f = { ...filters, ...overrides };
  const params = new URLSearchParams();
  if (f.q) params.set('q', f.q);
  if (f.min) params.set('min', String(f.min));
  if (f.decision) params.set('decision', f.decision);
  if (f.hideRejected) params.set('hideRejected', '1');
  if (f.sort && f.sort !== 'score') params.set('sort', f.sort);
  if (f.per && f.per !== DEFAULT_PER) params.set('per', String(f.per));
  if (f.page && f.page > 1) params.set('page', String(f.page));
  const query = params.toString();
  return query ? `/?${query}` : '/';
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
  const score = Number(verdict.score) || 0;
  return `<span class="chip score-chip" title="Score ${score} of 100">${score}</span>`;
}

function decisionCell(verdict) {
  const decision = verdict.decision || 'skip';
  return `<span class="chip dec d-${escapeHtml(decision)}">${escapeHtml(decision)}</span>`;
}

function statusCell(app) {
  const status = app?.status ? String(app.status) : 'new';
  const slug = status.replace(/[^a-z-]/gi, '');
  return `<span class="chip st st-${slug}">${escapeHtml(status)}</span>`;
}

function statusOptions(app) {
  const current = app?.status || '';
  return STATUSES.map(
    (s) => `<option value="${s}"${s === current ? ' selected' : ''}>${s}</option>`,
  ).join('');
}

/** Escaped, expandable detail block: full description plus the scorer's rationale. */
function detailsHtml(posting, verdict) {
  const description = String(posting.description ?? '').trim();
  const preview = description.replace(/\s+/g, ' ').slice(0, 160);
  const reasons = Array.isArray(verdict.reasons) ? verdict.reasons : [];
  const flags = Array.isArray(verdict.flags) ? verdict.flags : [];
  const list = (items, cls, empty) =>
    items.length
      ? `<ul class="${cls}">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
      : `<p class="${cls} is-empty">${empty}</p>`;
  return `<details class="details">
  <summary class="details-toggle">Description and score details</summary>
  <div class="details-body">
    <p class="desc">${description ? escapeHtml(description) : 'No description was published.'}</p>
    <h3>Why this score</h3>
    ${list(reasons, 'reasons', 'No reasons recorded.')}
    <h3>Flags</h3>
    ${list(flags, 'flags', 'No flags.')}
  </div>
</details>`;
}

function rowHtml({ posting, verdict, app, contact }) {
  const id = escapeHtml(posting.id);
  const title = escapeHtml(posting.title || '(untitled)');
  const company = escapeHtml(posting.company || '—');
  const where = escapeHtml(whereLabel(posting));
  const posted = escapeHtml(posting.published || '—');
  const salary = posting.salary ? escapeHtml(posting.salary) : '<span class="muted">salary not listed</span>';
  const url = safeUrl(posting.url);
  const openSite = url
    ? `<a class="btn" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Open site</a>`
    : '<span class="btn is-off" title="This posting has no usable link.">Open site</span>';
  const text = [posting.title, posting.company, posting.city].filter(Boolean).join(' ').toLowerCase();
  const address = contact || '';

  const description = String(posting.description ?? '').trim();
  const preview = description.replace(/\s+/g, ' ').slice(0, 200);

  return `<article class="job" data-posting-id="${id}" data-score="${Number(verdict.score) || 0}" data-decision="${escapeHtml(verdict.decision)}" data-status="${escapeHtml(app?.status || 'new')}" data-text="${escapeHtml(text)}">
  <div class="job-head">
    <h2 class="job-title">${title}</h2>
    <div class="chips">
      ${scoreCell(verdict)}
      ${decisionCell(verdict)}
      ${statusCell(app)}
    </div>
  </div>
  <p class="job-meta">
    <span class="job-company">${company}</span>
    <span>${where}</span>
    <span>posted ${posted}</span>
    <span class="job-salary">${salary}</span>
  </p>
  ${preview ? `<p class="preview">${escapeHtml(preview)}${description.length > 200 ? '…' : ''}</p>` : ''}
  <div class="job-actions">
    ${openSite}
    <button type="button" class="btn" data-action="letter" data-id="${id}">Letter</button>
    <button type="button" class="btn" data-action="draft" data-id="${id}"${
      address ? '' : ' disabled title="No email address was published in this posting. Paste one to enable."'
    }>Draft mail</button>
    <label class="mark">Status
      <select data-action="status" data-id="${id}" aria-label="Application status for ${title}">
        <option value="">choose</option>
        ${statusOptions(app)}
      </select>
    </label>
  </div>
  <div class="draft-row">
    <label class="addr-wrap" for="addr-${id}"><span class="addr-label">Recipient</span>
      <input class="addr" id="addr-${id}" type="email" value="${escapeHtml(address)}" placeholder="name@company.com" aria-label="Recipient address for ${title}" autocomplete="off">
    </label>
    <span class="hint"${address ? ' hidden' : ''}>No address published in this posting. Paste the real one to enable Draft mail.</span>
  </div>
  ${detailsHtml(posting, verdict)}
</article>`;
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

  document.addEventListener('input', function (event) {
    var input = event.target.closest('input.addr');
    if (!input) return;
    var wrap = input.closest('.job');
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
      var wrap = button.closest('.job');
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
function paginationHtml({ page, pageCount, start, shown, total, filters }) {
  if (!total) return '';
  const from = start + 1;
  const to = start + shown;
  const link = (label, target, disabled, rel) =>
    disabled
      ? `<span class="page-btn is-disabled" aria-disabled="true">${label}</span>`
      : `<a class="page-btn" href="${escapeHtml(boardHref(filters, { page: target }))}"${
          rel ? ` rel="${rel}"` : ''
        }>${label}</a>`;
  return `<nav class="pager" aria-label="Pagination">
  <p class="range">${from}–${to} of ${total}</p>
  <div class="page-links">
    ${link('« First', 1, page <= 1)}
    ${link('‹ Previous', page - 1, page <= 1, 'prev')}
    <span class="page-now">Page ${page} of ${pageCount}</span>
    ${link('Next ›', page + 1, page >= pageCount, 'next')}
    ${link('Last »', pageCount, page >= pageCount)}
  </div>
</nav>`;
}

export function renderPage({
  rows = [],
  summary = {},
  lastReport = null,
  filters = {},
  pager = null,
} = {}) {
  const f = {
    q: '',
    min: 0,
    decision: '',
    hideRejected: false,
    sort: 'score',
    per: DEFAULT_PER,
    page: 1,
    ...filters,
  };
  const s = summarize(rows);
  const counts = {
    postings: summary.postings ?? s.postings,
    open: summary.open ?? s.open,
    apply: summary.apply ?? s.apply,
  };
  const p = pager || {
    page: 1,
    per: rows.length || DEFAULT_PER,
    total: rows.length,
    pageCount: 1,
    start: 0,
  };
  const shown = rows.length;
  const body = shown
    ? rows.map(rowHtml).join('\n')
    : `<p class="empty">No postings match these filters. Press "Scan now" to fetch postings (the same searches as <code>npm run scan</code>).</p>`;
  const report = lastReport
    ? `<a href="/report/${encodeURIComponent(lastReport)}">Last report: ${escapeHtml(lastReport)}</a>`
    : '<span class="muted">No report yet</span>';
  const activeFilters = [f.min > 0, Boolean(f.decision), Boolean(f.hideRejected), f.sort !== 'score'].filter(
    Boolean,
  ).length;
  const decisionOptions = [['', 'all'], ...DECISIONS.map((d) => [d, d])]
    .map(([value, label]) => `<option value="${value}"${f.decision === value ? ' selected' : ''}>${label}</option>`)
    .join('');
  const sortOptions = [['score', 'Score'], ['newest', 'Newest'], ['title', 'Title']]
    .map(([value, label]) => `<option value="${value}"${f.sort === value ? ' selected' : ''}>${label}</option>`)
    .join('');
  const perOptions = PER_CHOICES.map(
    (n) => `<option value="${n}"${p.per === n ? ' selected' : ''}>${n}</option>`,
  ).join('');
  const pagerHtml = paginationHtml({
    page: p.page,
    pageCount: p.pageCount,
    start: p.start,
    shown,
    total: p.total,
    filters: { ...f, page: p.page, per: p.per },
  });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Job board</title>
<link rel="stylesheet" href="/assets/app.css">
</head>
<body>
<header class="top">
  <div class="top-row">
    <div class="head-text">
      <h1>Job board</h1>
      <p class="summary" id="summary">${counts.postings} postings · ${counts.open} open · ${counts.apply} apply</p>
      <p class="report-line">${report}</p>
    </div>
    <div class="tools">
      <a class="btn" href="/compose">Compose</a>
      <a class="btn" href="/settings">Settings</a>
      <button type="button" class="btn primary" id="scan">Scan now</button>
    </div>
  </div>
  <form class="filter-form" method="get" action="/" role="search" aria-label="Filters">
    <div class="search-row">
      <label class="grow" for="q">Search <input id="q" name="q" type="search" value="${escapeHtml(f.q)}" placeholder="title, company, city" autocomplete="off"></label>
      <button type="submit" class="btn primary">Apply</button>
    </div>
    <details class="filters" id="filters">
      <summary>Filters${activeFilters ? ` · ${activeFilters} active` : ''}</summary>
      <div class="filter-grid">
        <label for="min">Min score <input id="min" name="min" type="number" inputmode="numeric" min="0" max="100" step="1" value="${escapeHtml(f.min)}"></label>
        <label for="decision">Decision <select id="decision" name="decision">${decisionOptions}</select></label>
        <label for="sort">Sort <select id="sort" name="sort">${sortOptions}</select></label>
        <label for="per">Per page <select id="per" name="per">${perOptions}</select></label>
        <label class="check" for="hideRejected"><input id="hideRejected" name="hideRejected" type="checkbox" value="1"${f.hideRejected ? ' checked' : ''}> Hide rejected</label>
      </div>
    </details>
  </form>
  <script>
  (function () {
    var box = document.getElementById('filters');
    if (!box) return;
    var wide = window.matchMedia('(min-width: 700px)');
    var manual = false;
    var toggle = box.querySelector('summary');
    if (toggle) toggle.addEventListener('click', function () { manual = true; });
    function sync() { if (!manual) box.open = wide.matches; }
    sync();
    if (wide.addEventListener) wide.addEventListener('change', sync);
  })();
  </script>
</header>

<section class="board" aria-label="Postings">
${body}
${pagerHtml}

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

// ---------- compose ----------

/** Addresses the compose form accepts. One To header, comma/semicolon separated, deduped. */
const COMPOSE_EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
export const MIN_BODY = 40;
const GMAIL_DRAFTS_URL = 'https://mail.google.com/mail/u/0/#drafts';

/** Split a compose address field, reject a malformed token, and drop duplicates. */
export function parseAddressList(value, field = 'to') {
  const tokens = String(value ?? '')
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  for (const token of tokens) {
    if (!COMPOSE_EMAIL_RE.test(token)) {
      throw new HttpError(400, `${field}: "${token}" is not a valid email address`);
    }
    if (!out.includes(token)) out.push(token);
  }
  return out;
}

/** What the compose form shows before a human edits it. Nothing here is invented. */
export function composePrefill(posting = null, profile = {}) {
  const rawName = profile?.identity?.fullName;
  const fullName = rawName && typeof rawName === 'object' ? rawName.value : rawName;
  const to = posting ? contactEmail(posting) || '' : '';
  const subject = posting
    ? [posting.title, fullName].map((v) => String(v ?? '').trim()).filter(Boolean).join(' - ')
    : '';
  return {
    postingId: posting?.id || '',
    to,
    cc: '',
    bcc: '',
    subject,
    body: buildLetter(posting ?? null, profile, to ? { to } : {}),
    attachmentPath: path.resolve(PATHS.resume),
  };
}

/** The compose page: same style as the board, plus the Draft Mail form. */
export function renderComposePage({ prefill = {} } = {}) {
  const value = (v) => escapeHtml(v ?? '');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Draft mail</title>
<link rel="stylesheet" href="/assets/app.css">
</head>
<body>
<header class="top">
  <div>
    <h1>Draft mail</h1>
    <p class="summary">Creates a draft only. You open Gmail and press send.</p>
  </div>
  <span class="spacer"></span>
  <div class="tools">
    <a class="btn" href="/">Back to board</a>
  </div>
</header>

<form class="compose" id="compose" novalidate>
  <input type="hidden" name="posting_id" value="${value(prefill.postingId)}">
  <label class="f" for="to">To
    <input class="f" id="to" name="to" type="text" value="${value(prefill.to)}" placeholder="name@company.com, another@company.com" autocomplete="off">
  </label>
  <label class="f" for="cc">Cc <span class="opt">optional</span>
    <input class="f" id="cc" name="cc" type="text" value="${value(prefill.cc)}" placeholder="comma or semicolon separated" autocomplete="off">
  </label>
  <label class="f" for="bcc">Bcc <span class="opt">optional</span>
    <input class="f" id="bcc" name="bcc" type="text" value="${value(prefill.bcc)}" placeholder="comma or semicolon separated" autocomplete="off">
  </label>
  <label class="f" for="subject">Subject
    <input class="f" id="subject" name="subject" type="text" value="${value(prefill.subject)}" autocomplete="off">
  </label>
  <label class="f" for="body">Body
    <textarea class="f" id="body" name="body" rows="20" spellcheck="true">${value(prefill.body)}</textarea>
  </label>
  <label class="f" for="attachmentPath">Attachment
    <input class="f" id="attachmentPath" name="attachmentPath" type="text" value="${value(prefill.attachmentPath)}" autocomplete="off">
    <span class="hint">A path can be changed, or cleared to omit the attachment. Only a .pdf file that exists is accepted.</span>
  </label>
  <div class="compose-actions">
    <button type="submit" class="btn primary" id="create">Create Gmail draft</button>
    <span class="hint">Creates a draft only. You open Gmail and press send.</span>
  </div>
</form>
<p class="error" id="compose-error" role="alert" hidden></p>

<div class="panel" id="panel" hidden role="status" aria-live="polite">
  <div class="panel-body">
    <div class="panel-head">
      <h2>Draft created</h2>
      <button type="button" class="btn" id="panel-close">Close</button>
    </div>
    <p id="draft-id"></p>
    <p>${DRAFT_NOTICE}</p>
    <p><a href="${GMAIL_DRAFTS_URL}" target="_blank" rel="noopener noreferrer">Open Gmail drafts</a></p>
  </div>
</div>

<script>${COMPOSE_JS}</script>
</body>
</html>`;
}

/**
 * Create a Gmail draft from the compose form. Validation runs first and never reaches
 * Gmail; the injected createDraft is the only write path, and it never sends.
 */
export async function composeDraft(payload = {}, { createDraft = createGmailDraft } = {}) {
  const to = parseAddressList(payload.to, 'to');
  if (!to.length) {
    throw new HttpError(400, 'compose-draft needs at least one recipient address in "to"');
  }
  const cc = parseAddressList(payload.cc, 'cc');
  const bcc = parseAddressList(payload.bcc, 'bcc');

  const subject = String(payload.subject ?? '').trim();
  if (!subject) throw new HttpError(400, 'compose-draft needs a subject');

  const body = String(payload.body ?? '').trim();
  if (!body) throw new HttpError(400, 'compose-draft needs a body');
  if (body.length < MIN_BODY) {
    throw new HttpError(
      400,
      `compose-draft body is too short (${body.length} characters); at least ${MIN_BODY} are required`,
    );
  }

  const rawAttachment = String(payload.attachmentPath ?? '').trim();
  let attachmentPath = null;
  if (rawAttachment) {
    attachmentPath = path.resolve(rawAttachment);
    if (!/\.pdf$/i.test(attachmentPath)) {
      throw new HttpError(400, `attachment must be a .pdf file: "${rawAttachment}"`);
    }
    if (!fs.existsSync(attachmentPath) || !fs.statSync(attachmentPath).isFile()) {
      throw new HttpError(400, `attachment not found: "${rawAttachment}"`);
    }
  }

  const args = { to: to.join(', '), subject, body };
  if (cc.length) args.cc = cc.join(', ');
  if (bcc.length) args.bcc = bcc.join(', ');
  if (attachmentPath) {
    args.attachmentPath = attachmentPath;
    args.attachmentName = path.basename(attachmentPath);
  }

  let draft;
  try {
    draft = await createDraft(args);
  } catch (err) {
    throw new HttpError(502, `Gmail draft failed: ${err.message}`);
  }

  const draftId = draft?.draftId ?? draft?.id ?? null;

  // A compose is not necessarily an application: only an existing row is transitioned.
  let application = null;
  const postingKey = String(payload.posting_id ?? '').trim();
  if (postingKey && listApplications().some((a) => a.posting_id === postingKey)) {
    const updated = upsertApplication({
      posting_id: postingKey,
      status: 'drafted',
      to_addr: to.join(', '),
      subject,
      draft_id: draftId,
    });
    application = { id: updated.id, status: updated.status };
  }

  const result = {
    draftId,
    to: to.join(', '),
    cc: cc.join(', '),
    bcc: bcc.join(', '),
    subject,
    attachment: attachmentPath,
    note: DRAFT_NOTICE,
  };
  if (application) result.application = application;
  return result;
}

const COMPOSE_STYLE = `
.compose { display: flex; flex-direction: column; gap: 12px; max-width: 760px; }
.compose label.f { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #444; }
.compose .f { font: inherit; padding: 6px 8px; border: 1px solid #9a9a9a; border-radius: 4px; background: #fff; color: inherit; }
.compose textarea.f { resize: vertical; min-height: 320px; line-height: 1.5; }
.compose .opt { color: #666; font-weight: 400; }
.compose .hint { color: #555; font-size: 12px; }
.compose-actions { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
.compose .primary { font-weight: 600; }
.error { color: #9c1c1c; }
`;

const COMPOSE_JS = `
(function () {
  var form = document.getElementById('compose');
  var error = document.getElementById('compose-error');
  var panel = document.getElementById('panel');
  var draftId = document.getElementById('draft-id');
  var button = document.getElementById('create');

  function showError(message) {
    error.textContent = message;
    error.hidden = false;
  }

  document.getElementById('panel-close').addEventListener('click', function () {
    panel.hidden = true;
  });

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    error.hidden = true;
    panel.hidden = true;
    button.disabled = true;
    var payload = { action: 'compose-draft' };
    ['to', 'cc', 'bcc', 'subject', 'body', 'attachmentPath', 'posting_id'].forEach(function (name) {
      var field = form.elements[name];
      if (field) payload[name] = field.value;
    });
    try {
      var res = await fetch('/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      var result = await res.json();
      if (!res.ok) {
        showError(result.error || 'Draft not created. Check the fields and try again.');
        return;
      }
      draftId.textContent = 'Draft id: ' + result.draftId;
      panel.hidden = false;
      panel.querySelector('.panel-body').focus();
    } catch (err) {
      showError('Draft not created: ' + err.message);
    } finally {
      button.disabled = false;
    }
  });
})();
`;

// ---------- settings ----------

function normalizeSettingList(value) {
  const items = Array.isArray(value) ? value : String(value ?? '').split(',');
  const seen = new Set();
  const out = [];
  for (const raw of items) {
    const item = String(raw ?? '').trim();
    if (!item) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * Validate and coerce a settings-save payload against the seeded schema.
 * Returns every offending path in `errors`; callers write nothing unless it is empty.
 */
export function validateSettings(fields = {}, known = listProfileFields()) {
  const errors = [];
  const values = {};
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return { values, errors: ['fields: must be an object of path -> value'] };
  }

  for (const [path, raw] of Object.entries(fields)) {
    if (!known[path]) {
      errors.push(`${path}: unknown setting`);
      continue;
    }
    if (ARRAY_SETTING_PATHS.has(path)) {
      values[path] = normalizeSettingList(raw);
      continue;
    }
    if (NUMBER_SETTING_PATHS.has(path)) {
      const text = String(raw ?? '').trim();
      const number = text === '' ? NaN : Number(text);
      if (!Number.isInteger(number) || number < 0) {
        errors.push(`${path}: must be an integer >= 0`);
        continue;
      }
      values[path] = number;
      continue;
    }
    if (path === 'work.relocate') {
      if (raw === true || raw === 'true' || raw === 'on' || raw === 1 || raw === '1') values[path] = true;
      else if (raw === false || raw === 'false' || raw === '' || raw === 0 || raw === '0' || raw == null) {
        values[path] = false;
      } else errors.push(`${path}: must be true or false`);
      continue;
    }
    if (path === 'titles.trackOrder') {
      let parsed = raw;
      if (typeof raw === 'string') {
        try {
          parsed = JSON.parse(raw);
        } catch {
          errors.push(`${path}: must be valid JSON`);
          continue;
        }
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        errors.push(`${path}: must be a JSON object`);
        continue;
      }
      values[path] = parsed;
      continue;
    }
    values[path] = String(raw ?? '').trim();
  }

  if ('identity.email' in values && !EMAIL_RE.test(values['identity.email'])) {
    errors.push('identity.email: not a valid email address');
  }
  if ('identity.fullName' in values && !String(values['identity.fullName']).trim()) {
    errors.push('identity.fullName: must not be empty');
  }

  const effective = (path) => (path in values ? values[path] : known[path]?.value);
  const floor = effective('compensation.floor');
  const target = effective('compensation.target');
  if (Number.isInteger(floor) && Number.isInteger(target) && floor > target) {
    errors.push('compensation.floor: must be <= compensation.target');
    errors.push('compensation.target: must be >= compensation.floor');
  }

  return { values, errors };
}

function renderSettingField(field, info) {
  const id = `f-${field.path.replace(/[^a-z0-9]+/gi, '-')}`;
  const value = info?.value;
  const source = info?.source || 'seed';
  const kind = field.kind;
  let initial;
  let input;

  if (kind === 'bool') {
    initial = value ? 'true' : 'false';
    input = `<input id="${id}" type="checkbox" data-path="${escapeHtml(field.path)}" data-kind="bool" data-initial="${initial}"${value ? ' checked' : ''}>`;
  } else if (kind === 'number') {
    initial = String(value ?? '');
    input = `<input id="${id}" type="number" inputmode="numeric" min="0" step="1" data-path="${escapeHtml(field.path)}" data-kind="number" data-initial="${escapeHtml(initial)}" value="${escapeHtml(initial)}">`;
  } else if (kind === 'list') {
    initial = (Array.isArray(value) ? value : []).join(', ');
    input = `<input id="${id}" type="text" data-path="${escapeHtml(field.path)}" data-kind="list" data-initial="${escapeHtml(initial)}" value="${escapeHtml(initial)}">`;
  } else if (kind === 'json') {
    initial = JSON.stringify(value ?? {});
    input = `<input id="${id}" type="text" data-path="${escapeHtml(field.path)}" data-kind="json" data-initial="${escapeHtml(initial)}" value="${escapeHtml(initial)}">`;
  } else {
    initial = String(value ?? '');
    input = `<input id="${id}" type="text" data-path="${escapeHtml(field.path)}" data-kind="text" data-initial="${escapeHtml(initial)}" value="${escapeHtml(initial)}">`;
  }

  return `<label class="setting" for="${id}"><span class="setting-label">${escapeHtml(field.label)}</span>${input}<span class="src src-${source}"${info?.updated_at ? ` title="updated ${escapeHtml(info.updated_at)}"` : ''}>${source}</span></label>`;
}

const SETTINGS_STYLE = `
.settings fieldset { border: 1px solid #d8d8d8; border-radius: 6px; margin: 0 0 16px; padding: 10px 14px 14px; }
.settings legend { font-weight: 600; padding: 0 4px; }
.settings-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 10px 16px; }
.setting { display: flex; flex-direction: column; gap: 3px; font-size: 13px; }
.setting-label { color: #444; }
.setting input[type=text], .setting input[type=number] { font: inherit; padding: 6px 8px; border: 1px solid #9a9a9a; border-radius: 4px; min-height: 34px; }
.src { font-size: 11px; color: #666; }
.src-db { color: #0b6b3a; }
.savebar { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
#save-status.err { color: #a11; }
.saved { color: #0b6b3a; }
`;

const DARK_STYLE = `
:root {
  color-scheme: dark;
  --bg: #0b0d10;
  --surface: #14181d;
  --surface-2: #1b2129;
  --border: #2a323c;
  --text: #e8edf2;
  --muted: #a8b3c0;
  --accent: #7cc0f5;
  --ok: #6fd39a;
  --warn: #e6c07a;
  --danger: #ef9a9a;
  --radius: 8px;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; padding: 0 16px 48px; font: 15px/1.5 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: var(--text); background: var(--bg); }
a { color: var(--accent); }
h1 { font-size: 20px; margin: 0 0 2px; }
img, pre, table { max-width: 100%; }
.top { position: sticky; top: 0; z-index: 30; margin: 0 -16px 16px; padding: 12px 16px 10px; background: var(--bg); border-bottom: 1px solid var(--border); display: block; }
.top-row { display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: center; justify-content: space-between; }
.top .spacer { flex: 1 1 auto; }
.summary { color: var(--muted); font-variant-numeric: tabular-nums; margin: 2px 0 0; }
.muted { color: var(--muted); }
.head-text { min-width: 0; }
.report-line { margin: 2px 0 0; font-size: 12px; }
.report-line a { display: inline-flex; align-items: center; min-height: 40px; padding: 0 2px; color: var(--muted); text-decoration: underline; text-underline-offset: 2px; overflow-wrap: anywhere; }
.report-line a:hover { color: var(--accent); }
.tools { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.filter-form { display: flex; flex-direction: column; gap: 10px; margin-top: 10px; }
.search-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-end; }
.filter-form label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); min-width: 0; }
.search-row .grow { flex: 1 1 240px; min-width: 0; }
.search-row .btn { flex: 0 0 auto; }
.filter-form input, .filter-form select { width: 100%; min-width: 0; }
.filters { display: block; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
.filters > summary { display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 12px; font-size: 13px; font-weight: 500; cursor: pointer; color: var(--text); }
.filter-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; padding: 0 12px 12px; }
.filter-form .check { flex-direction: row; align-items: center; gap: 8px; font-size: 13px; color: var(--text); min-height: 40px; }
.filter-form .check input { width: auto; min-height: 0; }
button, input, select, textarea { font: inherit; }
button { cursor: pointer; }
.btn, .filter-form input, .filter-form select, .addr, .mark select, .settings input, .settings textarea, .settings select, .compose .f {
  min-height: 40px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px;
  background: var(--surface-2); color: var(--text);
}
.btn { display: inline-flex; align-items: center; justify-content: center; white-space: nowrap; text-decoration: none; }
.btn:hover { border-color: var(--accent); }
.btn:disabled, .btn.is-off { color: var(--muted); background: var(--surface); border-color: var(--border); cursor: not-allowed; opacity: .7; }
.btn.primary { border-color: var(--accent); color: var(--bg); background: var(--accent); font-weight: 600; }
button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.board { display: flex; flex-direction: column; gap: 12px; }
.job { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px; }
.job-head { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; justify-content: space-between; }
.job-title { font-size: 16px; line-height: 1.35; margin: 0; font-weight: 600; overflow-wrap: anywhere; min-width: 0; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.chip { display: inline-flex; align-items: center; justify-content: center; min-height: 24px; padding: 1px 9px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface-2); color: var(--text); font-size: 12px; font-weight: 600; line-height: 1.4; white-space: nowrap; font-variant-numeric: tabular-nums; }
.score-chip { min-width: 40px; background: #0d2436; border-color: #2f6f9f; color: #cfe8ff; }
.d-apply { background: #15361f; border-color: #2f7d4f; color: #a8f0c0; }
.d-review { background: #3a2d10; border-color: #8a6a1f; color: #ffd88a; }
.d-skip { background: #262a2f; border-color: #4a535e; color: #c3ccd6; }
.d-reject { background: #3a1618; border-color: #8f3b3b; color: #ffb0b0; }
.st-new { background: var(--surface-2); border-style: dashed; color: var(--muted); }
.st-applied, .st-replied, .st-interview, .st-offer { background: #102a44; border-color: #3f7fb5; color: #b9dcff; }
.st-rejected { background: #3a1618; border-color: #8f3b3b; color: #ffb0b0; }
.st-closed { background: #262a2f; border-color: #4a535e; color: #c3ccd6; }
.job-meta { display: flex; flex-wrap: wrap; gap: 2px 14px; margin: 6px 0 0; font-size: 13px; color: var(--muted); }
.job-company { color: var(--text); font-weight: 500; }
.job-salary { font-variant-numeric: tabular-nums; }
.job-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 10px; }
.mark { display: inline-flex; gap: 6px; align-items: center; font-size: 12px; color: var(--muted); }
.draft-row { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; margin-top: 8px; }
.addr-wrap { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 12px; color: var(--muted); }
.addr { width: 180px; max-width: 100%; }
.hint { font-size: 12px; color: var(--warn); }
.title-text { font-weight: 600; }
.preview { margin: 4px 0 0; color: var(--muted); font-weight: 400; font-size: 13px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.details { margin-top: 12px; border-top: 1px solid var(--border); padding-top: 4px; }
.details-toggle { display: flex; align-items: center; gap: 8px; min-height: 40px; color: var(--accent); cursor: pointer; font-weight: 500; font-size: 13px; }
.details-body { margin: 4px 0 0; padding: 12px 14px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); }
.details-body h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 12px 0 4px; }
.details-body h3:first-of-type { margin-top: 10px; }
.desc { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-weight: 400; color: var(--muted); font-size: 14px; line-height: 1.55; max-height: 40vh; overflow: auto; }
.reasons, .flags { margin: 0; padding-left: 18px; }
.flags li { color: var(--warn); }
.reasons li, .flags li { margin: 2px 0; }
.is-empty { color: var(--muted); margin: 0; }
.dec { white-space: nowrap; font-variant-numeric: tabular-nums; }
.d-apply { color: var(--ok); }
.d-review { color: var(--warn); }
.d-skip { color: var(--muted); }
.d-reject { color: var(--danger); }
.st { font-size: 12px; padding: 2px 8px; border: 1px solid var(--border); border-radius: 999px; white-space: nowrap; color: var(--muted); }
.st-new { border-style: dashed; }
.st-applied, .st-replied, .st-interview, .st-offer { color: var(--accent); border-color: var(--accent); }
.st-rejected { color: var(--danger); border-color: var(--danger); }
.mark { display: inline-flex; gap: 5px; align-items: center; font-size: 12px; color: var(--muted); }
.empty { padding: 18px 8px; color: var(--muted); }
.pager { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between; margin: 16px 0 8px; }
.range { margin: 0; color: var(--muted); font-variant-numeric: tabular-nums; }
.page-links { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.page-btn { display: inline-flex; align-items: center; min-height: 40px; padding: 0 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--text); text-decoration: none; }
.page-btn:hover { border-color: var(--accent); }
.page-btn.is-disabled { color: var(--muted); opacity: .55; }
.page-now { color: var(--muted); padding: 0 6px; font-variant-numeric: tabular-nums; }
.panel[hidden] { display: none; }
.panel { position: fixed; inset: 0; z-index: 50; background: rgba(0, 0, 0, .65); display: flex; align-items: center; justify-content: center; padding: 20px; }
.panel-body { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); max-width: 760px; width: 100%; max-height: 86vh; overflow: auto; padding: 16px 18px; }
.panel-head { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; }
.panel-head h2 { font-size: 15px; margin: 0 0 6px; }
#panel-note { margin: 0 0 10px; color: var(--muted); }
#panel-text { white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 10px; margin: 0 0 10px; }
.panel-actions { display: flex; gap: 8px; }
.compose { display: flex; flex-direction: column; gap: 14px; max-width: 760px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; }
.compose label.f { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: var(--muted); }
.compose .f { width: 100%; }
.compose label.f { background: none; border: 0; padding: 0; border-radius: 0; }
.compose textarea.f { resize: vertical; min-height: 320px; line-height: 1.55; }
.compose .opt { color: var(--muted); font-weight: 400; }
.compose .hint { color: var(--muted); font-size: 12px; }
.compose-actions { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
.error { color: var(--danger); }
.settings fieldset { border: 1px solid var(--border); border-radius: var(--radius); margin: 0 0 16px; padding: 12px 14px 16px; background: var(--surface); }
.settings legend { font-weight: 600; padding: 0 6px; }
.settings-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
.setting { display: flex; flex-direction: column; gap: 5px; font-size: 13px; min-width: 0; }
.setting-label { color: var(--muted); }
.settings input, .settings textarea, .settings select, .setting input[type=text], .setting input[type=number] { width: 100%; min-width: 0; }
.settings textarea { min-height: 100px; resize: vertical; }
.src { display: inline-flex; align-self: flex-start; font-size: 11px; padding: 1px 6px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface-2); color: var(--muted); }
.src-db { color: var(--ok); }
.savebar { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
#save-status.err { color: var(--danger); }
.saved { color: var(--ok); }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
@media (max-width: 899px) {
  body { padding: 0 12px 40px; }
  .top { margin: 0 -12px 12px; padding: 10px 12px 8px; }
  .top-row { align-items: stretch; flex-direction: column; }
  .tools { flex-wrap: wrap; }
  .filter-form { gap: 8px; }
  .search-row { flex-wrap: wrap; }
  .search-row .btn { flex: 0 0 auto; }
  .filter-grid { grid-template-columns: 1fr; }
  .job { padding: 12px; }
  .job-actions .btn, .job-actions .mark { flex: 1 1 auto; }
  .job-actions .mark select { width: 100%; }
  .addr-wrap { width: 100%; }
  .addr { width: 100%; }
  .btn, .page-btn, .addr, .mark select, .compose .f, .settings input, .settings textarea, .settings select, summary.details-toggle { min-height: 44px; }
  .page-links { width: 100%; }
  .page-btn { flex: 1 1 auto; justify-content: center; }
  .settings-grid { grid-template-columns: 1fr; }
  .compose textarea.f { min-height: 240px; }
}
`;

export const APP_CSS = [STYLE, COMPOSE_STYLE, SETTINGS_STYLE, DARK_STYLE].join('\n');

const SETTINGS_CLIENT_JS = `
(function () {
  var form = document.getElementById('settings');
  var status = document.getElementById('save-status');
  function encoded(el) {
    if (el.dataset.kind === 'bool') return el.checked ? 'true' : 'false';
    return el.value;
  }
  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    status.textContent = '';
    status.className = '';
    var fields = {};
    var changed = 0;
    form.querySelectorAll('[data-path]').forEach(function (el) {
      var now = encoded(el);
      if (now === el.dataset.initial) return;
      fields[el.dataset.path] = now;
      changed += 1;
    });
    if (!changed) {
      status.textContent = 'Nothing to save.';
      return;
    }
    try {
      var res = await fetch('/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'settings-save', fields: fields })
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) {
        status.className = 'err';
        status.textContent = data.error || ('Save failed (' + res.status + ')');
        return;
      }
      location.href = '/settings?saved=1';
    } catch (err) {
      status.className = 'err';
      status.textContent = err.message;
    }
  });
})();
`;

/** Read values from the DB (never the file) and offer them for editing. */
export function renderSettingsPage({ fields = listProfileFields(), saved = false } = {}) {
  const groups = SETTINGS_GROUPS.map(
    (group) => `
    <fieldset>
      <legend>${escapeHtml(group.title)}</legend>
      <div class="settings-grid">
        ${group.fields.map((field) => renderSettingField(field, fields[field.path])).join('')}
      </div>
    </fieldset>`,
  ).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Settings</title>
<link rel="stylesheet" href="/assets/app.css">
</head>
<body>
<header class="top">
  <div>
    <h1>Settings</h1>
    <p class="summary">Stored in SQLite. data/profile.json is only the seed now.</p>
  </div>
  <span class="spacer"></span>
  <div class="tools">
    <a class="btn" href="/">Back to board</a>
    <a class="btn" href="/compose">Compose</a>
  </div>
</header>
${saved ? '<p class="saved" role="status">Settings saved.</p>' : ''}
<p id="save-status" role="status"></p>
<form class="settings" id="settings" novalidate>
${groups}
  <div class="savebar">
    <button class="btn" type="submit">Save settings</button>
    <p class="hint">“db” means edited here; “seed” means it still comes from data/profile.json. Reseed the file with <code>npm run reseed-profile -- --apply</code>.</p>
  </div>
</form>
<script>${SETTINGS_CLIENT_JS}</script>
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

async function handleAction(req, res, deps = {}) {
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
    case 'compose-draft':
      result = await composeDraft(body, deps);
      break;
    case 'settings-save': {
      if (!body.fields || typeof body.fields !== 'object' || Array.isArray(body.fields)) {
        throw new HttpError(400, 'settings-save needs a "fields" object');
      }
      const { values, errors } = validateSettings(body.fields, listProfileFields());
      if (errors.length) throw new HttpError(400, errors.join('; '));
      result = setProfileFields(values);
      break;
    }
    default:
      throw new HttpError(
        400,
        `unknown action "${String(body.action)}"; expected one of scan, status, letter, draft, compose-draft, settings-save`,
      );
  }
  sendJson(res, 200, result);
}

/**
 * Build the request handler. `createDraft` is injected so tests can stub the only
 * Gmail write path; the default is the real createGmailDraft.
 */
export function createHandler({ createDraft = createGmailDraft } = {}) {
  return async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${HOST}`);

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const filters = parseBoardQuery(url.searchParams);
        const { rows, summary, lastReport } = boardSnapshot();
        const ordered = sortRows(filterRows(rows, filters), filters.sort);
        const pager = paginateRows(ordered, filters.page, filters.per);
        return sendHtml(
          res,
          renderPage({
            rows: pager.rows,
            summary,
            lastReport,
            filters: { ...filters, page: pager.page, per: pager.per },
            pager,
          }),
        );
      }
      if (req.method === 'GET' && url.pathname === '/assets/app.css') {
        res.writeHead(200, {
          'Content-Type': 'text/css; charset=utf-8',
          'Cache-Control': 'public, max-age=300',
          'X-Content-Type-Options': 'nosniff',
        });
        return res.end(APP_CSS);
      }
      if (req.method === 'GET' && url.pathname === '/compose') {
        const wanted = String(url.searchParams.get('posting') || '').trim();
        let posting = null;
        if (wanted) {
          posting = getPosting(wanted);
          if (!posting) throw new HttpError(404, `no posting with id "${wanted}"`);
        }
        const profile = loadProfile();
        return sendHtml(res, renderComposePage({ prefill: composePrefill(posting, profile) }));
      }
      if (req.method === 'GET' && url.pathname === '/settings') {
        return sendHtml(res, renderSettingsPage({ saved: url.searchParams.get('saved') === '1' }));
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
        return await handleAction(req, res, { createDraft });
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
