# job-scout

Four stages, one workflow: **scan → shortlist → apply → report.** No dependencies, no build
step, plain Node. A human runs the same commands an agent runs; state lives in SQLite
(`data/job-scout.db`, built-in `node:sqlite`), and JSON/markdown files are derived exports.

## Quick start

```bash
cd job-scout
npm test            # 56 tests (policy, DB, letters, dashboard, settings, UI), must stay green
npm run migrate     # one-shot: import the legacy JSON files into the DB (idempotent)
npm run reseed-profile          # report what profile.json would change in the DB
npm run reseed-profile -- --apply  # write profile.json into the DB
npm run scan        # stage 1: pull open postings into the DB
npm run shortlist   # stage 2: score + rank into the DB, export data/shortlist.json
npm run report      # stage 4: write out/report-YYYY-MM-DD.md + data/applications.md
npm run dash        # local dashboard on http://127.0.0.1:4970 (see below)
```

Stage 3 is deliberate, per target:

```bash
node bin/apply.mjs ajaib                       # prints the on-site apply link, records intent
node bin/apply.mjs ajaib --email \
  --to denny@example.com --body-file letter.txt # creates a Gmail DRAFT with the CV attached
```

## Why it is shaped this way

**Stage 1 — scan.** Source is [fungsi.id](https://fungsi.id/mcp), an Indonesian job index
exposed as an MCP server (streamable HTTP, read-only, no key). Verified live rather than
assumed. Its `query` matches **titles only** — `golang`, `vue`, `laravel` return nothing;
search role names (`backend`, `full stack`, `software engineer`) and let the descriptions
carry the stack signal.

**Stage 2 — shortlist and score.** `lib/score.mjs` is pure and testable. The policy is not
opinion, it comes from `data/answers.md` (your confirmed answers) and `data/profile.json`
(your facts):

- title must be Backend / Platform / Product / Full-Stack / Software Engineer — others are
  disqualified without scoring;
- a posting asking **5+ years scores 0**, and asks 3–5 is the accepted band;
- salary **below the 12M floor is rejected outright**;
- foreign employers need **full remote** (no relocation);
- postings older than 45 days are penalised and flagged.

**Stage 3 — apply.** Two channels, never guessed. On-site: the script hands you the link and
records `to-apply`. Email: the script creates a **Gmail draft** with the CV attached and
stops. It contains no send path on purpose — mail access is scoped to `gmail.compose`, and an
application leaves the account only when you press send.

**Stage 4 — report.** `out/report-YYYY-MM-DD.md`: decisions, shortlist, what is waiting on
you (drafts to send, links to apply), application history, stale postings, next actions.
It also rewrites `data/applications.md`, a readable mirror of the application log so git
shows the history.

## Dashboard

```bash
npm run dash            # http://127.0.0.1:4970
PORT=5000 npm run dash  # another port
```

Three server-side rendered pages (board, compose, settings), no build step and no npm
dependency. It binds `127.0.0.1` only, because one button can create a Gmail draft.
`JOB_APPLY_DB` points it at another database file, which is how you try it without
touching the real application log.

**One stylesheet for all three pages.** They link `GET /assets/app.css`, which serves the
dark theme by default: near-black page (`#0b0d10`), layered surfaces (`#14181d`,
`#1b2129`), body text `#e8edf2`, muted text `#a8b3c0`, and accent `#7cc0f5`. Body text is
about 16:1 and muted text about 8:1 on the page background. At `>= 900px` the board is a
table; below `899px` each posting becomes a stacked card with 44px tap targets, no
horizontal scrolling, and filters that stack in one column. The header is sticky and
carries the counts, search, filters, `Scan now`, `Compose`, and `Settings`.

The board lists postings joined to their application row when one exists, scored live
with `lib/score.mjs` so it works without running `npm run shortlist` first. All filtering,
ordering, and pagination happen on the server, so the order is stable across pages:
score descending, then published date descending, then title, then id.

| Query parameter | Meaning |
|---|---|
| `page` | 1-based page; out-of-range or garbage values clamp to a real page |
| `per` | `25` (default), `50`, or `100`; anything else falls back to 25 |
| `q` | Text search over title, company, city, and description |
| `min` | Minimum score, 0 to 100 |
| `decision` | `apply`, `review`, `skip`, or `reject` |
| `hideRejected` | `1` hides rejected decisions and rejected application rows |
| `sort` | `score` (default), `newest`, or `title` |

Every pagination link carries the current filters. The pager shows `1–25 of 50`, first,
previous, next, and last, and never returns an empty page for an out-of-range request.

Each posting has a short inline preview plus a native `<details>`/`<summary>` toggle. The
expanded block shows the full description (third-party text, always HTML-escaped, with
paragraph breaks preserved) and the scorer's reasons and flags. It works without
JavaScript and is keyboard accessible.

The top bar links to `Settings` (`GET /settings`), where you edit personal details, work
preferences, compensation, titles, and skills. See [Settings](#settings) below.

| Control | What it does |
|---|---|
| `Scan now` | Runs stage 1 in this process with the same searches as `npm run scan`, then refreshes the counts |
| `Open site` | Opens `posting.url` in a new tab |
| `Letter` | Builds the cover letter from `lib/letter.mjs` and shows it in a panel with a Copy button |
| `Draft mail` | Creates a Gmail draft with the letter and the CV attached |
| `Compose` | Opens the free-form draft form: recipients, subject, body, attachment |
| `Mark ...` | Moves the application to applied, replied, interview, offer, rejected, or closed |

Mark creates the application row when the posting has none yet (`channel: site`,
`status: to-apply`) and then writes the new status, so every transition appends an
`application_events` row.

### Settings

`Settings` in the top bar opens `GET /settings`, grouped as Personal, Work, Compensation,
Titles, and Skills. Each field shows `db` when you edited it there, or `seed` when it still
comes from `data/profile.json`.

**The database is the system of record.** Migration v2 adds `profile_fields(path TEXT
PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT)`, one row per leaf setting, with the
value JSON-encoded so numbers, booleans, arrays, and objects round-trip. The first open of
an empty table walks `data/profile.json` and inserts every leaf path once. `loadProfile()`
now assembles the nested `{value, source, scope}` shape from those rows, so every CLI stage
(`shortlist`, `apply`, `report`, `dash`) reads the DB, not the file.

**Editing the file does nothing by itself.** `data/profile.json` is the seed and is never
deleted, but after the first seed a hand edit is inert until you re-seed explicitly:

```bash
npm run reseed-profile              # dry run: lists added, changed, removed paths
npm run reseed-profile -- --apply   # mirror the file into the DB, source becomes "seed"
```

Seeding never runs again automatically. A re-seed resets the affected rows to `seed`.
The save endpoint is `POST /api/action` with `{action:'settings-save', fields:{path: value,
...}}`. It validates email shape, non-empty full name, integer compensation at or above
zero, `floor <= target`, comma-separated lists (trimmed, deduped), and unknown paths. The
write is one transaction: if any field is invalid it returns 400 naming every offending
path and changes nothing.

### Compose (Draft mail)

`Compose` in the top bar opens `GET /compose`: the same draft operation as a row's
`Draft mail` button, but not tied to one posting, and every field is editable.

| Field | Default |
|---|---|
| `To` | empty, unless the posting publishes an address in its own text |
| `Cc`, `Bcc` | empty, optional |
| `Subject` | empty; with `?posting=<id>` it is the posting title plus your name |
| `Body` | the letter template; with `?posting=<id>` it is `buildLetter` for that posting |
| `Attachment` | absolute path to `profile.work.resumePath` (`public/resume.pdf`) |

`GET /compose?posting=<posting_id>` prefills `To` only from `contactEmail(posting)` (the
address published in the posting text). When the posting publishes none, `To` stays empty
and you paste the real address yourself.

The button posts `{action:'compose-draft', to, cc, bcc, subject, body, attachmentPath,
posting_id?}` to `/api/action` and validates before anything reaches Gmail:

- at least one valid address in `To`, comma or semicolon separated, trimmed, duplicates dropped
- a non-empty `subject`
- a non-empty `body` of at least 40 characters
- `attachmentPath`, when set, must exist and end in `.pdf`; clear it to omit the attachment

Invalid input returns 400 with the reason and never calls Gmail. A Gmail failure returns
502 with the upstream message. On success the page shows the draft id and a link to
`https://mail.google.com/mail/u/0/#drafts`. If `posting_id` matches an existing
application it moves to `drafted` and appends an event; a compose with no matching
application creates no application row.

**It creates a draft and never sends.** You open Gmail and press send.

**Draft mail never sends.** It creates a draft and shows the returned draft id plus the
sentence: "Open Gmail and press send — this tool never sends." You press send.

**The address is never invented.** An address comes from exactly two places: an address
found in the posting's own description, or one you paste into the row's address field. With
neither, the button is disabled and the row says `no address published`. As of the current
50 postings, that is every row: none of them publishes an address.

**Letters are deterministic.** `lib/letter.mjs` composes only profile facts from the DB
(`profile_fields`) and the posting's title/company. `lintLetter` is the guardrail: it flags
a years claim the profile cannot support, an employer that is not in
`profile.employment.employers`, "senior" as a self-description, a technology that is not in
`profile.skills`, and a letter under 120 words. Every generated letter passes its own
linter; the dashboard shows the linter result next to the letter.

## Files

The database is the system of record. Everything else is an input document, a migration
source, or an export.

```
data/job-scout.db       SYSTEM OF RECORD: postings, applications, application_events, profile_fields (gitignored)
data/profile.json       seed for profile_fields (identity, comp floor/target, titles, geo) - not the truth after first seed
data/answers.md         the written policy + answer bank this rubric implements — hand-edited
data/applications.md    export: human-readable application log (committable)
data/shortlist.json     export: scored snapshot, rescored from the DB every run (committable)
data/postings.json      migration input only, not written anymore
data/applications.json  migration input only, not written anymore
out/report-*.md         export: stage 4 report (committable)
```

`data/postings.json` and `data/applications.json` are kept because they hold real history,
but the bins no longer write to them. Import them once with `npm run migrate` (re-running is
safe and reports 0 imported), then treat the DB as truth.

Inspect the DB without any extra tooling:

```bash
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('data/job-scout.db');
console.log(d.prepare('select posting_id,company,role,status,created_at from applications order by id').all())"
sqlite3 data/job-scout.db "select status, count(*) from applications group by status"
sqlite3 data/job-scout.db "select company, role, status, created_at from applications order by id desc limit 10"
```

Writes use WAL plus a 5000 ms busy timeout and transactions, so an agent and a human can
write at the same time without clobbering each other.

Schema changes are tracked in the `migrations` table (see `MIGRATIONS` in `lib/db.mjs`).
Append a new version; never edit an applied one.

## Agent use

Every stage accepts `--json` for machine-readable output, and none of them prompt:

```bash
node bin/scan.mjs --json --query backend --city jakarta
node bin/shortlist.mjs --json --top 5 --apply
node bin/report.mjs --json
```

An agent's job is stage 2 reading and stage 3 writing: read `shortlist.json`, decide, then
either hand back links or write a `letter.txt` and call `apply.mjs --email`. Scoring stays
deterministic so the agent cannot quietly re-rank by vibe.

## Configuration

| Env | Default | Purpose |
|---|---|---|
| `FUNGSI_MCP_URL` | `https://api.fungsi.id/mcp` | scan source |
| `GMAIL_MCP_DIR` | `~/www/secret/gmail_mcp` | OAuth client + token for draft creation |

Credentials live outside this repo. Never commit them, never inline them here.

## Boundaries

- This harness **never sends** email and **never fills application forms** for you.
- `data/answers.md` is the source of policy truth. Change the rubric there first, then
  `lib/score.mjs`, then the test.
- The 7-day Gmail refresh-token expiry (app in "Testing") means draft creation fails with a
  403 once a week until the OAuth app is published.
