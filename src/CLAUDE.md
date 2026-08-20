# src/ — Frontend (React 19 SPA)

React 19 + TypeScript, built with Vite. Mantine v8 for UI, Tabler Icons, AG Grid (results
table), Monaco (SQL/query editor). Entry `src/main.tsx` → `src/App.tsx`. Read the root
`CLAUDE.md` first for the cross-cutting rules.

## State — Zustand (`store/index.ts`)

Single store. Slices: `config` (public branding/PHI config), **auth** (`token`, `user`,
`isAuthenticated`; `login`/`logout` persist the token), **connections** (`activeConnectionId`),
**tabs** (multi-tab workspace: `addTab`/`closeTab`/`updateTab`), **PHI shield**
(`phiEnabled`, `togglePhi`), **default limit** (`defaultLimitEnabled`/`Value`), **saved
queries**, **UI** (`sidebarOpen`, `phiPanelOpen`, `aiAssistantOpen`), **write handoff**
(`writeHandoff` — carries a query from read → write composer) and `actionRequiredCount`
(pending approvals badge). Several setters mirror to `localStorage`.

## Routing (`App.tsx`, React Router v7)

| Path | View |
|------|------|
| `/` | Query workspace (`query/query-workspace.tsx`) |
| `/write` | Write composer workspace (`write/write-workspace.tsx`) |
| `/requests` | Write requests list (`write/requests-page.tsx`) |
| `/write-requests/:id` | Write request detail + timeline (`write/write-request-detail.tsx`) |
| `/saved-queries/:id` | Saved-query share link — opens the query in a new editor tab (`query/saved-query-link.tsx`) |
| `/artifacts/:id` | Artifact share link — opens the document as a tab (`query/artifact-link.tsx`) |
| `/profile` | Profile / password (`pages/profile-page.tsx`) |
| `/settings` | Admin settings, sidebar-nav (`pages/settings-page.tsx`) |

Unknown paths redirect to `/`.

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
- **`pages/`** — `profile-page.tsx`, `settings-page.tsx` (users, PHI, write policy, Azure
  OpenAI, analytics, audit).

## Utils (`utils/`)

- **`api-client.ts`** — fetch wrapper. Injects `Authorization: Bearer` and PHI headers
  (`X-PHI-Shield`, `X-PHI-Unmask-Reason`, `X-PHI-Unmask-Notes`). Auto-logout on 401 (calls
  store `logout`).
- **`tab-persistence.ts`** — localStorage save (500 ms debounce) + restore of tabs, active
  connection, and sidebar state. Results are **not** persisted.
- **`datetime.ts`** — ISO → local-time formatting for grid cells/tooltips.
- **`schema-metadata.ts`** — copy table metadata as JSON / DDL / text.
- **`clipboard.tsx` / `clipboard-polyfill.ts`** — copy helpers with a fallback for insecure
  (non-HTTPS) contexts.

## Types & conventions

- `src/types/index.ts` mirrors `server/types/index.ts` — keep shared shapes in sync.
- File naming: `PascalCase` for React components is **not** used here — components are
  `kebab-case.tsx` (match the surrounding files). Path alias `@src/*` → `./src/*`.
