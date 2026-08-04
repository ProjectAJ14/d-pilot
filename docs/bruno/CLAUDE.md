# docs/bruno/ — Bruno API Collection

A [Bruno](https://www.usebruno.com/) collection that mirrors **every** HTTP endpoint the
D-Pilot Express backend exposes (`server/routes/**` + the inline routes in
`server/index.ts`). Open this folder as a collection in Bruno.

> This collection is the source of truth for "what APIs exist." It must stay in lock-step
> with the backend — when you add, remove, or change a route, update the matching `.bru`
> file in the **same commit**. A hook enforces this (see **Keeping it in sync**).

## Layout

```
docs/bruno/
├── bruno.json              Collection manifest (name, version)
├── collection.bru          Collection-level Bearer auth ({{token}}) + docs
├── CLAUDE.md               This file
├── environments/           One .bru per environment (baseUrl + id placeholders)
│   ├── LOCAL.bru           http://localhost:3101  (default)
│   ├── QA.bru / STG.bru / PROD.bru   placeholders — set real baseUrls
└── <Resource>/             One folder per Express router / resource group
    ├── folder.bru          Folder metadata (name + seq)
    └── <VERB> <Action>.bru  One file per endpoint
```

Folders map 1:1 to the route mounts in `server/index.ts`:

| Folder | Backend source |
|--------|----------------|
| Health | `server/index.ts` (`/api/health`, `/api/config`) |
| Auth | `server/index.ts` + `server/middleware/auth.ts` (`/api/auth/*`) |
| Query | `server/routes/query.ts` (`/api/query`) |
| Connections | `server/routes/connections.ts` |
| Schema | `server/routes/schema.ts` |
| Saved Queries | `server/routes/saved-queries.ts` |
| PHI Config | `server/routes/phi-config.ts` |
| Audit | `server/routes/audit.ts` |
| Export | `server/routes/export.ts` |
| Users | `server/routes/users.ts` |
| Azure AI | `server/routes/azure-ai.ts` |
| Analytics | `server/routes/analytics.ts` |
| Write Requests | `server/routes/write-requests.ts` |
| MCP | `server/routes/mcp.ts` (read-only agent endpoint) |

## File-naming system

**One folder per resource group; one `.bru` file per endpoint.** Filenames follow a fixed
pattern so they sort cleanly and read like the route table:

```
<HTTP-VERB> <Action>.bru
```

- **`<HTTP-VERB>`** — uppercase `GET` / `POST` / `PUT` / `DELETE`, matching the route.
- **`<Action>`** — Title Case, concise, and **unique within its folder**. Name the action,
  not the path: `POST Execute Query.bru`, `GET List Users.bru`, `POST Approve Write Request.bru`.
- The `meta { name }` inside the file is the same Action text **without** the verb prefix
  (Bruno shows `name`, the OS shows the filename).
- `seq` in `meta` orders requests within a folder; `seq` in `folder.bru` orders folders.
  Keep them contiguous starting at 1.

Naming conventions for the Action word:
- Collections: `List <Things>` (`GET List Connections`).
- Single fetch: `Get <Thing>` (`GET Get Write Request`).
- Mutations: imperative verb + noun (`Create`, `Update`, `Delete`, `Approve`, `Reject`,
  `Cancel`, `Revise`, `Reset ... Password`).

## Conventions inside each request

- **Auth** — the collection sets Bearer auth to `{{token}}`; requests use `auth: inherit`.
  Public endpoints (Health, Public Config, Login) override with `auth: none`, and the
  MCP requests override with `auth: basic` — that route takes the service account's
  credentials directly, not a JWT.
  Run **Auth / Login** once — its post-response script writes the JWT into `{{token}}`.
- **Variables** (per environment): `{{baseUrl}}`, `{{token}}`, `{{connectionId}}`,
  `{{tableName}}`, `{{savedQueryId}}`, `{{phiRuleId}}`, `{{userId}}`, `{{writeRequestId}}`,
  `{{mcpUsername}}` / `{{mcpPassword}}` (MCP service account).
  Path params always use one of these placeholders — never hard-code an id.
- **PHI** — endpoints that return maskable data (Execute Query, Export CSV/JSON, Preview
  Write Request) carry three **disabled** headers: `X-PHI-Shield: off`,
  `X-PHI-Unmask-Reason`, `X-PHI-Unmask-Notes`. Enable them to request unmasking where you
  hold the capability; PROD is always tokenized regardless.
- **Bodies** are example payloads showing the shape the handler reads — adjust values, keep
  the keys aligned with the route's `req.body` destructuring.
- **`docs`** on every request states what it does and its auth/admin/write-mode/PHI notes.

## Keeping it in sync

When you touch `server/routes/**` or the inline routes in `server/index.ts`:

1. Add/rename/delete the matching `.bru` file using the naming system above.
2. Update its `body`, `params:query`, headers, and `docs` to match the handler.
3. Fix `seq` if you inserted or removed a request.
4. Commit the route change **and** the `.bru` change together.

A commit hook checks this: if a commit changes backend routes but no `docs/bruno/**` file,
it warns/blocks so the collection never silently drifts. See the repo root `CLAUDE.md`
and `.husky/` for the exact hook.
