# Auto-deploy on push to `main`

Polls `origin/main` on the server and runs `deploy.sh` when it moves, so pushing to
`main` deploys itself — no SSH, no manual run.

Implemented as a **systemd timer** rather than cron: the unit name
(`dpilot-autodeploy`) is the handle for status, logs, stop and "when does it next run",
all of which cron would make you build yourself. The service runs as root, so
`deploy.sh` gets its `sudo` implicitly — no `sudo` inside the poller, no sudoers edits.

## Install

### 1. Poller script

Lives outside the repo, so `git stash` / `git pull` never touch it.

```bash
sudo tee /usr/local/bin/dpilot-autodeploy >/dev/null <<'EOF'
#!/bin/bash
set -euo pipefail
APP_DIR=/opt/d-pilot          # <-- your actual path, the only one to change

cd "$APP_DIR"
git fetch -q origin main
local_sha=$(git rev-parse HEAD)
remote_sha=$(git rev-parse origin/main)

if [ "$local_sha" = "$remote_sha" ]; then
    echo "up to date at ${local_sha:0:7}"
    exit 0
fi

echo "deploying ${local_sha:0:7} -> ${remote_sha:0:7}"
exec ./deploy.sh
EOF
sudo chmod +x /usr/local/bin/dpilot-autodeploy
```

### 2. Service + timer

```bash
sudo tee /etc/systemd/system/dpilot-autodeploy.service >/dev/null <<'EOF'
[Unit]
Description=D-Pilot auto-deploy (poll origin/main)

[Service]
Type=oneshot
ExecStart=/usr/local/bin/dpilot-autodeploy
# A oneshot service inherits TimeoutStartSec=90s. An observed deploy took 58s
# with a warm npm cache, so a cold `npm ci` plus a full build would be killed
# mid-build. No useful deadline exists here — drop it.
TimeoutStartSec=infinity
EOF

sudo tee /etc/systemd/system/dpilot-autodeploy.timer >/dev/null <<'EOF'
[Unit]
Description=Poll origin/main for D-Pilot every 2 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=2min

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
```

### 3. Let root use the checkout

Git refuses to operate on a repo owned by another user. The service runs as root and the
checkout is owned by the deploy user, so without this every run dies instantly with
`fatal: detected dubious ownership` and exit 128.

```bash
sudo git config --system --add safe.directory /opt/d-pilot
```

`--system` (`/etc/gitconfig`) rather than `--global` on purpose: `--global` writes to
`$HOME/.gitconfig`, and a systemd service does not get the `HOME` your interactive `sudo`
session has. That difference is exactly why the poller can succeed when you run it by hand
and still fail under the timer.

### 4. Dry run before arming

```bash
sudo systemctl start dpilot-autodeploy.service          # runs the check right now
sudo journalctl -u dpilot-autodeploy -n 50 --no-pager   # see what it did
```

If that fails, run the poller outside systemd — same environment, error prints straight
to the terminal, no journal permissions involved:

```bash
sudo /usr/local/bin/dpilot-autodeploy
```

### 5. Arm it

```bash
sudo systemctl enable --now dpilot-autodeploy.timer
```

## Operating it

| What you want | Command |
|---|---|
| Is it on? When does it next fire? | `systemctl list-timers dpilot-autodeploy` |
| Did the last run succeed? | `systemctl status dpilot-autodeploy` |
| Watch deploys live | `sudo journalctl -u dpilot-autodeploy -f` |
| Today's history | `sudo journalctl -u dpilot-autodeploy --since today` |
| Only the failures | `sudo journalctl -u dpilot-autodeploy -p err` |
| Deploy now, don't wait | `sudo systemctl start dpilot-autodeploy.service` |
| Pause (returns on reboot) | `sudo systemctl stop dpilot-autodeploy.timer` |
| Stop for good | `sudo systemctl disable --now dpilot-autodeploy.timer` |
| Change the interval | edit the `.timer`, then `sudo systemctl daemon-reload && sudo systemctl restart dpilot-autodeploy.timer` |
| Remove entirely | `sudo systemctl disable --now dpilot-autodeploy.timer && sudo rm /etc/systemd/system/dpilot-autodeploy.{timer,service} /usr/local/bin/dpilot-autodeploy && sudo systemctl daemon-reload` |

A failed deploy leaves the unit in `failed` state (visible in `systemctl status` with the
exit code). The timer keeps ticking, so the next good push heals it.

Overlap is handled: systemd won't start the service again while the previous run is
still going, so a slow `npm ci` can't stack up.

## Notes and gotchas

- **`journalctl` needs `sudo`** unless the deploy user is in the `adm` or
  `systemd-journal` group. Without it you get a bare `-- No entries --` and it looks like
  nothing ever ran.
- **Root must be able to pull without a prompt.** Step 4 proves this. A hang or 403 there
  is a deploy key / credential-helper problem in `/root/.ssh`, not a timer problem.
- **"Works with `sudo`, fails under the timer" is almost always an environment
  difference**, not a permissions one — `sudo` inherits much of your login environment,
  systemd starts from near-nothing. Prefer system-wide config (`/etc/gitconfig`) over
  anything that resolves through `$HOME`.
- **`semantic-release` pushes back to `main`.** Every feature push produces your commit
  *plus* a `chore(release)` commit from CI, so the poller sees two moves and deploys
  twice. Harmless — two restarts instead of one. To avoid it, skip when the newest
  subject matches `[skip ci]`.
- **Restarts are now unattended.** Any merge to `main` bounces the service whenever the
  timer fires. If that's not wanted, point `APP_DIR`'s poller at a `release` branch or a
  tag and merge to it deliberately.
- **`deploy.sh`'s spinner writes `\r` frames to stderr**, so deploy runs look noisy in
  `journalctl`. Readable, just ugly. `exec ./deploy.sh 2>/dev/null` cleans it up at the
  cost of losing real error output.

## Cron alternative

If you'd rather not use systemd — `sudo crontab -e`:

```cron
*/2 * * * * /usr/local/bin/dpilot-autodeploy 2>&1 | logger -t dpilot-autodeploy
```

`logger -t` is the closest cron gets to an ID (read it with
`journalctl -t dpilot-autodeploy`); you stop it by deleting the line. Add
`flock -n /tmp/dpilot-deploy.lock -c` in front of the command to get the overlap
protection systemd gives for free.
