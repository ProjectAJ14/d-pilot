# server/ — Backend (Express + SQLite)

Express/TypeScript API. Entry `server/index.ts` builds the app, mounts routes under
`/api`, seeds SQLite, and (in production) serves the built client from `dist/client/`.
Read the root `CLAUDE.md` first for the cross-cutting rules (capability model, PROD
safety rails, in-app config).

## Mount point (`config/base-path.ts`)

Everything — API, `/manifest.webmanifest`, the static client — hangs off one
`express.Router()` that `index.ts` mounts at `BASE_PATH`. That is `""` (i.e. `/`) unless
the `BASE_PATH` env var says otherwise, so at a domain root this is the app it has always
been. Set `BASE_PATH=/d-pilot` and the server answers on `/d-pilot/api/...` itself.

The server mounting itself, rather than a proxy stripping the prefix, is deliberate: the
reverse proxy stays a plain `proxy_pass` with no rewriting, so exactly one place knows the
prefix. Redirects and cookie paths emitted here are then already correct.

When `BASE_PATH` is set, a GET that falls through the mount is redirected into the
prefix (old bookmarks, stale root-scoped service workers). `/api` is excluded on
purpose: a browser re-issues a redirected POST as a GET, so forwarding a stale
client's write would silently make it a no-op. Keep it a 302 — a 301 is cached
forever and would strand everyone if the app moved back to the root.

**`BASE_PATH` must match what the client was built with** — Vite bakes it into the asset
URLs (`vite.config.ts` reads the same variable). Changing it needs a rebuild, not a
restart. When you add anything that emits a root-absolute URL — a redirect, a manifest
field, a link in an email — run it through `withBase()` or prefix it with `BASE_PATH`.
`routes/mcp.ts` is the worked example: its loopback base and its artifact-link fallback
both carry it.

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
- **`resolveReadableConnection(req, res, connectionId)`** — the _only_ way a route may turn a
  caller-supplied `connectionId` into a `ConnectionConfig`. It 400/404/403s for you and
  enforces read access for that connection's environment. A bare `getConnection()` in a route
  is a bug: it hands the caller any environment (this is exactly how `/export` and `/schema`
  once leaked data from environments the user could not read). Routes needing a stronger
  capability (write/approve/unmask) check that _in addition_.
- `initAuthTables` creates/migrates the `users` table, backfills capability columns, does
  the one-time **`role` → capabilities** migration (then drops `role`), and seeds the
  default admin (`admin@$EMAIL_DOMAIN`, `admin@example.com` when unset) when the table is
  empty.
- The middleware keeps backward-compat for pre-capability JWTs (derives from the old
  `role` claim) so live sessions survive a deploy.

`GET /manifest.webmanifest` (in `index.ts`, outside `/api` and unauthenticated) renders the
PWA manifest per request from `APP_NAME`, so an installed app carries the deployment's own
name rather than one baked in at build time. In production `express.static` also sends
`Cache-Control: no-cache` for `sw.js`, so a proxy cannot pin clients to an old build.

## Routes (`routes/`) — all under `/api`

