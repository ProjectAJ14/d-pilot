# src/ — Frontend (React 19 SPA)

React 19 + TypeScript, built with Vite. Mantine v8 for UI, Tabler Icons, AG Grid (results
table), Monaco (SQL/query editor). Entry `src/main.tsx` → `src/App.tsx`. Read the root
`CLAUDE.md` first for the cross-cutting rules.

## Design system

**Before touching any UI, read `.claude/skills/design/SKILL.md`.** In short:
`src/styles/tokens.css` is the entire design system — one file decides every
colour, face, size, radius and duration, and re-theming the app means editing
it and nothing else. It defines a SCALE (the verdigris accent ramp, type,
spacing, radii, motion) and two GROUNDS, `paper` (light) and `ink` (dark), each
declaring the same ROLE tokens. `global.css` maps D-Pilot's semantic names
(`--surface`, `--text`, `--accent`, …) onto those roles, so components keep
naming what they always did. Mantine owns the ground via
`data-mantine-color-scheme` on `<html>`, with `index.html` applying it before
first paint and `<ColorSchemeToggle>` (top-bar account menu) offering
Light/Dark/System.

**There are no colour mirrors.** AG Grid takes `var(--surface)` and friends
straight through `themeQuartz.withParams()`; react-obj-view takes `var()` too;
Monaco — which parses literals and cannot read CSS variables — resolves the
tokens at startup through `utils/theme-tokens.ts`. `src/styles/color-tokens.test.ts` fails the
build on a hex outside `tokens.css`/`main.tsx`, and `contrast.test.ts` re-solves
the WCAG floors on every run, so a token change is checked rather than trusted.

`main.tsx` is the one place the palette is restated in JS, because Mantine
derives its `light`/`filled`/`outline` variants in JS. It overrides the _stock_
Mantine palette names (`gray`, `red`, `orange`, `green`, `blue`, `violet`), which
is what re-themes the ~100 existing `color="red"` uses; everything else it takes
— fonts, sizes, radii, spacing — is handed over as a `var()`.

Interaction states come from the `dp-*` utility classes in `global.css`; never
track hover in React state.

## State — Zustand (`store/index.ts`)

Single store. Slices: `config` (public branding/PHI config), **auth** (`token`, `user`,
`isAuthenticated`; `login`/`logout` persist the token), **connections** (`activeConnectionId`; `connectionLastUsed` — per-user explorer picks in `localStorage`, bumped only by `markConnectionUsed`, never by `setActiveConnection`, which also runs for defaults/restores),
**tabs** (multi-tab workspace: `addTab`/`closeTab`/`updateTab`), **PHI shield**
(`phiEnabled`, `togglePhi`), **default limit** (`defaultLimitEnabled`/`Value`), **saved
queries**, **UI** (`sidebarOpen`, `phiPanelOpen`, `aiAssistantOpen`), **write handoff**
(`writeHandoff` — carries a query from read → write composer) and `actionRequiredCount`
(pending approvals badge). Several setters mirror to `localStorage`.

## Routing (`App.tsx`, React Router v7)

