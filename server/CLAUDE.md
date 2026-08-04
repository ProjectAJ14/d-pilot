# server/ — Backend (Express + SQLite)

Express/TypeScript API. Entry `server/index.ts` builds the app, mounts routes under
`/api`, seeds SQLite, and (in production) serves the built client from `dist/client/`.
Read the root `CLAUDE.md` first for the cross-cutting rules (capability model, PROD
safety rails, in-app config).

## Middleware chain

`cors` → `express.json` → **public** routes (`/api/health`, `/api/config`,
`/api/auth/login`) → `authMiddleware()` (guards everything else) → route handlers.
`authMiddleware` verifies the JWT and populates `req.user` (`AuthUser`). `requireAdmin`
gates admin-only routes; `requireWriteMode` (in `routes/write-requests.ts`) gates write
submission/rejection when write mode is off.

## Auth & access (`middleware/auth.ts`)

- Local JWT (bcrypt hashing, `jsonwebtoken`). No external IdP.
- **Capability model** — `deriveUserProfile` turns a user row into `isAdmin` + four env
  lists (read/unmask/write/approve). Admin ⇒ all envs on every list.
- **`resolveReadableConnection(req, res, connectionId)`** — the *only* way a route may turn a
  caller-supplied `connectionId` into a `ConnectionConfig`. It 400/404/403s for you and
  enforces read access for that connection's environment. A bare `getConnection()` in a route
  is a bug: it hands the caller any environment (this is exactly how `/export` and `/schema`
  once leaked data from environments the user could not read). Routes needing a stronger
  capability (write/approve/unmask) check that *in addition*.
- `initAuthTables` creates/migrates the `users` table, backfills capability columns, does
  the one-time **`role` → capabilities** migration (then drops `role`), and seeds the
  default admin (`admin@$EMAIL_DOMAIN`) when the table is empty.
- The middleware keeps backward-compat for pre-capability JWTs (derives from the old
  `role` claim) so live sessions survive a deploy.

## Routes (`routes/`) — all under `/api`

| Mount | File | Notes |
|-------|------|-------|
| `/query` | `query.ts` | `POST /execute` (read-only), `GET /history` |
| `/connections` | `connections.ts` | list / `writable` / `grouped` / `:id/test` |
| `/schema` | `schema.ts` | `:connectionId` full / schemas / tables / columns |
| `/saved-queries` | `saved-queries.ts` | CRUD; shared-by-default; `GET /:id` backs share links |
| `/phi-config` | `phi-config.ts` | masked-envs, `POST /unmask` (audited), rule CRUD (admin), CSV `GET /export` / `POST /import` + `DELETE /` bulk delete (admin, audited) |
| `/audit` | `audit.ts` | log + archive read, manual archive (admin) |
| `/export` | `export.ts` | `POST /csv`, `POST /json` (masking enforced + audited) |
| `/users` | `users.ts` | user CRUD + reset-password (admin) |
| `/azure-ai` | `azure-ai.ts` | `test`, `generate-query`, chat, `chat-log` (admin) |
| `/analytics` | `analytics.ts` | admin usage dashboard |
| `/write-requests` | `write-requests.ts` | write lifecycle + policy + AI review/suggest |
| `/mcp` | `mcp.ts` | **read-only MCP endpoint for AI agents — mounted *before* `authMiddleware`** (HTTP Basic, not Bearer) |

## Services (`services/`)

- **`query-executor.ts`** — read path for all four DB types. `validateQuery`/`isReadQuery`
  block DML/DDL; `applyDefaultLimit` injects a LIMIT when absent (default 500, hard cap
  `MAX_ROWS`). Connection pools are cached and reused. `validateSqlSyntax` does a dry
  parse; `testConnection` powers the connection tester.
- **`write-executor.ts`** — the *only* write path. `validateWriteQuery` allows exactly one
  statement per dialect (SQL INSERT/UPDATE/DELETE — no stacked semicolons, no DDL;
  Mongo `updateOne/Many`,`insertOne/Many`,`deleteOne/Many`,`replaceOne`; ES
  `_doc`/`_create`/`_update`/`_update_by_query`/`_delete_by_query`) and flags whether it's
  `scoped` (UPDATE/DELETE need a WHERE/filter). `executeWrite` runs transactionally where
  the engine supports it.
- **`phi-masking.ts`** — `findMatchingRule` (pattern match on column name), `maskValue`
  (FULL/PARTIAL/HASH/REDACT), `maskQueryResults`. `alwaysMasked` rules never unmask.
- **`schema-introspector.ts`** — table/column/schema discovery per DB type; builds the
  `FullSchema`, plus `summarizeTables`/`tableCatalog` for AI context and a TTL schema
  cache (`getCachedFullSchema`, `SCHEMA_CACHE_TTL_HOURS`).
- **`azure-openai.ts`** — thin Azure OpenAI chat client (`getAzureConfig`, `azureChat`).
  Returns 503-equivalent when unconfigured. **Only schema metadata is ever sent — never
  row data.**
- **`query-examples.ts`** — picks few-shot examples from saved queries for AI prompts
  (`extractReferencedTables`, `selectExampleQueries`).
- **`sqlite-store.ts`** — the app DB (see below) and all its accessors.
- **`mcp-client.ts`** — session layer for the MCP endpoint: swaps an agent's Basic
  credentials for a JWT and calls this same server over loopback. `routes/mcp.ts` must keep
  going through the REST API this way rather than calling the executor directly, so masking,
  capability checks and audit logging stay in one place.

## App database — SQLite (`services/sqlite-store.ts`)

`data/dbpilot.sqlite` (WAL). `initDatabase()` creates tables idempotently. Tables:
`saved_queries`, `phi_field_rules`, `audit_log`, `app_settings`, `ai_chat_log`,
`write_requests`, `write_request_events` (the `users` table is created by
`initAuthTables`). Audit entries older than 30 days are moved to a separate
`data/audit_archive.sqlite` by `archiveOldAuditEntries`; `archiveIfDue` runs on login.

- **Settings** (`app_settings`) — PHI masked envs (`getPhiMaskedEnvs`, PROD always
  included), write-mode toggle (`getWriteModeEnabled`), direct-write envs
  (`getWriteDirectEnvs`).
- **Audit** — `logAudit`/`getAuditLog` capture every query, error, export, PHI unmask (and
  denial), and write-lifecycle event. `getAnalytics`/`getWriteAnalytics` power the admin
  dashboard.

## Write-request lifecycle

Status: `DRAFT → PENDING → APPROVED → EXECUTED` (or `FAILED`/`REJECTED`/`CANCELLED`).
Each transition appends a `write_request_events` row (`SUBMITTED`, `AI_REVIEWED`,
`APPROVED`/`AUTO_APPROVED`, `REJECTED`, `RESUBMITTED`, `EXECUTED`, `FAILED`, `CANCELLED`)
for the timeline. Every request carries a paired verify **SELECT** and the **WRITE**.
`WriteAiReview` holds the structured safety verdict (SAFE/CAUTION/DANGEROUS, blast
radius, select-matches-write, suggested corrections). **PROD always needs a second
approver** — never auto-approve/direct-execute on PROD.

## Types

`server/types/index.ts` — backend copy of shared shapes. Mirror any change into
`src/types/index.ts`.
