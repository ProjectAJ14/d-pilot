# Test coverage — 100%, always

D-Pilot holds **100% statements, branches, functions and lines** across `src/`, `server/`,
`public/*.mjs` and `vite.pwa.config.ts`. `npm test` runs with coverage and `vite.config.ts`
sets `thresholds: { 100: true }`, so CI and `pre-push` fail on any uncovered line or branch.
Every code change keeps it at 100% — there is no "add tests later".

## Rules

- **Ship tests with the code.** Any new or changed line and branch is covered by tests in
  the same change. A bug fix also gets a regression test that fails on the old code.
- **Check before you finish:**
  `npx vitest run <test files> --coverage --coverage.include='<source file>' --coverage.reporter=text`
  must show 100% for every file you touched, then `npm test` must pass.
- **Tests assert behaviour** — what renders, which API was called with what, status codes,
  audit rows, error messages — not merely that the code ran.
- **Never game the number.** No `v8 ignore` / `istanbul ignore` / `c8 ignore` comments; never
  narrow `coverage.include`, add to `coverage.exclude`, or lower the thresholds to get green.
- **An unreachable branch is a code smell, not an exception.** First force it in a test:
  mock the collaborator (`vi.mock` / `vi.spyOn`), or call a disabled control's handler with
  `fireReactHandler` (`src/utils/react-handler.testing.ts`). If it is truly dead, delete it —
  but never a validation, capability, masking or production-rail check: those are defence
  in depth and get a test instead.

## How

- **Server:** colocated `*.test.ts`; real SQLite in a temp `DATA_DIR`; mock DB drivers,
  `fetch` and Azure — never hit a real database or network.
- **Components:** first line `// @vitest-environment jsdom`; render with `renderUi`
  (`src/utils/dom.testing.tsx` — Mantine, router, jsdom stubs). Mock Monaco and AG Grid with
  fakes that capture their props, then call those callbacks. Use
  `userEvent.setup({ delay: null })`, clear Mantine notifications between tests, and query
  Select options with `{ hidden: true }`.
- **Helpers** shared by tests are named `*.testing.ts(x)` — they are excluded from coverage.
