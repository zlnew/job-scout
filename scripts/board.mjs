/**
 * Regenerate board.html from applications.json — a self-contained page (no server, no deps).
 *
 *   node scripts/board.mjs [--out board.html] [--today 2026-11-09]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './browser.mjs';
import { STATES } from '../core/ledger.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const FOLLOW_UP_DAYS = 7;
// Display order follows the ledger state machine so the board can never invent a status.
const STATUS_ORDER = STATES.filter((state) => state !== 'discovered');

const esc = (value) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const followUpOf = (app) => {
  if (app.follow_up) return app.follow_up;
  if (!app.applied) return null;
  const date = new Date(`${app.applied}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + FOLLOW_UP_DAYS);
  return date.toISOString().slice(0, 10);
};

const statusRank = (status) => {
  const index = STATUS_ORDER.indexOf(status);
  return index === -1 ? STATUS_ORDER.length : index;
};

export function buildBoard({ applications, today = new Date().toISOString().slice(0, 10) }) {
  const rows = [...applications].sort((a, b) => {
    const scoreA = a.score ?? -1;
    const scoreB = b.score ?? -1;
    if (scoreB !== scoreA) return scoreB - scoreA;
    return String(a.company).localeCompare(String(b.company));
  });

  const counts = {};
  for (const app of applications) counts[app.status ?? 'unknown'] = (counts[app.status ?? 'unknown'] ?? 0) + 1;

  const chips = STATUS_ORDER.filter((status) => counts[status])
    .map((status) => `<div class="chip"><span class="n">${counts[status]}</span><span class="l">${status}</span></div>`)
    .join('');

  const body = rows
    .map((app) => {
      const due = followUpOf(app);
      const isDue = due !== null && app.status === 'submitted' && due <= today;
      const cells = [
        `<td class="score">${app.score ?? '—'}</td>`,
        `<td class="company">${esc(app.company)}</td>`,
        `<td>${esc(app.role)}</td>`,
        `<td><span class="status s-${esc(app.status ?? 'unknown')}">${esc(app.status ?? '—')}</span></td>`,
        `<td>${esc(app.channel ?? '')}</td>`,
        `<td class="date">${esc(app.posted ?? '')}</td>`,
        `<td class="date">${esc(app.applied ?? '')}</td>`,
        `<td class="date">${esc(due ?? '')}${isDue ? ' <b class="late">due</b>' : ''}</td>`,
        `<td class="notes">${esc(app.notes ?? '')}</td>`,
        `<td>${app.url ? `<a href="${esc(app.url)}" target="_blank" rel="noreferrer">open</a>` : ''}</td>`,
      ];
      return `    <tr class="${isDue ? 'row due' : 'row'}">\n      ${cells.join('\n      ')}\n    </tr>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Job applications — ${esc(today)}</title>
<style>
  :root { color-scheme: dark; --bg:#16181d; --fg:#e6e6e6; --dim:#8b919c; --line:#2a2e36; --acc:#8fd694; --warn:#e0a458; }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px; background:var(--bg); color:var(--fg); font:14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  h1 { font-size:15px; font-weight:600; letter-spacing:.04em; text-transform:uppercase; color:var(--dim); margin:0 0 16px; }
  .chips { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:20px; }
  .chip { border:1px solid var(--line); border-radius:4px; padding:6px 10px; display:flex; gap:8px; align-items:baseline; }
  .chip .n { font-size:18px; color:var(--acc); }
  .chip .l { color:var(--dim); font-size:11px; letter-spacing:.08em; text-transform:uppercase; }
  table { width:100%; border-collapse:collapse; }
  th { text-align:left; font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:var(--dim); font-weight:500; padding:8px 10px; border-bottom:1px solid var(--line); }
  td { padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  .row:hover td { background:#1c1f26; }
  .score { font-size:16px; color:var(--acc); width:56px; }
  .company { font-weight:600; white-space:nowrap; }
  .date { color:var(--dim); white-space:nowrap; font-size:12px; }
  .notes { color:var(--dim); font-size:12px; max-width:340px; }
  .status { font-size:11px; letter-spacing:.06em; text-transform:uppercase; padding:2px 6px; border-radius:3px; border:1px solid var(--line); }
  .s-applied { color:var(--acc); border-color:var(--acc); }
  .s-interview, .s-offer { color:#7cc4e8; border-color:#7cc4e8; }
  .s-rejected { color:#6a6f78; }
  .due td { background:#241d16; }
  .late { color:var(--warn); font-size:11px; text-transform:uppercase; }
  a { color:#7cc4e8; text-decoration:none; }
  footer { margin-top:16px; color:var(--dim); font-size:11px; }
</style>
</head>
<body>
<h1>Job applications — ${esc(today)}</h1>
<div class="chips">${chips}</div>
<table>
  <thead>
    <tr><th>Score</th><th>Company</th><th>Role</th><th>Status</th><th>Channel</th><th>Posted</th><th>Applied</th><th>Follow-up</th><th>Notes</th><th></th></tr>
  </thead>
  <tbody>
${body}
  </tbody>
</table>
<footer>Generated from applications.json by scripts/board.mjs — rows highlighted once a follow-up is due (applied + ${FOLLOW_UP_DAYS} days).</footer>
</body>
</html>
`;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  const storePath = resolve(args.store ?? resolve(ROOT, 'applications.json'));
  const store = JSON.parse(readFileSync(storePath, 'utf8'));
  const out = resolve(args.out ?? resolve(ROOT, 'board.html'));
  const html = buildBoard({ applications: store.applications ?? [], today: args.today });
  writeFileSync(out, html);
  console.log(`${html.length}b → ${out} (${(store.applications ?? []).length} applications)`);
}
