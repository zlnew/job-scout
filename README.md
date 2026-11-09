# job-apply — human-in-the-loop application harness

Fills job application forms in a real browser, screenshots the result, and **never clicks
submit**. A human reviews and sends. Scoring and answer rules live in `answers.md`; the
running record lives in `job-applications.md`.

## First run

```bash
cd job-apply
npm install                     # playwright-core only; browsers are already cached
npm test                        # one deterministic test against fixtures/application.html
node scripts/login.mjs https://www.linkedin.com/login   # log in by hand, close the window
```

`scripts/login.mjs <url>` opens the persistent profile at `./profile` (gitignored — it holds
session cookies). Log in once per site; later runs reuse the session. Credentials are never
scripted or stored by this harness.

## Answer bank (`data/profile.json`)

`data/profile.json` is the machine-readable answer bank: every answer is `{ value, source, scope }`
where `source` is `confirmed` (Maul said it in `answers.md`) or `derived` (computed from
`career.json`). There is no `assumed` source; a question neither file answers is listed in
`blockedTopics` and must be asked instead of guessed. `core/guard.mjs` validates the file
(`loadProfile`) and refuses a submission with missing provenance or a duplicate identity key.

## Cover letter (reusable generator)

```bash
npm run cover -- --company "Kredivo Group" --role "Backend Engineer - Golang (SDE II)" \
  --jd postings/4440204415.txt --angle backend \
  --why "one researched line about this company"
```

Deterministic, not creative: it picks the 2 best-matching bullets from `career.json` (current role
always leads), quotes the skills the JD actually shares with the resume, and carries your `--why`
line verbatim. Angles: `backend`, `platform`, `product`, `fullstack`.

- **No `--why` → exit 1, no file.** A letter cannot be written with a hole where the research goes.
- **JD-only technology is reported as a gap**, never claimed: `gaps in the JD you cannot claim: aws, gcp`.
- Output goes to `cover-letters/<company>-<role>.md` with a header naming the claimed bullets
  and the banned technology. Review it before sending — the generator writes, Maul sends.

## Board (persistent state)

`applications.json` is the store — one record per posting (`company`, `role`, `score`, `status`,
`channel`, `posted`, `applied`, `follow_up`, `url`, `jd`, `notes`). Statuses: `shortlisted`,
`stretch`, `applied`, `interview`, `offer`, `rejected`.

```bash
npm run board            # regenerates board.html from applications.json
```

`board.html` is self-contained (no server, no deps, no CDN) — open it in the browser. Rows sort
by score, statuses are counted at the top, and an `applied` row goes amber once its follow-up is
due (applied + 7 days). `board.html` is generated and gitignored; `applications.json` is the
committed truth. No database on purpose: at 5–10 applications/week `node:sqlite` can import this
file later if trends are ever worth querying.

## Ledger (`core/ledger.mjs`)

The machine state is `discovered → scored → shortlisted → resolved → prepared → submitted →
interview | rejected | offer`, with recoverable `blocked` and terminal `skipped`. Illegal edges
throw, so a double submission cannot pass `applyTransition`. `upsertRecord` merges by the guard's
identity key, and `appendEvent` appends `{ ts, action, key, ... }` lines to `data/events.jsonl`;
`readStore`/`writeStore` own the 2-space JSON and `updated`/`applications` key order.

## ATS adapters (`adapters/`)

An ATS is one module plus one saved form snapshot; core never learns an ATS name. Each adapter
exports `name`, `supportsSubmit`, `detect(url)`, `buildMap(profile, posting)` and optionally
`prepare(page)` / `submit(page)`; `adapters/index.mjs` holds the registry (`findAdapter`), the
generic label-based fallback, and `assertAdapterContract`, which `doctor` will also use.
`buildMap` returns `{ fields, questions, blocked, missing }`: `fields` is what the filler can fill,
`questions` are controls the adapter recognises but cannot answer, `blocked` is the subset matching
a `blockedTopics` key (never answered), and `missing` names profile answers the adapter needs.
Pass the labels you found on the page as `posting.controls` and the map narrows to them, so a
posting that never rendered an Address field does not report a false miss.

