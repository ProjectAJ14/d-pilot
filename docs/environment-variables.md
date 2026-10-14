# Environment variables

`.env.example` lists every variable D-Pilot reads, with a one-line comment each. This
page holds the detail. Copy `.env.example` to `.env` and edit it.

Database connections and the AI assistant (Azure OpenAI) have **no** environment
variables: configure them in-app under **Settings → Connections** and **Settings →
Azure OpenAI**. An old `DBFORGE_CONNECTIONS` value is ignored (the server logs a
warning). Paste its JSON array into **Settings → Connections → Import** instead.

There are two kinds of variable:

1. **Bootstrap.** Read only from the environment, because they are needed before the
   app database exists or are baked into the client build. Change them and restart
   (`BASE_PATH`: rebuild).
2. **Fallbacks.** Branding and limits an admin can override in Settings. Precedence is
   **saved in Settings > `.env` > built-in default**. Once a value is saved in
   Settings, editing `.env` no longer changes it. **Reset** in Settings drops the
   saved value so `.env` (or the default) applies again.

## Bootstrap

| Variable                     | Default        | Purpose                                                                            |
| ---------------------------- | -------------- | ---------------------------------------------------------------------------------- |
| `PORT`                       | `3101`         | Port the Express server listens on.                                                |
| `VITE_PORT`                  | `PORT` − 1     | Port of the Vite dev server (development only); it proxies `/api` to `PORT`.       |
| `NODE_ENV`                   | `development`  | `production` serves the built client from `dist/client/`.                          |
| `BASE_PATH`                  | unset (`/`)    | Sub-path to serve the app under. See [below](#base_path).                          |
| `DATA_DIR`                   | `data`         | Where `dbpilot.sqlite`, `audit_archive.sqlite` and `settings.key` live.            |
| `SETTINGS_ENCRYPTION_KEY`    | unset          | Key for secrets stored in the app database. See [below](#settings_encryption_key). |
| `JWT_SECRET`                 | dev-only value | Signs login tokens. **Set a long random string in every real deployment.**         |
| `DEFAULT_ADMIN_PASSWORD`     | —              | Password of the first admin, seeded only into an empty database.                   |
| `HTTPS_PROXY` / `HTTP_PROXY` | unset          | Outbound proxy for the Azure OpenAI call, if your network needs one.               |

The first admin is seeded as `admin@<EMAIL_DOMAIN>` (`admin@example.com` if unset)
with `DEFAULT_ADMIN_PASSWORD`. To re-seed, delete `DATA_DIR/dbpilot.sqlite` and
restart.

### `BASE_PATH`

Leave it unset (or `/`) when D-Pilot owns a domain or subdomain of its own, which is
the normal case. Set it only when a reverse proxy mounts D-Pilot under a prefix of a
shared domain, e.g. `BASE_PATH=/d-pilot` for `https://intranet.example/d-pilot`.

It is read at **build** time by Vite (baked into every asset URL) and at **run** time
by Express (which mounts itself there), so `npm run build` and `npm start` must see
the same value. Changing it means rebuilding, not just restarting. The proxy then
needs no path rewriting. See the README, "Serving under a sub-path".

### `SETTINGS_ENCRYPTION_KEY`

Encrypts the secrets stored in the app database (connection passwords and URIs, the
Azure OpenAI key) with AES-256-GCM. Any string works. If unset, a random key is
generated once into `DATA_DIR/settings.key` (mode `0600`).

Back that file up **with** the database but store it **separately**: whoever holds
both can read every stored secret, and losing the key means re-entering every secret
in Settings.

### Operator ceilings

Upper bounds an admin cannot exceed in Settings. Each can only **lower** the built-in
cap. A saved, `.env` or default value above the ceiling is clamped, so lowering a
ceiling never breaks a running install. A value above the built-in cap, zero or not a
number is ignored with a warning.

| Variable                       | Built-in cap | Caps                     |
| ------------------------------ | ------------ | ------------------------ |
| `MAX_ROWS_LIMIT`               | `1000000`    | `MAX_ROWS`               |
| `MCP_MAX_ROWS_LIMIT`           | `1000000`    | `MCP_MAX_ROWS`           |
| `QUERY_TIMEOUT_MS_LIMIT`       | `2147483647` | `QUERY_TIMEOUT_MS`       |
| `SCHEMA_CACHE_TTL_HOURS_LIMIT` | `8760`       | `SCHEMA_CACHE_TTL_HOURS` |

## Fallbacks (overridable in Settings)

| Variable                 | Default                 | Purpose                                                                                            |
| ------------------------ | ----------------------- | -------------------------------------------------------------------------------------------------- |
| `APP_NAME`               | `D-Pilot`               | Name in the header, page title and installed-app manifest.                                         |
| `LOGIN_TAGLINE`          | `Internal query tool`   | First line under the app name on the login page. Saving it empty in Settings hides it.             |
| `LOGIN_SUBTITLE`         | `HIPAA · PHI tokenized` | Second line under it, e.g. a compliance note. Saving it empty in Settings hides it.                |
| `LOGO_URL`               | unset                   | Header logo for dark mode: a path under `public/` or an external URL. Unset = text-only header.    |
| `LIGHT_LOGO_URL`         | `LOGO_URL`              | Header logo for light mode.                                                                        |
| `FAVICON_URL`            | `/favicon-32.png`       | Browser tab icon.                                                                                  |
| `EMAIL_DOMAIN`           | unset                   | Domain for the seeded admin and for new users' emails; unset accepts any domain.                   |
| `APP_BASE_URL`           | unset                   | Public origin; unset gives relative links. See [below](#app_base_url).                             |
| `JWT_EXPIRES_IN`         | `24h`                   | Session length for new logins. Needs a unit: `24h`, `7d`, `90m`.                                   |
| `MAX_ROWS`               | `10000`                 | Row cap applied to queries without their own limit.                                                |
| `QUERY_TIMEOUT_MS`       | `90000`                 | Query timeout in milliseconds.                                                                     |
| `MCP_MAX_ROWS`           | `1000`                  | Default rows per AI-agent query on `/api/mcp`; agents may ask for more per call, up to `MAX_ROWS`. |
| `SCHEMA_CACHE_TTL_HOURS` | `24`                    | How long a connection's introspected schema is cached. `0` disables it.                            |

### `APP_BASE_URL`

The origin users browse D-Pilot on. Only used to build clickable artifact links in MCP
tool output; without it agents hand back a bare `/artifacts/<id>` path.

Set the origin only: `BASE_PATH` is appended automatically. A sub-path deployment
wants `APP_BASE_URL=https://intranet.example` with `BASE_PATH=/d-pilot`, not the two
spliced together by hand.

### `SCHEMA_CACHE_TTL_HOURS`

Caches each connection's introspected schema, used by autocomplete and AI query
generation. Schema rarely changes, and caching avoids re-introspecting the database
on every request.