| Mount             | File                | Notes                                                                                                                                                                           |
| ----------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/query`          | `query.ts`          | `POST /execute` (read-only), `GET /history`                                                                                                                                     |
| `/connections`    | `connections.ts`    | list / `writable` / `grouped` / `:id/test`                                                                                                                                      |
| `/schema`         | `schema.ts`         | `:connectionId` full / schemas / tables / columns                                                                                                                               |
| `/saved-queries`  | `saved-queries.ts`  | CRUD; shared-by-default; `GET /:id` backs share links                                                                                                                           |
| `/artifacts`      | `artifacts.ts`      | CRUD; shared-by-default; `GET /:id` backs share links. `parseBlocks` is the only gate on document shape                                                                         |
| `/phi-config`     | `phi-config.ts`     | masked-envs, `POST /unmask` (audited), rule CRUD (admin), CSV `GET /export` / `POST /import` + `DELETE /` bulk delete (admin, audited)                                          |
| `/audit`          | `audit.ts`          | log + archive read, manual archive (admin)                                                                                                                                      |
| `/export`         | `export.ts`         | `POST /csv`, `POST /json` (masking enforced + audited)                                                                                                                          |
| `/users`          | `users.ts`          | user CRUD + reset-password (admin)                                                                                                                                              |
| `/azure-ai`       | `azure-ai.ts`       | `test`, `generate-query`, `settings` (admin), `schema-cache/clear` (admin), `chat-log` (admin)                                                                                  |
| `/analytics`      | `analytics.ts`      | admin usage dashboard                                                                                                                                                           |
| `/write-requests` | `write-requests.ts` | write lifecycle + policy + AI review/suggest                                                                                                                                    |
| `/settings`       | `settings.ts`       | admin runtime config: settings list/update/reset, connection CRUD + pre-save `POST /connections/test` + all-or-nothing `POST /connections/import` (secrets write-only, audited) |
| `/mcp`            | `mcp.ts`            | **read-only MCP endpoint for AI agents — mounted _before_ `authMiddleware`** (HTTP Basic, not Bearer)                                                                           |

**D-Pilot never sends 502/504 itself** (the client reads them as "server unreachable"): AI
provider errors are 500, an unusable model reply is 422, and connectivity failures anywhere are
503 `CONNECTION_FAILED`.

## Services (`services/`)

- **`query-executor.ts`** — read path for all four DB types. `validateQuery`/`isReadQuery`
  block DML/DDL; `applyDefaultLimit` injects a LIMIT when absent (default 500, hard cap
  `MAX_ROWS`). Connection pools are cached and reused. `validateSqlSyntax` does a dry
  parse; `testConnection` powers the connection tester; `testConnectionConfig` runs the same check on a throwaway, never-pooled client (Settings → test before saving).
- **`write-executor.ts`** — the _only_ write path. `validateWriteQuery` allows exactly one
  statement per dialect (SQL INSERT/UPDATE/DELETE — no stacked semicolons, no DDL;
  Mongo `updateOne/Many`,`insertOne/Many`,`deleteOne/Many`,`replaceOne`; ES
  `_doc`/`_create`/`_update`/`_update_by_query`/`_delete_by_query`) and flags whether it's
  `scoped` (UPDATE/DELETE need a WHERE/filter). `executeWrite` runs transactionally where
  the engine supports it. Each step that sends no statement (connect, pool acquire, begin,
  ping) runs inside `beforeSend`, which tags what it throws with `markPreConnect`
  (`connection-errors.ts`) — the only errors `isPreConnectError` can accept.
- **`phi-masking.ts`** — `findMatchingRule` (pattern match on column name), `maskValue`
  (FULL/PARTIAL/HASH/REDACT), `maskQueryResults`. `alwaysMasked` rules never unmask.
- **`schema-introspector.ts`** — table/column/schema discovery per DB type; builds the
  `FullSchema`, plus `summarizeTables`/`tableCatalog` for AI context and a TTL schema
  cache (`getCachedFullSchema`, `SCHEMA_CACHE_TTL_HOURS`).
- **`azure-openai.ts`** — thin Azure OpenAI chat client (`getAzureConfig`, `azureChat`).
  Returns 503-equivalent when unconfigured. A content-filter refusal throws
  `AzureOpenAIError` with `contentFiltered`; routes map it through `aiErrorResponse` to a
  422 "try rephrasing". **Only schema metadata is sent, plus — while the admin setting
  `ai_column_values_enabled` is on (default; `getAiColumnValuesEnabled`, Settings → Azure
  OpenAI) — the distinct values of short ≤20-value text columns no PHI rule matches.**
  When off, sampling is skipped and `summarizeTables` renders no values even from a
  warm cache. Never PHI, never query results.
- **`query-examples.ts`** — picks few-shot examples from saved queries for AI prompts
  (`extractReferencedTables`, `selectExampleQueries`).
- **`sqlite-store.ts`** — the app DB (see below) and all its accessors.
- **`mcp-client.ts`** — session layer for the MCP endpoint: swaps an agent's Basic
  credentials for a JWT and calls this same server over loopback. `routes/mcp.ts` must keep
  going through the REST API this way rather than calling the executor directly, so masking,
  capability checks and audit logging stay in one place.

## App database — SQLite (`services/sqlite-store.ts`)

`data/dbpilot.sqlite` (WAL). `initDatabase()` creates tables idempotently. Tables:
`saved_queries`, `artifacts`, `phi_field_rules`, `audit_log`, `app_settings`, `ai_chat_log`,
`write_requests`, `write_request_events` (the `users` table is created by
`initAuthTables`). Audit entries older than 30 days are moved to a separate
`data/audit_archive.sqlite` by `archiveOldAuditEntries`; `archiveIfDue` runs on login.

- **Settings** (`app_settings`) — PHI masked envs (`getPhiMaskedEnvs`, PROD always
  included), write-mode toggle (`getWriteModeEnabled`), direct-write envs
  (`getWriteDirectEnvs`), AI column values (`getAiColumnValuesEnabled`).
- **Runtime config** (`config/settings.ts`) — AI, branding and limits keys (`MAX_ROWS`,
  `AZURE_OPENAI_*`, `APP_NAME`, …) stored in `app_settings` under their env-var name.
  Branding and limits: precedence **db > `process.env` > built-in default**. AI
  (`group: "ai"`): **db > default** — never read from env, like connections. Read via
  `getConfig*` at use time, never into a module-level const. Bootstrap vars (PORT,
  DATA_DIR, BASE_PATH, JWT_SECRET, DEFAULT_ADMIN_PASSWORD, proxies) stay env-only.
- **Operator ceilings** — a numeric setting's built-in `max` can be lowered (never raised)
  by `<KEY>_LIMIT` in env (`settingMax`; invalid or above the cap → warning, built-in
  cap). `updateSettings` 400s above it; `getConfigNumber` clamps the saved/env/default
  value to it; `listSettings` reports it as `max`. All in `settings.ts` — callers just use
  `getConfigNumber`.
- **Connections** (`db_connections`) — the only source; managed in Settings →
  Connections (or `POST /api/settings/connections/import`). `DBFORGE_CONNECTIONS` is not
  read (a startup warning if set). Before `initDatabase` there are none. The store
  invalidates the connection cache on every write.
- **Secrets** (connection password/URI, `AZURE_OPENAI_KEY`) are AES-256-GCM encrypted
  (`config/secrets.ts`) with `SETTINGS_ENCRYPTION_KEY`, else a key generated once into
  `DATA_DIR/settings.key` (0600). The key never goes in SQLite; losing it loses the secrets.
- **Audit** — `logAudit`/`getAuditLog` capture every query, error, export, PHI unmask (and
  denial), and write-lifecycle event. `getAnalytics`/`getWriteAnalytics` power the admin
  dashboard.

## Write-request lifecycle

Status: `DRAFT → PENDING → APPROVED → EXECUTED` (or `FAILED`/`REJECTED`/`CANCELLED`).
Each transition appends a `write_request_events` row (`SAVED`, `SUBMITTED`, `AI_REVIEWED`,
`APPROVED`/`AUTO_APPROVED`/`OVERRIDDEN`, `REJECTED`, `RESUBMITTED`, `EXECUTED`, `FAILED`, `NOT_RUN`, `CANCELLED`)
for the timeline.

**A write that never reached its database is not `FAILED`.** `isPreConnectError` accepts only
errors tagged at the executor's connect/acquire/begin/ping steps _and_ network-shaped. For
those, approve/override release the claim back to `PENDING`, and direct execution
(create/submit/revise) returns the request to `DRAFT`; the route answers 503
`CONNECTION_FAILED` with `request` (its current state) audits `WRITE_EXECUTE_ERROR`, and appends a `NOT_RUN` timeline event.
Anything after a statement was sent has an unknown outcome and is `FAILED`.

**Execute-once covers direct execution too.** `runDirectExecution` claims the request
`PENDING → APPROVED` (`claimWriteRequestForApproval`, the same claim approve takes) before
it sends anything, so an approve, override or cancel that arrives mid-run 409s instead of
running it again or overwriting the result. `APPROVED` is the status every execution runs
under; the timeline shows `AUTO_APPROVED` and analytics never count `APPROVED`, so the brief
claim is not misreported. A pre-connect failure releases it `APPROVED → DRAFT`; if that
release loses its claim the route answers 409 with the request as it is, never a silent
"back to draft". `cancel` claims from the status it read (`PENDING`/`DRAFT`) and 409s if
the row moved. Every status change goes through `claimWriteRequestStatus` — never an
unconditional `updateWriteRequest({ status })` on a row someone else can act on. Elasticsearch writes
use `maxRetries: 0` (a driver retry could run one twice); Mongo writes ping before sending.

**Admin override** (`POST /:id/override`, `planDecision` — exported, unit-tested) runs a
`PENDING` request without any approver, own requests included. Admin-only (`requireAdmin`
plus `isAdmin` in the planner), a written reason is mandatory, and it is audited as
`WRITE_OVERRIDE` / `OVERRIDDEN`. It bypasses the approval queue only — the direct-write
and production rails in `getWriteDirectEnvs()` are untouched. It is deliberately allowed on
production-like envs: the two-person rule has this one admin exception, always with a reason on the record.

**`DRAFT` is the saved-but-not-running state** (`POST /` with `draft: true`, the composer's
"Save request", and everything the MCP endpoint creates). A draft is validated exactly like a
submitted request but skips both the approval queue _and_ direct execution — the environment's
direct-write policy is not consulted at all. `POST /:id/submit` is the only way out of it, and
it is where an agent-authored change meets a human: `planDraftSubmit` (exported, unit-tested)
decides refuse / queue for approval / run now, and hands the request's authorship to whoever
submits it, so the approve route's self-approval block still holds — nobody submits a draft and
then approves it as "someone else's". Visibility follows write capability as well as approve
capability, or a draft would be invisible to the people who can act on it.

Editing goes through `POST /:id/revise` for both drafts and revisable
(`REJECTED`/`CANCELLED`/`FAILED`) requests; `planRevise` (exported, unit-tested) decides
refuse / stay a draft / resubmit-and-maybe-run. A draft edit must never execute — that is the
whole point of the draft gate — so `reviseWriteRequest` takes the target status from the caller
rather than hardcoding `PENDING`.

`DELETE /:id` removes a request and its events outright — requester or admin, and only once it
is not live (`PENDING` and `APPROVED` must be cancelled first, since one is someone else's
review queue and the other may be mid-execution). `EXECUTED` is never deletable, not even by
an admin — it is the record of a change that already landed. It is not an audit hole:
`audit_log` is a separate table, so what was proposed and run survives, plus a `WRITE_DELETE`
entry. There is no MCP tool for it.

**Bound to its target.** Every transition into `PENDING` (create, submit, revise) stores
`connectionTarget(conn)` — a SHA-256 of the connection's `instance_id` (random, new on every
insert, so delete + re-create under the same id differs), env, type, host, port, database,
username, `schema` (Postgres `search_path` for writes, ES protocol) and URI — every field the
write path reads; never name or password. Approve and override recompute it and
409 on any difference (or a missing connection), leaving the request `PENDING`; resubmitting
re-binds — and sets the request's `env` to the connection's current env, which every rights
check (author, direct-write, approve) then uses. Drafts are bound when saved; submitting one
whose connection moved 409s ("revise it"). Any route that awaits SQL validation re-reads the
connection afterwards (`connectionIfUnchanged`) and 409s if it changed — before anything is
inserted, claimed or revised, so a retry never duplicates — and then binds and runs with no
await in between. Existing pending requests and drafts are bound to their connection as of the upgrade (the migration backfills them); one whose
connection was already gone, or now sits in another env, has no target and never runs.

Every request carries a paired verify **SELECT** and the **WRITE**.
`WriteAiReview` holds the structured safety verdict (SAFE/CAUTION/DANGEROUS, blast
radius, select-matches-write, suggested corrections). **PROD always needs a second
approver** — never auto-approve/direct-execute on PROD.

## Artifacts

A shareable document: prose blocks plus SQL blocks the reader can run. Same visibility model
as saved queries (shared by default, author-only edits) and the same deep-link shape.

**An artifact stores queries, never result rows.** That is the whole design: a reader runs a
block through `/api/query/execute` _as themselves_, so their own capabilities, their own PHI
masking and their own audit entry apply. Embedding rows would freeze one author's unmask
privileges into a document everyone can open — do not add a "snapshot the results" feature
without solving that first.

Blocks are a structured discriminated union (`text` | `html` | `sql`). Text blocks hold markdown,
which the client renders without ever emitting raw HTML; `html` blocks hold a rich page that the
client renders only inside a sandboxed, opaque-origin iframe with a no-network CSP
(`src/utils/artifact-html.ts`). Either way the server stores bodies verbatim and does no
escaping of its own — isolation is the client's job, by construction. The MCP
`create_artifact` description carries the writing brief agents follow (short answer → how it
works with an SVG diagram → evidence queries → the rule). `parseBlocks`
in `routes/artifacts.ts` rejects unknown block types rather than storing them (a block nothing
can render reads as data loss later) and strips unknown keys.

There is **no delete** — `setArtifactArchived` is the only removal, exposed as
`PUT /:id { "archived": true|false }`; `DELETE` answers 405 with that instruction. Listings hide
archived artifacts, `getArtifactById` still returns them so an old share link opens and says
"archived" rather than 404ing.

The MCP endpoint may create/update/archive artifacts — an exception to its read-only posture,
and only because artifacts are not database state. Keep that boundary: an agent must never gain
a path that mutates a _target_ database, and cannot destroy an artifact either. The same reason
lets it save, read back and edit write-request **drafts** (`create_write_request`,
`get_write_request`, `update_write_request`): a draft is a document until a human submits it.
`update_write_request` posts `draft: true` to `/:id/revise`, which makes the route refuse
anything that is not a DRAFT — that flag is the boundary, so keep it. The route also keeps a
draft edit a DRAFT and skips direct execution on it; turning an edit into a run is exactly what
the draft gate exists to prevent. Never add an MCP tool that submits, approves, executes or
deletes one.

## Types

`server/types/index.ts` — backend copy of shared shapes. Mirror any change into
`src/types/index.ts`.