```js
import { findAdapter } from './adapters/index.mjs';
const adapter = findAdapter(applyUrl);            // workable | generic
const map = adapter.buildMap(loadProfile(profilePath), posting);
```

Adding an ATS: drop `adapters/<name>.mjs` and `fixtures/ats/<name>/form.html`, register it in
`ADAPTERS` (specific first, generic last), and extend `test/adapters.test.mjs`. Keep
`supportsSubmit: false` unless the adapter understands every required control on that form.

## Find postings (no pasting URLs needed)

```bash
node scripts/sweep.mjs                    # Indonesia, default query set from answers.md
node scripts/sweep.mjs --location Jakarta --pages 2
node scripts/sweep.mjs --jd 8             # + fetch JD bodies to postings/<id>.txt
```

Uses LinkedIn's public (unauthenticated) job endpoints — search cards and JD bodies both.
Filters by title against the rubric, dedupes, ranks by track, writes `postings/sweep-<date>.json`.
Rate limits are real: a 429 on one query is normal, rerun later rather than hammering it.
Scoring the JD text stays with the agent.

## Resolve the apply URL (no pasted ATS links)

```bash
node scripts/resolve.mjs --id 4440204415          # prints a JSON result, writes nothing
node scripts/resolve.mjs --url https://www.linkedin.com/jobs/view/4440204415
node scripts/resolve.mjs --limit 5 --write        # shortlisted rows still missing applyUrl
```

Uses the logged-in persistent profile (or `JOB_APPLY_CDP`) to open the job page, then reports
where the application really happens as `{ id, url, kind, applyUrl, reason }`:

- `ats` — an employer ATS URL, either an "Apply on company site" link or the target of a popup/navigation.
- `easy-apply` — LinkedIn's own form. **Always manual**: the harness never fills or submits it.
- `manual` — no apply control, a timeout, or an ambiguous outcome; check the posting by hand.

`--write` stores `applyUrl`, `applyKind`, and `resolvedAt` on the matching `applications.json`
record and preserves every other field. It only clicks the apply control once to observe where it
goes — it never fills or submits a form. Login/authwall redirects exit 4: re-import cookies.

## Browser resolution

Order: `JOB_APPLY_CHROME` binary → `JOB_APPLY_CHANNEL` → a cached Playwright chromium → **system
Google Chrome**. So a machine with Chrome installed needs no 150MB download. If none is found:
`npm i -D playwright && npx playwright install chromium`.

## Agent here, browser there (SSH tunnel + CDP)

When the agent runs on a headless box but the logged-in browser lives on your laptop, attach to
that browser instead of launching one:

```bash
# 1. laptop: a dedicated Chrome instance you keep open and log into
google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.job-apply-chrome"

# 2. agent machine: forward the port over the tailnet, leave it running
ssh -N -L 9222:127.0.0.1:9222 <you>@<laptop>

# 3. agent machine: every script now drives the real browser
JOB_APPLY_CDP=http://127.0.0.1:9222 npm run sweep -- --jd 8
JOB_APPLY_CDP=http://127.0.0.1:9222 node scripts/fill.mjs --url <ats-url> --fields fields.json --submit
```

`close()` only disconnects — your browser window stays open. Log into the site **in the debugging
instance**, not your everyday Chrome. Keep CDP bound to loopback (`-L` does that); never expose it
to the tailnet directly, since anyone who reaches that port controls the browser.

Zero-build alternative: log in on the laptop, export cookies, `node scripts/import-cookies.mjs`
on this machine.

## Session setup

If this machine has a display, log in interactively:

```bash
npm run login                          # LinkedIn
npm run login -- --site glints         # glints | kalibrr | dealls
```

**Headless server / plain SSH (no display):** a headed browser cannot run there, so `npm run login`
exits with the options instead. Seed the session from a machine that has a browser:

