# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working with this repo.

D-Pilot is an internal, read-first SQL explorer for your organization's databases: PHI
tokenization, an AI query assistant, a governed write-approval workflow, multi-database
support, and per-environment capability-based access control. See `README.md` for the
full feature list and deployment guide.

## Commands

```bash
npm run dev              # Server + client concurrently (server :3101, client :3100)
npm run dev:server       # Server only (tsx watch, port 3101)
npm run dev:client       # Vite dev server only (port 3100)
npm run build            # Production build: vite build + tsc -p tsconfig.server.json
npm start                # Start production server from dist/server/index.js
npm run lint             # ESLint (.ts, .tsx)
npm run format           # Prettier
```

`predev` frees the dev ports first (`scripts/free-ports.mjs`). Ports are set in `.env`
(`PORT`, `VITE_PORT`).

## Architecture

Full-stack TypeScript, single repo: React 19 SPA (`/src`) + Express backend (`/server`),
with SQLite (better-sqlite3, WAL) as the app's own store. Target databases are queried
read-only; writes only flow through the governed write workflow.

**Request flow:** Client → `src/utils/api-client.ts` (adds JWT + PHI headers) → Express →
`authMiddleware` (JWT verify, capability model) → route handler → `query-executor` /
`write-executor` (validate + run on target DB) → `phi-masking` (mask results) → audit log
→ response.

Detailed guidance lives with the code — read these when working in each area:
- **`server/CLAUDE.md`** — routes, services, SQLite schema, PHI masking, write workflow, AI, auth.
- **`src/CLAUDE.md`** — components, Zustand store, routing, api-client, utils.

### Cross-cutting rules (apply everywhere)

- **This is an open-source project — keep it company-agnostic.** Never put a company,
  employer, or internal-project name (or internal schema/table names) in code, tests,
  docs, commit messages, or `CHANGELOG.md`. The product name is **D-Pilot**; anything
  company- or deployment-specific (app name, logos, email domain, DB connections) comes
  from `.env` (`APP_NAME`, `LOGO_URL`, `EMAIL_DOMAIN`, `DBFORGE_CONNECTIONS`, …). Where
  code needs a hardcoded fallback, use the neutral `D-Pilot` / `d-pilot`. Test fixtures
  must use generic names (`app_core`, `orders`, `customers`), never real internal ones.
- **Capability-based access, scoped per environment** (`DEV`/`QA`/`UAT`/`STG`/`PROD`).
  A user has `isAdmin` plus four env lists: read (`allowedEnvironments`), unmask PHI
  (`unmaskEnvironments`), write (`writeEnvironments`), approve (`approveEnvironments`).
  Admin implies all capabilities on all envs. There is **no** legacy `role` column — it
  was migrated to capabilities (see `initAuthTables` in `server/middleware/auth.ts`).
- **PROD safety rails always apply**, regardless of capabilities: PROD is always PHI-tokenized
  (cannot be turned off) and PROD writes always require a second approver (no direct execute).
- **In-app config, not env vars:** masked environments, PHI rules, write-mode toggle, and
  direct-write environments live in the SQLite `app_settings`/`phi_field_rules` tables and
  are edited in Settings — not in `.env`. (Legacy `PHI_ALWAYS_MASKED` / `PHI_ADMIN_CAN_UNMASK`
  env vars are no longer read.)
- **Types are duplicated** by design: `src/types/index.ts` (frontend) and
  `server/types/index.ts` (backend) — keep shared shapes (`Environment`, `MaskingType`,
  `WriteRequest`, etc.) in sync when you change one.

## Environment

Copy `.env.example` → `.env`. Key vars: `JWT_SECRET`, `DBFORGE_CONNECTIONS` (JSON array of
target DB connections), `PORT` (3101), `VITE_PORT` (3100), `MAX_ROWS` (10000),
`QUERY_TIMEOUT_MS` (90000), `SCHEMA_CACHE_TTL_HOURS` (24), `AZURE_OPENAI_*` (optional AI),
`APP_NAME`/`LOGO_URL`/`LIGHT_LOGO_URL`/`FAVICON_URL` (branding), `EMAIL_DOMAIN`,
`DEFAULT_ADMIN_PASSWORD` (first-run admin seed). Full reference in `README.md`.

## Conventions

- Husky + commitlint enforce Conventional Commits. **Do not add `Co-Authored-By` trailers**
  — commitlint rejects them here.
- `semantic-release` (`.releaserc.json`, `.github/workflows/release.yml`) derives the version
  and `CHANGELOG.md` from commit messages on release — commit types matter.
- Vite dev server proxies `/api` → Express. In production Express serves the built client
  from `dist/client/`.
- Path alias `@src/*` → `./src/*`.
