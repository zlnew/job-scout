# AGENTS.md — job-scout

Single-user, local-only job application harness. Scans postings, scores them, drafts letters and Gmail drafts. The human presses send.

## Commands

```bash
npm test                  # the done criterion, node --test over 7 suites
npm run scan              # fetch and store postings
npm run shortlist         # score and shortlist
npm run dash              # local dashboard
npm run report            # application report
npm run migrate           # apply DB migrations
npm run reseed-profile    # reseed profile from career.json
```

## Invariants

1. **Nothing here sends email.** Draft creation only: `users.drafts.create`. Sending is a human action.
2. **Letters must pass the linter.** Template output and compose prefill both go through it. A self-described "senior" title is rejected.
3. **The database is the system of record** for profile and preferences. `data/*.json` is a seed, never the truth.
4. **Never weaken a test to pass `npm test`.** No skipped suites, no loosened assertions.
5. Nothing is pushed. Local commits only.

## Branching

`feature/` or `fix/` off `main`. Commits: `type(scope): summary`.

## Done

`npm test` exits 0. In the workspace, `./dev task done <card>` runs it and records the receipt.
