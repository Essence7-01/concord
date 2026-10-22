# Deploying on a VPS with systemd

Concord is a single Node.js process that serves both the HTTP API and the compiled web dashboard while running the background Stellar RPC indexer against local SQLite databases ([`services/api/src/main.ts`](../../services/api/src/main.ts)). On a Linux VPS (Debian, Ubuntu, Rocky, or Fedora), you can run it directly under `systemd` without Docker.

---

## 1. Install Node 24 and Enable `pnpm`

Concord requires **Node 24+** (`node:sqlite` is built into the runtime) and **pnpm 10.22** as pinned in [`package.json`](../../package.json#L6-L10).

Install Node 24 from your distribution or the NodeSource repository, then enable Corepack so it activates the pinned `pnpm@10.22.0` binary:

```sh
node --version          # must be v24.x.x or newer
sudo corepack enable
pnpm --version          # 10.22.0
```

---

## 2. Create a Dedicated User and Directories

Run Concord under an unprivileged system user with its own application and data directories:

```sh
sudo useradd --system --home-dir /var/lib/concord --create-home --shell /usr/sbin/nologin concord
sudo mkdir -p /opt/concord /var/lib/concord/data /etc/concord
sudo chown -R concord:concord /opt/concord /var/lib/concord
sudo chown root:concord /etc/concord
sudo chmod 0750 /etc/concord
```

- `/opt/concord`: holds the git checkout and built output (`packages/core/dist`, `services/api/dist`, `apps/web/dist`).
- `/var/lib/concord/data`: holds `control.db` and per-workspace databases under `orgs/<orgId>.db` (`CONCORD_DATA_DIR`, configured in [`services/api/src/config.ts`](../../services/api/src/config.ts#L165)).
- `/etc/concord/concord.env`: holds environment variables and secrets, readable only by `root` and `concord`.

---

## 3. Clone and Build

Clone the repository into `/opt/concord`, install dependencies with the frozen lockfile, and build all workspace packages:

```sh
sudo -u concord git clone https://github.com/useconcord/concord.git /opt/concord
cd /opt/concord
sudo -u concord pnpm install --frozen-lockfile
sudo -u concord pnpm build
```

`pnpm build` compiles `@concord/core`, `@concord/api` (`services/api/dist/main.js`), and the static dashboard bundle (`apps/web/dist`).

---

## 4. Configure `/etc/concord/concord.env`

Create `/etc/concord/concord.env` based on [`.env.example`](../../.env.example) and [`services/api/src/config.ts`](../../services/api/src/config.ts):

```ini
NODE_ENV=production
CONCORD_HOST=127.0.0.1
CONCORD_PORT=4400
CONCORD_DATA_DIR=/var/lib/concord/data
CONCORD_PUBLIC_URL=https://concord.example.com
CONCORD_TRUST_PROXY=1
CONCORD_SIGNUP=code

# Optional: dedicated Stellar Mainnet RPC provider
# CONCORD_MAINNET_RPC_URLS=https://your-rpc-provider.example.com

# Optional: Google OAuth (both must be set together if used)
# CONCORD_GOOGLE_CLIENT_ID=...
# CONCORD_GOOGLE_CLIENT_SECRET=...
```

Lock down permissions on the environment file:

```sh
sudo chown root:concord /etc/concord/concord.env
sudo chmod 0640 /etc/concord/concord.env
```

Keeping `CONCORD_HOST=127.0.0.1` binds the HTTP server to the loopback interface so only a local TLS reverse proxy (such as Caddy or Nginx) can reach port `4400`. Set `CONCORD_TRUST_PROXY=1` when one local reverse proxy forwards `X-Forwarded-For` (`services/api/src/config.ts#L171`, `services/api/src/auth-api.ts#L27`).

---

## 5. Create the `systemd` Unit File

Write `/etc/systemd/system/concord.service`:

```ini
[Unit]
Description=Concord Stellar Securities Reconciliation Service
Documentation=https://github.com/useconcord/concord
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=concord
Group=concord
WorkingDirectory=/opt/concord
EnvironmentFile=/etc/concord/concord.env
ExecStart=/usr/bin/node /opt/concord/services/api/dist/main.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=15

# Hardening: only /var/lib/concord is writable
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/concord

[Install]
WantedBy=multi-user.target
```

Enable and start the service:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now concord.service
```

Verify the server is listening and `control.db` initialized cleanly (`services/api/src/api.ts#L81-L84`):

```sh
curl -fsS http://127.0.0.1:4400/api/health
# {"ok":true}
```

---

## 6. Inspecting Logs with `journalctl`

Concord writes startup information, indexer progress (`sync <orgId>/<assetId>: +N events`), errors, and graceful shutdown messages (`SIGTERM: shutting down` in [`services/api/src/main.ts`](../../services/api/src/main.ts#L125-L161)) to standard output and standard error, which `systemd` captures in the journal:

```sh
# Follow live logs
sudo journalctl -u concord.service -f

# Show logs since the last boot or within the last hour
sudo journalctl -u concord.service -b
sudo journalctl -u concord.service --since "1 hour ago"

# Filter for errors or warnings
sudo journalctl -u concord.service -p err..warning
```

---

## 7. Running Operator CLI Commands

The `pnpm concord` CLI ([`services/api/src/cli.ts`](../../services/api/src/cli.ts)) reads the same `CONCORD_DATA_DIR` and uses SQLite WAL mode with a 5-second `busy_timeout` (`services/api/src/db.ts#L20`), so it is safe to run while `concord.service` is active. Always run CLI commands as the `concord` user with the same environment file:

```sh
cd /opt/concord
sudo -u concord sh -c 'set -a; . /etc/concord/concord.env; set +a; pnpm concord signup-code --note "onboarding"'
sudo -u concord sh -c 'set -a; . /etc/concord/concord.env; set +a; pnpm concord orgs'
```

See [`docs/operator-guide.md`](../operator-guide.md) and [`docs/cli.md`](../cli.md) for all operator and workspace commands.

---

## 8. Backing Up and Updating

### Taking a Consistent Backup

Because `control.db` and `orgs/*.db` run in WAL mode (`services/api/src/db.ts#L20`), do not copy raw `.db` files with `cp` while the service is running. Use `pnpm concord backup`, which invokes SQLite's online backup API across `control.db` and every workspace database (`services/api/src/cli.ts#L132-L138`):

```sh
cd /opt/concord
sudo -u concord sh -c 'set -a; . /etc/concord/concord.env; set +a; pnpm concord backup /var/lib/concord/backups/$(date -u +%Y%m%dT%H%M%SZ)'
```

### Updating Concord

Migrations in [`services/api/src/schema.ts`](../../services/api/src/schema.ts) are forward-only (`docs/upgrading.md`). Always take a backup before pulling a new version:

```sh
cd /opt/concord

# 1. Back up the databases while the old version runs
sudo -u concord sh -c 'set -a; . /etc/concord/concord.env; set +a; pnpm concord backup /var/lib/concord/backups/pre-upgrade'

# 2. Fetch and build the new version
sudo -u concord git fetch origin main
sudo -u concord git checkout main
sudo -u concord git pull --ff-only origin main
sudo -u concord pnpm install --frozen-lockfile
sudo -u concord pnpm build

# 3. Restart the service (migrations run automatically on startup)
sudo systemctl restart concord.service

# 4. Verify health and logs
curl -fsS http://127.0.0.1:4400/api/health
sudo journalctl -u concord.service -n 50 --no-pager
```

If an upgrade needs to be rolled back, follow the backup-restore steps in [`docs/upgrading.md`](../upgrading.md#rolling-back).
