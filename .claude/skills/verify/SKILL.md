---
name: verify
description: How to launch and drive D-Pilot locally to verify changes end-to-end (dev servers, login, simulating unreachable databases).
---

# Verifying D-Pilot changes

## Launch

- `npm run dev` — Express API + Vite client together. Ports come from `.env`
  (`PORT` for the API, `VITE_PORT` for the client; Vite proxies `/api` → the API).
  `predev` frees the ports first — it will kill an already-running dev instance.
- Health check: `curl http://localhost:$PORT/api/health` → `{"status":"ok",...}`.

## Login / API auth

- Admin user is `admin@$EMAIL_DOMAIN` with password `$DEFAULT_ADMIN_PASSWORD` (both in `.env`).
- Get a JWT: `POST /api/auth/login` with `{"username","password"}` → `{token}`; pass as
  `Authorization: Bearer <token>` to everything else.

## Simulating unreachable databases (VPN-off / connection-failure paths)

Don't edit `.env`. Launch a second isolated stack with connections overridden on the
command line (command-line env wins over dotenv):

```bash
PORT=3199 DBFORGE_CONNECTIONS='[{"id":"bad-pg","name":"Bad PG","type":"postgres","env":"QA","host":"nonexistent-host.invalid","port":5432,"database":"foo","username":"u","password":"p","schema":"public"}]' npx tsx server/index.ts
PORT=3199 VITE_PORT=3198 npx vite   # client on :3198 proxying to :3199
```

Gotchas:
- The connection JSON field is **`env`** (e.g. `"QA"`), not `environment` — the sidebar
  groups by `conn.env` and silently shows "No connections configured" if it's missing.
- `host: "nonexistent-host.invalid"` fails fast (DNS); MongoDB takes ~10s
  (serverSelectionTimeoutMS) — useful for observing loading states.
- Both stacks share `data/dbpilot.sqlite`, so the same admin login works.

## Driving the UI

Use **Playwright MCP** (project `.mcp.json`), not claude-in-chrome — it's the
project-configured MCP. `.mcp.json` pins `--browser chrome`, so a local Chrome install
is required; drop that flag to fall back to Playwright's bundled Chromium (e.g. in CI).
Navigate to the client port, fill the two login fields,
then interact with the Explorer sidebar / query editor. Mantine `Select` dropdowns render
options in a portal — snapshot `[role="listbox"]` after clicking the input.

## Notes

- `npm run lint` is currently broken (eslint isn't in devDependencies).
- `npm run build` (vite + tsc for server) is the type-check gate.
