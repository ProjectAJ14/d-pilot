# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev              # Run server + client concurrently (server :3101, client :3100)
npm run dev:server       # Server only (tsx watch, port 3101)
npm run dev:client       # Vite dev server only (port 3100)
npm run build            # Production build: vite build + tsc -p tsconfig.server.json
npm start                # Start production server from dist/server/index.js
npm run lint             # ESLint (.ts, .tsx)
npm run format           # Prettier
```

## Architecture

Full-stack TypeScript app: React 19 frontend + Express backend, single repo.

### Frontend (`/src`)

- **UI**: Mantine v8, Tabler Icons, AG Grid (results table), Monaco Editor (SQL editor)
- **State**: Zustand single store (`src/store/index.ts`) — auth, connections, tabs, PHI shield, saved queries, UI state
- **Routing**: React Router v7 — `/` (query workspace), `/profile`, `/settings` (admin)
- **API client**: `src/utils/api-client.ts` — fetch wrapper injecting Bearer token + PHI headers (`X-PHI-Shield`, `X-PHI-Unmask-Reason`, `X-PHI-Unmask-Notes`). Auto-logout on 401
- **Tab persistence**: `src/utils/tab-persistence.ts` — localStorage with 500ms debounce, restores tabs/connection/sidebar on reload
- **Path alias**: `@src/*` → `./src/*`

### Backend (`/server`)

- **Entry**: `server/index.ts` — Express app, middleware chain, route mounting
- **Auth**: JWT (`server/middleware/auth.ts`) — bcrypt password hashing, role-based (admin/phi_viewer/read), environment-based access control
- **Query execution**: `server/services/query-executor.ts` — supports PostgreSQL, MSSQL, MongoDB, Elasticsearch. Read-only enforcement (blocks DML/DDL). Auto-injects LIMIT if missing (default 500, max 10,000)
- **PHI masking**: `server/services/phi-masking.ts` — pattern-based column matching, masking types: FULL/PARTIAL/HASH/REDACT. Rules in SQLite `phi_field_rules` table. `alwaysMasked` fields cannot be unmasked
- **Schema introspection**: `server/services/schema-introspector.ts` — table/column discovery per DB type
- **App database**: SQLite via better-sqlite3 (`data/dbpilot.sqlite`, WAL mode). Tables: users, saved_queries, phi_field_rules, audit_log, app_settings
- **Connections**: loaded from `DBFORGE_CONNECTIONS` env var (JSON array), cached in `server/config/connections.ts`

### Request Flow

Client → `api-client.ts` (adds JWT + PHI headers) → Express → `authMiddleware` (JWT verify + environment access check) → route handler → `query-executor.ts` (validate SQL, execute on target DB) → `phi-masking.ts` (mask results) → audit log → response

### Key Types (`/src/types/index.ts`)

- `QueryTab`: id, title, sql, connectionId, result, loading, error, viewMode
- `QueryResult`: columns (with isMasked, maskingType), rows, totalRows, executionTimeMs, truncated
- `Connection`: id, name, env (DEV/QA/STG/PROD), type (postgres/mssql/mongodb/elasticsearch)

## Environment

Copy `.env.example` → `.env`. Key vars: `JWT_SECRET`, `DBFORGE_CONNECTIONS` (JSON array of DB connections), `PORT` (3101), `VITE_PORT` (3100), `MAX_ROWS` (10000), `QUERY_TIMEOUT_MS` (90000).

## Conventions

- Husky + commitlint enforce conventional commits
- Vite dev server proxies `/api` → Express server
- Production: Express serves built client static files from `dist/client/`
