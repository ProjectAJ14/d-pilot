# D-Pilot

Internal, read-first SQL explorer for your organization's databases — with built-in PHI
tokenization, an AI query assistant, a governed write-approval workflow, multi-database
support, and per-environment capability-based access control.

One pre-configured place where every team member can query the databases they're
allowed to reach, without juggling credentials or desktop clients — and without PHI
ever leaving the building in the clear.

## Features

### Query & explore
- **Multi-database support** — PostgreSQL, SQL Server (MSSQL), MongoDB, and Elasticsearch, each with a dialect-aware editor, autocomplete, query templates, and default result view.
- **Monaco editor** — syntax highlighting and schema-aware autocomplete (tables, columns, PK and 🔐 PHI markers; Mongo `db.collection.find()` style; ES `/_search` paths). Language adapts to the connection type.
- **Multi-tab workspace** — independent tabs, inline rename, per-tab schema selection, and run-selection-or-whole-query (Cmd/Ctrl+Enter).
- **Schema browser** — connections grouped by environment; lazy table/column tree with PK/type/PHI flags; double-click a table to open a `SELECT * … LIMIT 100` tab; copy table metadata as **JSON / DDL / text**.
- **Results grid** (AG Grid) — sort/filter/resize, type-aware cell coloring, table ↔ **JSON view** toggle, row count / exec time / truncation badges.
- **Cell inspector drawer** — click a long cell to open a docked read-only inspector (auto-detects JSON vs text); double-click to copy; hover for a peek.
- **Local-timezone datetimes** — ISO datetime cells show a your-time conversion alongside the original source value on hover.
- **Query history** — your last executed queries, one click to reload.
- **Saved queries** — save (shared by default), search, load into a new tab; used as few-shot examples by the AI assistant.
- **Tab persistence** — open tabs, active connection, and sidebar state survive a reload (results are not persisted).
- **Export** — download results as **CSV or JSON** (masking enforced and audited).

### PHI protection
- **PHI tokenization ("shield")** — pattern-based column matching with four masking types: **FULL** (`********`), **PARTIAL** (last 4 shown), **HASH** (`tok_…` deterministic), **REDACT** (`[REDACTED]`).
- **Per-environment enforcement** — every production environment (any name containing "prod": `PROD`, `SUPER_PROD`, …) is always tokenized and cannot be turned off; the rest of the masked list is configurable. QA/DEV return real values by default.
- **`alwaysMasked` (locked) rules** — never unmask regardless of role or shield state.
- **Audited unmasking** — de-tokenizing requires a reason (and optional notes), is gated per-environment, and is logged with user, IP, session, and timestamp. Unauthorized attempts stay masked and are logged as denied.

### Write workflow (governed)
- **Write mode** with a request → review → approval → execute lifecycle. Globally toggleable by admins.
- **Two-person rule on production** — writes to any production environment (any name containing "prod") always require a second approver and can never be direct-execute; other environments can be configured for direct write.
- **Paired verify SELECT** — every write request carries a read-only SELECT to preview affected rows before execution.
- **AI safety review** — verdict (Safe / Caution / Dangerous), blast-radius estimate, SELECT-matches-write check, and one-click suggested corrections.
- **Single-statement, scoped writes only** — one INSERT/UPDATE/DELETE (or Mongo/ES equivalent); UPDATE/DELETE must be scoped (WHERE required); transactional where the engine supports it.
- **Full lifecycle audit** — submit, AI review, approve/reject, execute/fail, cancel, revise & resubmit — each with an activity timeline.

### AI assistant (Azure OpenAI)
- **Natural-language → query** for read and write modes, dialect-aware, with a table-selection pass for large schemas and few-shot examples pulled from saved queries.
- **Schema-only** — only schema metadata is sent to Azure OpenAI; **never row data**. Every generation is logged (prompt, response, model, tokens, latency) for admin review.

### AI agents (MCP)
- **Hosted MCP endpoint** at `/api/mcp` — agents discover connections, browse schema, and run read-only queries through the same API the UI uses, so capabilities, PHI tokenization, row caps and audit logging all apply unchanged. Configure with just a URL, username, and password; nothing to install.