| Path                  | View                                                                                                                                                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/`                   | Query workspace (`query/query-workspace.tsx`)                                                                                                                                                                                                                      |
| `/write`              | Write composer workspace (`write/write-workspace.tsx`)                                                                                                                                                                                                             |
| `/requests`           | Write requests list (`write/requests-page.tsx`)                                                                                                                                                                                                                    |
| `/write-requests/:id` | Write request detail + timeline (`write/write-request-detail.tsx`)                                                                                                                                                                                                 |
| `/saved-queries/:id`  | Saved-query share link — opens the query in a new editor tab (`query/saved-query-link.tsx`)                                                                                                                                                                        |
| `/artifacts/:id`      | Artifact share link — opens the document as a tab (`query/artifact-link.tsx`)                                                                                                                                                                                      |
| `/profile`            | Profile / password (`pages/profile-page.tsx`)                                                                                                                                                                                                                      |
| `/docs/mcp`           | Connect an AI agent — manual macOS/Linux + Windows (PowerShell) MCP setup commands; username prefilled from `user.username`, credential built in the browser and only in the copied text, never an agent prompt (`pages/mcp-setup-page.tsx`, `utils/mcp-setup.ts`) |
| `/settings`           | Admin settings, sidebar-nav (`pages/settings-page.tsx`)                                                                                                                                                                                                            |

Unknown paths redirect to `/`.

Routes are written as if the app owned the domain root; `<BrowserRouter basename>` is set
from `utils/base-path.ts` so a sub-path deployment (`BASE_PATH=/d-pilot`) works without
touching any of them. React Router strips the basename from `useLocation().pathname` and
adds it back on navigation, which is why `top-bar.tsx` can still compare against `"/"`.
A URL built by hand from `window.location.origin` does **not** get that treatment — see
`utils/share-links.ts`.

## Components (`components/`)

- **`auth/`** — `login-screen.tsx`.
- **`layout/`** — `top-bar.tsx`, `sidebar.tsx` (schema browser + nav), `footer.tsx`
  (version, GitHub link, contributors, install button), `pwa-prompts.tsx`
  (`PwaUpdatePrompt` — notifies when a new build is waiting and reloads only on
  confirmation, since an unattended reload would drop open tabs and running queries;
  `InstallAppButton` — shown in the footer only while the browser reports the app as
  installable).
- **`query/`** — `query-workspace.tsx` (orchestrator), `query-tabs.tsx`, `query-editor.tsx`
  (Monaco, dialect-aware, schema-aware autocomplete), `results-grid.tsx` (AG Grid),
  `results-json-view.tsx` (table ↔ JSON toggle), `cell-detail-drawer.tsx` (large-value
  inspector), `grid-cell-tooltip.tsx` (local-time datetime peek), `ai-assistant-panel.tsx`,
  `artifact-view.tsx` + `artifact-link.tsx` (artifact documents — see below).

**Tab kinds.** `QueryTab.kind` is `"sql"` (default, undefined included) or `"artifact"`.
`query-workspace.tsx` branches on it: an artifact tab renders `ArtifactView` instead of the
editor + results pair. `tab-persistence.ts` stores only `artifactId`, never the document —
same rule as results. Each SQL block inside an artifact owns its own result state and passes
`onViewModeChange` to `ResultsGrid` so the table/JSON toggle stays per-block instead of
writing to the tab in the store.

- **`write/`** — `write-workspace.tsx`, `write-composer.tsx` (paired SELECT + WRITE, AI
  review), `requests-page.tsx`, `write-request-detail.tsx`, `shared.tsx` (status
  badges/helpers).
- **`phi/`** — `phi-config-panel.tsx` (admin rules), `phi-unmask-modal.tsx` (reason/notes
  capture for audited unmask).
- **`pages/`** — `profile-page.tsx`, `settings-page.tsx` (users, PHI, write policy,
  connections, branding & limits, Azure OpenAI, analytics, audit).

## Utils (`utils/`)

- **`api-client.ts`** — fetch wrapper. Injects `Authorization: Bearer` and PHI headers
  (`X-PHI-Shield`, `X-PHI-Unmask-Reason`, `X-PHI-Unmask-Notes`). Reason and notes go through
  `encodeURIComponent`: a header carries only Latin-1, and a raw em dash, name or newline
  makes `new Request` throw on every call. Auto-logout on 401 (calls
  store `logout`). Its base is `${BASE_PATH}/api`, so every call is sub-path-correct —
  **add new endpoints here rather than calling `fetch("/api/...")` directly**, which is the
  one thing that silently breaks a sub-path deployment.
- **`server-reachability.ts`** — no response from fetch (or a proxy's 502 that isn't
  D-Pilot's JSON error) means the D-Pilot server itself is unreachable — typically the VPN is
  off while the PWA shell still loads from cache. `api-client` turns that into one `ApiError`
  with code `SERVER_UNREACHABLE` and raises the store's `serverUnreachable`; any response
  lowers it. The `Request` is built before the `try`, so a request fetch refuses to send (a
  non-Latin-1 header) is an ordinary error, not an outage. A 504 is usually a proxy timing
  out one long query: an ordinary `ApiError` plus one `api.ping()`, and the banner only if
  that fails. A 503 is **not** in the set either: it is the server's `CONNECTION_FAILED` for
  an unreachable _database_ (write routes add `request`, see `write-not-reached.ts`).
  `layout/server-unreachable-banner.tsx` shows one sticky line (with the last-known
  `networkHint`, persisted in `localStorage` because it is needed exactly when `/api/config`
  can't load; sign-in shows the same text via `loginErrorMessage`) and retries through
  `startReachabilityWatch` — every 10 s and on `online`, one ping at a time. When the flag
  falls, `reloadOnRecovery` (`app-config.ts`) re-runs `App.tsx`'s boot loaders, so an app
  opened with the VPN off fills in without a reload. `notifyError` drops
  `SERVER_UNREACHABLE` so there is no toast per call — a bare
  `notifications.show(err.message)` must check `isServerUnreachable(err)` itself.
- **`base-path.ts`** — `BASE_URL` (trailing slash) and `BASE_PATH` (none, empty at root),
  read from Vite's `import.meta.env.BASE_URL`, which `vite.config.ts` sets from the
  `BASE_PATH` env var at build time. Needed only for URLs assembled at runtime: the API
  base, the router basename, share links. Anything Vite can see at build time — an
  `import`, an asset URL, `src`/`href` in `index.html` — it rewrites for you.
- **`tab-persistence.ts`** — localStorage save (500 ms debounce) + restore of tabs, active
  connection, and sidebar state. Results are **not** persisted.
- **`connection-pins.ts`** — per-user pinned connections (`connectionPins` in the store,
  `localStorage` only — a display preference, never server state). The sidebar sorts
  recent-first, then `sortPinnedFirst` floats pins to the top of each env group in pin
  order. Drag-and-drop and Alt+↑/↓ on the pin button reorder them; the decisions live in
  the pure `canDropPin` / `nudgeTarget` / `dropEdge` so they are unit-tested (there is no
  component-test setup). The nudge follows the _visible_ (search-filtered) order.
- **`user-search.ts` `filterUsers`** — client-side filter behind the User Management search box
  (name/email/username, case-insensitive substring). It only sees users the tab already
  loaded; Add User clears the query so a new user can't be hidden by it.
- **`environments.ts` `runEnvStyle(env)`** — label + color for the editor's "Run on ENV"
  button and env strip. Any production-like name (`isProductionEnv`, so `SUPER_PROD` too)
  is red even though `envColor()` has no entry for it. Keep new env-aware UI on this
  helper rather than re-deriving the color.
- **`notify-error.tsx` / `report-issue.ts`** — show a caught error with
  `notifyError(err, "<Screen>")`, not a bare red `notifications.show`: it adds a "Report
  issue" link (5xx and network errors only) that opens a prefilled issue on the **public**
  GitHub repo. So the report is an allowlist — error text scrubbed of anything quoted,
  emails, hosts, IPs and long numbers, plus code/db type/version — and never SQL, rows, or
  connection, table, user or env names. Don't widen it without that in mind. Render crashes
  land on `components/layout/crash-screen.tsx`, which reports the same way.
- **`datetime.ts`** — ISO → local-time formatting for grid cells/tooltips.
- **`schema-metadata.ts`** — copy table metadata as JSON / DDL / text.
- **`clipboard.tsx` / `clipboard-polyfill.ts`** — copy helpers with a fallback for insecure
  (non-HTTPS) contexts.

## Types & conventions

- `src/types/index.ts` mirrors `server/types/index.ts` — keep shared shapes in sync.
- File naming: `PascalCase` for React components is **not** used here — components are
  `kebab-case.tsx` (match the surrounding files). Path alias `@src/*` → `./src/*`.
