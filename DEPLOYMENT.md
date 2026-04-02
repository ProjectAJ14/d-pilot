# D-Pilot — Deployment Guide

This guide covers deploying D-Pilot on a server accessible via IP address.

---

## Prerequisites

- **Node.js** >= 20.x (`node -v` to check)
- **npm** >= 10.x
- **Git** (to clone the repo)
- Network access from the server to your database hosts (PostgreSQL, SQL Server, MongoDB, Elasticsearch)

---

## 1. Clone & Install

```bash
git clone <repo-url> /opt/d-pilot
cd /opt/d-pilot
npm install
```

---

## 2. Configure Environment

```bash
cp .env.example .env
nano .env    # or vi, your choice
```

### Required settings:

```env
# Server
PORT=3101
NODE_ENV=production

# JWT — CHANGE THIS to a random string (e.g. openssl rand -hex 32)
JWT_SECRET=<your-random-secret-here>
JWT_EXPIRES_IN=24h

# Branding
APP_NAME="Your App Name"
LOGO_URL=/logo/your-logo.svg    # or leave empty for text-only

# Email domain — enforced on user creation, used for default admin seed
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

# PHI Masking
PHI_ALWAYS_MASKED=true
PHI_ADMIN_CAN_UNMASK=true

# Query Safety
MAX_ROWS=10000
QUERY_TIMEOUT_MS=30000
```

### Connection types supported:

| Type | Required fields |
|------|----------------|
| `postgres` | host, port, database, username, password, schema (optional) |
| `mssql` | host, port, database, username, password |
| `mongodb` | uri (full connection string) |
| `elasticsearch` | host, port, username, password, schema (`http` or `https`) |

---

## 3. Add Brand Assets (Optional)

If you set `LOGO_URL=/logo/your-logo.svg`, place the file at:

```bash
mkdir -p public/logo
cp /path/to/your-logo.svg public/logo/your-logo.svg
```

For custom fonts (e.g. Barlow), place them in:

```bash
mkdir -p public/fonts/Barlow
cp /path/to/Barlow-*.ttf public/fonts/Barlow/
```

> These directories are gitignored — they won't be pushed back to the repo.

---

## 4. Build

```bash
npm run build
```

This produces:
- `dist/client/` — optimized frontend (HTML, JS, CSS)
- `dist/server/` — compiled backend

---

## 5. Run

```bash
npm start
```

The app will be available at `http://<server-ip>:3101`.

### First-run behavior:
- SQLite database created at `data/dbpilot.sqlite`
- Default admin user seeded: `admin@<EMAIL_DOMAIN>` with `DEFAULT_ADMIN_PASSWORD`
- 24 default PHI masking rules seeded

---

## 6. Run as a Background Service

### Option A: systemd (recommended for Linux)

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

```bash
sudo systemctl daemon-reload
sudo systemctl enable d-pilot
sudo systemctl start d-pilot

# Check status
sudo systemctl status d-pilot

# View logs
sudo journalctl -u d-pilot -f
```

### Option B: pm2

```bash
npm install -g pm2

cd /opt/d-pilot
pm2 start dist/server/index.js --name d-pilot
pm2 save
pm2 startup    # generates system startup script
```

```bash
# Useful commands
pm2 status
pm2 logs d-pilot
pm2 restart d-pilot
```

---

## 7. Reverse Proxy (Optional but Recommended)

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

### Adding SSL with Let's Encrypt (if you have a domain):

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

---

## 8. Firewall

Open the required port:

```bash
# If using Nginx (port 80/443)
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# If accessing Node directly (port 3101)
sudo ufw allow 3101/tcp
```

---

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

> The SQLite database (`data/dbpilot.sqlite`) persists across updates. Users, saved queries, PHI rules, and audit logs are preserved.

---

## Backup

The only stateful file is `data/dbpilot.sqlite`. Back it up regularly:

```bash
cp data/dbpilot.sqlite data/dbpilot-backup-$(date +%Y%m%d).sqlite
```

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `EADDRINUSE` on startup | Another process is using the port. `lsof -i :3101` to find it |
| Database connection errors | Verify the server can reach DB hosts: `telnet <host> <port>` |
| Logo not showing | Check file exists at `public/logo/` and `LOGO_URL` matches the path |
| Forgot admin password | Delete `data/dbpilot.sqlite` and restart — re-seeds from `.env` |
| Permission denied on `data/` | `chown -R www-data:www-data /opt/d-pilot/data` |