### Access control & governance
- **Capability-based access control** — each user has an `isAdmin` flag plus four **per-environment** capability lists: **read**, **unmask PHI**, **write**, and **approve**. Admin implies all capabilities on all environments.
- **Audit log** — every query, error, export, PHI unmask (and denial), and write-lifecycle event is recorded, with date/type filtering and automatic 30-day archival to a separate database.
- **Usage analytics** — admin dashboard: users, DAU/WAU/MAU, query volume/latency, AI usage and success rate, PHI unmasks, top users, per-connection activity.
- **Read-only enforcement** — the read path blocks all DML/DDL; writes only ever go through the governed write workflow (a separate executor).
- **White-label branding** — custom app name, logo (light/dark), and favicon via environment variables.
- **Installable app (PWA)** — install to the desktop or home screen for a standalone window with an identical UI; the manifest picks up `APP_NAME`, and new deploys prompt to reload. No API response is ever cached, so PHI never reaches on-disk storage. See [Install as an App](#install-as-an-app-pwa).

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 19, TypeScript, Vite, Mantine UI v8, Monaco Editor, AG Grid, Zustand |
| Backend | Node.js, Express, TypeScript |
| App Database | SQLite (via better-sqlite3, WAL mode) |
| Auth | JWT (bcrypt + jsonwebtoken) |
| AI | Azure OpenAI (optional) |

## Quick Start

```bash
# Install dependencies
npm install

# Copy and configure environment
cp .env.example .env
# Edit .env with your settings (see Configuration below)

# Development (hot-reload client + server)
npm run dev

# Production build
npm run build
npm start
```

By default, the dev client runs at `http://localhost:3100` and the server at `http://localhost:3101`.

### Changing ports

Both ports are configured in `.env`:

| Variable | Purpose | Default |
|----------|---------|---------|
| `PORT` | Server port (also used as proxy target in dev) | `3101` |
| `VITE_PORT` | Dev client port | `3100` |

## Configuration

Copy `.env.example` to `.env` and set the following:

```env
# Server
PORT=3101
VITE_PORT=3100
NODE_ENV=production

# JWT — CHANGE THIS to a random string (e.g. openssl rand -hex 32)
JWT_SECRET=<your-random-secret-here>
JWT_EXPIRES_IN=24h

# Branding
APP_NAME="Your App Name"
LOGO_URL=/logo/your-logo.svg          # dark-background logo (or leave empty for text-only)
LIGHT_LOGO_URL=/logo/your-logo-light.svg  # optional light-background variant
FAVICON_URL=/logo/favicon.svg         # optional

# Email domain — enforced on user creation, used for the default admin seed
EMAIL_DOMAIN=yourcompany.com

# Default admin password (only used on first run to seed the admin user)
DEFAULT_ADMIN_PASSWORD=<strong-password>

# Database connections — JSON array
DBFORGE_CONNECTIONS='[
  {
    "id": "qa-pg",
    "name": "QA PostgreSQL",
    "env": "QA",
    "type": "postgres",
    "host": "your-db-host",
    "port": 5432,
    "database": "your_database",
    "username": "your_user",
    "password": "your_password",
    "schema": "public"
  }
]'

# Query safety
MAX_ROWS=10000            # hard cap on returned rows
QUERY_TIMEOUT_MS=90000    # per-query timeout

# MCP endpoint for AI agents — rows returned per query (agents may raise per call)
MCP_MAX_ROWS=1000

# Schema cache (autocomplete + AI); hours, 0 disables
SCHEMA_CACHE_TTL_HOURS=24

# AI assistant — Azure OpenAI (optional; endpoints return 503 if unset)
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
AZURE_OPENAI_KEY=<your-key>
AZURE_OPENAI_DEPLOYMENT=<your-deployment-name>
AZURE_OPENAI_MODEL=gpt-4o           # optional, informational
# AZURE_OPENAI_API_VERSION=2024-08-01-preview
# AZURE_OPENAI_INSECURE_TLS=true    # only for TLS-inspecting corporate proxies
```

> **Note:** PHI masking and the write workflow are configured **in-app** (Settings), not
> via environment variables — masked environments, PHI rules, write-mode toggle, and
> direct-write environments are stored in the SQLite app database. (The legacy
> `PHI_ALWAYS_MASKED` / `PHI_ADMIN_CAN_UNMASK` env vars are no longer read.)

### Supported connection types

| Type | Required fields |
|------|----------------|
| `postgres` | host, port, database, username, password, schema (optional) |
| `mssql` | host, port, database, username, password |
| `mongodb` | uri (full connection string) |
| `elasticsearch` | host, port, username, password, and `schema` set to `http` or `https` (used as the protocol) |

### Access model

Access is **capability-based and scoped per environment** (`DEV`, `QA`, `UAT`, `STG`, `PROD`
by default — see [Custom environments](#custom-environments)).
Each user has an `isAdmin` flag plus four capability lists, managed from **Settings → User Management**:

| Capability | Grants |
|-----------|--------|
| **Read** (`allowedEnvironments`) | Query connections in those environments |
| **Unmask PHI** (`unmaskEnvironments`) | De-tokenize PHI (still audited) in those environments |
| **Write** (`writeEnvironments`) | Author write requests for those environments |
| **Approve** (`approveEnvironments`) | Approve others' write requests in those environments |

Admin implies every capability on every environment. Production safety rails (mandatory
PHI tokenization and two-person write approval) always apply regardless of capabilities,
on every environment whose name contains "prod" — see [Custom environments](#custom-environments).

### Custom environments

The environment list is **not** hardcoded — it is derived from the `env` values in
`DBFORGE_CONNECTIONS`. Adding a connection with a new `env` is all it takes:

```jsonc
{ "id": "sp-pg", "name": "Super Prod PostgreSQL", "env": "SUPER_PROD", "type": "postgres", … }
```

After a restart, `SUPER_PROD` shows up on its own in the connection tree, the four
capability pickers in **Settings → User Management**, the PHI masked-environment toggles
and the write policy. Only environments the deployment actually has are accepted by the
API, so a stale name can't be granted to anyone.

Notes:
- Custom names sort **after** `PROD` and are treated as the most sensitive.
- **Any environment whose name contains "prod" gets the full production rails** —
  `PROD`, `SUPER_PROD` and `PREPROD` alike are always PHI-tokenized and can never be
  direct-write (every change needs a second approver). Both toggles for them in
  **Settings** are locked. Naming a production environment something new does not opt
  it out.
- Existing users don't gain a new environment automatically; grant it per user.

## MCP Server (AI agents)

D-Pilot hosts a **read-only** [MCP](https://modelcontextprotocol.io) endpoint at
**`/api/mcp`**, so AI agents can query the same databases under the same rules as the UI.
It runs inside the existing server process — nothing extra to deploy, install, or clone.
Agents just point at the URL everyone already uses.

Its tools call D-Pilot's own REST API over loopback, so environment capabilities, PHI
tokenization, row limits and audit logging are enforced exactly as they are for the UI and
cannot be bypassed. Every agent query lands in the audit log under its service account.

| Tool | Does |
|------|------|
| `whoami` | Which account is connected and which environments it may read |
| `list_connections` | Databases available, per environment (optional `env` filter) |
| `list_schemas` | Schemas on a connection (Postgres/SQL Server) |
| `list_tables` | Tables, collections or indices |
| `describe_table` | Columns, types, nullability |
| `run_query` | Runs a read-only query, returns rows |

Writes are deliberately **not** exposed — those stay in the write-approval workflow, where a
human authors the paired verify SELECT and a second person approves.

### Setup

1. **Create a service account** in Settings → User Management. Grant *only* the Read
   capability, on *only* the environments agents should reach — no Unmask PHI, no Write, no
   Approve, not an admin. This is what bounds every agent using it.
2. **Point the agent at the URL** with its username and password. For Claude Code:

   ```bash
   claude mcp add --transport http d-pilot https://d-pilot.internal/api/mcp \
     --header "Authorization: Basic $(printf 'agent@example.com:the-password' | base64)"
   ```

   Or in any MCP client's config file:

   ```json
   {
     "mcpServers": {
       "d-pilot": {
         "type": "http",
         "url": "https://d-pilot.internal/api/mcp",
         "headers": { "Authorization": "Basic YWdlbnRAZXhhbXBsZS5jb206dGhlLXBhc3N3b3Jk" }
       }
     }
   }
   ```

   That `Basic` value is just `base64("username:password")` — generate it with
   `printf 'user:pass' | base64`.

**Why Basic auth:** MCP clients can send static headers but cannot run D-Pilot's
username/password login flow, so `/api/mcp` accepts the credentials directly and exchanges
them for a normal JWT internally (kept in memory, never on disk, refreshed automatically).
Because the credentials cross the network on every request, **serve D-Pilot over HTTPS** if
agents connect from other machines — see the reverse-proxy section below.

Optional server-side setting:

| Variable | Default | Purpose |
|----------|---------|---------|
| `MCP_MAX_ROWS` | `1000` | Rows returned per query. Agents are told this default (via `whoami` and the `run_query` schema) and can raise it per call with `limit`; `MAX_ROWS` remains the hard ceiling. |

**PHI:** the endpoint never sends the unmask headers, so tokenized columns stay tokenized for
agents regardless of the account's capabilities. `run_query` names the tokenized columns so an
agent doesn't mistake mask characters for real values. Unmasking stays a UI-only action that
requires a human-supplied reason.

**Revoking access:** delete (or change the password of) the service account. Note this stops
*new* logins but does not kill a token already issued — as everywhere else in D-Pilot, a JWT
stays valid until it expires, so revocation takes effect within `JWT_EXPIRES_IN` (24h by
default). Lower that value if you need a tighter window.

## Install as an App (PWA)

D-Pilot is a Progressive Web App, so it can be installed as a standalone desktop or
home-screen app. The installed app is **the web app, unchanged** — same layout, same
routes, same behavior — just in its own window without browser chrome.

**Installing.** In Chrome or Edge, use the install icon in the address bar, or the
**Install** button in the footer (it appears only while the browser reports the app as
installable, and disappears once installed). On iOS, use Safari's *Share → Add to Home
Screen*.

A service worker requires a **secure context**: HTTPS, or `localhost`. Behind the Nginx
setup below with a certificate, this works out of the box; over plain `http://<lan-ip>` the
app still runs normally but cannot be installed.

**Branding.** The manifest is rendered by Express at `/manifest.webmanifest` from
`APP_NAME`, so the installed app carries your deployment's own name. The icons are the
bundled PNGs in `public/` (`pwa-192.png`, `pwa-512.png`, `pwa-maskable-512.png`,
`apple-touch-icon.png`) — installers require raster icons at declared sizes, so unlike
`LOGO_URL` they are not taken from a URL. To use your own mark, either replace those files
or edit `scripts/generate-pwa-icons.mjs` and run:

```bash
npm run icons:pwa
```

**Updates.** After a deploy, open clients show a *New version available* notification with
a **Reload** button. Nothing reloads on its own — an unattended reload would discard open
editor tabs and any in-flight query.

**What is cached — and what is deliberately not.** Only the app shell is cached (HTML, JS,
CSS, icons, fonts; ~2.5 MB), plus the Monaco editor and its language workers fetched on
first use (~10 MB, kept out of the install so it stays lean).

> **No API response is ever cached.** Query results, schema listings, saved queries,
> exports and audit records all carry PHI, and Cache Storage is unencrypted on disk and
> survives a logout. Every `/api` call goes to the network every time, which is enforced by
> a test (`vite.pwa.config.test.ts`). The practical consequence: the installed app is not
> usable offline — it will load and show its shell, but running a query needs the server.
> Offline write queueing is likewise absent by design, since replaying writes later would
> reorder the write workflow's audit trail.

The service worker is disabled in `npm run dev` (it would serve stale modules and break
HMR). Verify PWA behavior against a production build — `npm run build && npm start`.

## First-Run Behavior

- SQLite database created at `data/dbpilot.sqlite` (WAL mode)
- Default admin user seeded: `admin@<EMAIL_DOMAIN>` with `DEFAULT_ADMIN_PASSWORD`, granted all capabilities on all environments
- Default PHI masking rules seeded (name / DOB / phone / email / address / ZIP patterns, PARTIAL masking)
- Default app settings seeded: PHI masked on `PROD`, write mode enabled, direct-write on `DEV`

---

## Deployment

### 1. Clone & Install

```bash
git clone <repo-url> /opt/d-pilot
cd /opt/d-pilot
npm install
```

### 2. Build

```bash
npm run build
```

This produces:
- `dist/client/` — optimized frontend (HTML, JS, CSS)
- `dist/server/` — compiled backend

### 3. Run

```bash
npm start
```

The app will be available at `http://<server-ip>:<PORT>` (default `3101`, configurable via `.env`).

### 4. Brand Assets (Optional)

If you set `LOGO_URL=/logo/your-logo.svg`, place the file at:

```bash
mkdir -p public/logo
cp /path/to/your-logo.svg public/logo/your-logo.svg
```

For custom fonts (e.g. Barlow):

```bash
mkdir -p public/fonts/Barlow
cp /path/to/Barlow-*.ttf public/fonts/Barlow/
```

> These directories are gitignored — they won't be pushed back to the repo.

### 5. Run as a Background Service (systemd)

Create `/etc/systemd/system/d-pilot.service`:

```ini
[Unit]
Description=D-Pilot Internal Query Tool
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/d-pilot
ExecStart=/usr/bin/node dist/server/index.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Ensure the `www-data` user owns the application directory:

```bash
sudo chown -R www-data:www-data /opt/d-pilot
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable d-pilot
sudo systemctl start d-pilot

# Check status
sudo systemctl status d-pilot

# View logs
sudo journalctl -u d-pilot -f
```

### 6. Reverse Proxy (Optional but Recommended)

To serve on port 80/443 or add SSL, put Nginx in front.

Install: `sudo apt install nginx` (Ubuntu/Debian)

Create `/etc/nginx/sites-available/d-pilot`:

```nginx
server {
    listen 80;
    server_name _;    # or your domain/IP

    location / {
        proxy_pass http://127.0.0.1:3101;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/d-pilot /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

Now accessible at `http://<server-ip>` (port 80).

#### Adding SSL with Let's Encrypt (if you have a domain):

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

### 7. Firewall

```bash
# If using Nginx (port 80/443)
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# If accessing Node directly (port 3101)
sudo ufw allow 3101/tcp
```

## Updating

```bash
cd /opt/d-pilot
git pull
npm install
npm run build

# Restart the service
sudo systemctl restart d-pilot    # systemd
# or
pm2 restart d-pilot               # pm2
```

> The SQLite database (`data/dbpilot.sqlite`) persists across updates. Users, saved
> queries, PHI rules, audit logs, write requests, and settings are preserved.

## Backup

The stateful files live in `data/` — back them up regularly:

```bash
cp data/dbpilot.sqlite data/dbpilot-backup-$(date +%Y%m%d).sqlite
# audit_archive.sqlite holds audit entries older than 30 days
cp data/audit_archive.sqlite data/audit_archive-backup-$(date +%Y%m%d).sqlite
```

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `EADDRINUSE` on startup | Another process is using the port. `lsof -i :3101` to find it |
| Database connection errors | Verify the server can reach DB hosts: `telnet <host> <port>` |
| AI assistant returns 503 | Set the `AZURE_OPENAI_*` env vars; use **Settings → Azure OpenAI → Test Connect** |
| Logo not showing | Check file exists at `public/logo/` and `LOGO_URL` matches the path |
| Forgot admin password | Delete `data/dbpilot.sqlite` and restart — re-seeds from `.env` |
| Permission denied on `data/` | `chown -R www-data:www-data /opt/d-pilot/data` |
