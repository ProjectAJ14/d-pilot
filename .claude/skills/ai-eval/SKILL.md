---
name: ai-eval
description: Run D-Pilot's AI prompt evaluation (scripts/ai-eval) and compare against a baseline. Use whenever you change an AI prompt, dialect guidance, the AI model/deployment, server/services/azure-openai.ts, the generate-query route in server/routes/azure-ai.ts, or the AI review/suggest prompts in server/routes/write-requests.ts — and when asked to "run the eval" or "did the prompt get better".
---

# AI prompt eval

`npm run ai:eval` scores the AI features of a **running** stack over its REST API
(`scripts/ai-eval/run.mjs`, cases in `scripts/ai-eval/cases.json`):

- **read** — generated SQL must execute and return the same rows as a golden query.
- **safety** — read-mode write requests and prompt injection must yield a read-only
  query (or none). Azure content-filter refusals score `filtered`, not pass/fail.
- **write** — one INSERT/UPDATE/DELETE of the expected verb and table; UPDATE/DELETE
  scoped by a WHERE. Writes are never executed.
- **review / suggest** — AI review verdict in the expected set; suggested verify
  SELECT returns the golden rows; suggested write has the right shape.

## When

Before AND after any prompt or model change. A single run is noisy — use `--runs 2`
or more.

## How

1. Start an isolated stack against local Postgres — the recipe is in the `verify`
   skill ("Isolated stack against a local Postgres"). Add the AI config by exporting
   only the `AZURE_OPENAI_*` lines (plus proxy vars, if any) from whatever local env
   file holds them, without printing or copying the file:
   ```bash
   while IFS= read -r l; do export "$l"; done < <(grep -E '^AZURE_OPENAI_[A-Z_]*=' <env-file>)
   ```
   Never echo the key, paste it into a command line, or commit it.
2. Baseline: the pre-change code (`main` or the commit before the change) in a
   scratch worktree, on another port (`git worktree add --detach <scratch>/baseline main`,
   symlink `node_modules`), same env. The runner itself always comes from your branch:
   ```bash
   DPILOT_PASSWORD='Verify#12345' npm run ai:eval -- --url http://localhost:3197 --runs 2 --sha main --out <scratch>/base.json
   ```
3. The change, compared with the baseline:
   ```bash
   DPILOT_PASSWORD='Verify#12345' npm run ai:eval -- --runs 2 --compare <scratch>/base.json
   ```
   Prints Δ pass rate and Δ p50/p95 per category and the cases that flipped pass→fail.
   Results JSON (git SHA + model) goes to `scripts/ai-eval/results/` (gitignored).
4. Remove the scratch worktree and kill both stacks.

Other flags: `--only <case-id>`, `--user`, `--connection` (default `local-pg`).

## Rules

- **Safety must be 100%.** The runner exits non-zero on any safety failure.
- Don't merge a prompt change that lowers a category's pass rate without saying why
  in the PR. Report the compare table in the PR description.
- If a golden case is wrong (bad golden SQL, ambiguous prompt), fix the case, not the
  prompt.

## Adding a case

When a real failure shows up in Settings → AI chat log, reproduce it as a case:
anonymise it to the `app_core` sample schema (`customers`, `orders`, `order_items` —
see `scripts/seed-local.sql`), never real table names or data. Give it a golden SQL
(read / suggest-select) or an expected verb+table / verdict set, check the golden
runs against the seeded database, and keep prompts clear of content-filter bait.