```bash
# 1. laptop: log into the site, export cookies as JSON (Cookie-Editor → Export)
# 2. copy the file over, then:
node scripts/import-cookies.mjs /tmp/li-cookies.json --verify https://www.linkedin.com/feed
```

Accepts Cookie-Editor arrays or Playwright storage-state objects, fixes `SameSite=None` without
`Secure`, floors float expiries, and rejects unusable entries by name. `--verify` proves the session
actually works — it exits `1` and says `NOT logged in` when the site bounces you to a login wall.
Note that cookies are IP/UA sensitive: an imported LinkedIn session can still hit a checkpoint, in
which case run the harness on the machine with the browser.

## Apply to one job

1. Score the posting with the rubric in `answers.md`. Deal-breaker → stop here.
2. Research the company (Glassdoor / Indeed / Jobstreet / ex-employee chatter). Record it.
3. Copy `fields.example.json`, fill it with the real answers from `answers.md`.
4. Prefill and review:

```bash
node scripts/fill.mjs --url <application-url> --fields fields.json --hold
```

The browser stays open with the form filled; read it, fix anything wrong, click submit
yourself, then close the window. Without `--hold` the script fills, screenshots, and exits.

Exit code `1` = `NEEDS_REVIEW`: at least one field could not be matched. The report lists
which — fill those by hand. Never widen the field map to force a match.

5. Add a row to `job-applications.md`.

## Submitting automatically (`--submit`)

```bash
node scripts/fill.mjs --url <ats-url> --fields fields.json --submit
```

Guards, all enforced in code:

- **Refused on `linkedin.com`** (exit 2, no browser launched) — Easy Apply automation risks the account.
- **Refused while any field is unfilled** (exit 3, `submitBlocked` in the report) — nothing is sent half-done.
- **Refused while a required control is still empty** (exit 3).
- Prints `SUBMITTING: <url> — N fields filled, 0 missed` before the click, then screenshots the
  result. Use `--hold` instead when you want to review in the browser first; `--hold` is ignored
  when `--submit` is set.

## What it will not do

- Click submit unless `--submit` is passed explicitly (see above). Without it, nothing is sent.
- Fill a field it cannot match. Unmatched → `NEEDS_REVIEW`, exit 1.
- Guess an answer. Missing answer → ask, then record it in `answers.md`.
- Fabricate experience or screening answers (salary, visas, years per skill).
- Automate LinkedIn Easy Apply (ToS + account risk). Greenhouse/Lever/Ashby single forms
  are the intended target; Workday's multi-step wizard expects manual nudges.
- Store passwords. The profile directory is gitignored for that reason.

## Files

| Path | Role |
|---|---|
| `answers.md` | Scoring rubric, hard filters, reusable form answers, `UNKNOWN` list |
| `applications.json` | Persistent store: every posting with score, status, dates |
| `board.html` | Generated dashboard (gitignored, rebuilt by `npm run board`) |
| `shortlist.md` | Dated sweep results with verdicts |
| `scripts/cover.mjs` | Cover-letter generator (`career.json` + JD → `cover-letters/`) |
| `scripts/board.mjs` | `applications.json` → `board.html` |
| `job-applications.md` | Application log |
| `scripts/sweep.mjs` | LinkedIn public sweep: candidates + JD bodies into `postings/` |
| `scripts/resolve.mjs` | Finds the employer ATS URL for a LinkedIn job (never applies) |
| `scripts/login.mjs` | Persistent-profile session setup (needs a display) |
| `scripts/import-cookies.mjs` | Seed a session from another machine's exported cookies |
| `scripts/fill.mjs` | Prefills a form, screenshots, refuses to submit |
| `scripts/browser.mjs` | Chromium resolution + persistent-context launcher |
| `fields.example.json` | Field-map template |
| `fixtures/`, `test/` | Deterministic test: fills every matched field, reports misses, never submits |
| `screenshots/`, `profile/` | Runtime output, gitignored |
