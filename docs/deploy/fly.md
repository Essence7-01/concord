# Deploying on Fly.io with a Persistent Volume

Concord builds into a single container image ([`Dockerfile`](../../Dockerfile)) that serves both the HTTP API and the web dashboard on port `4400` while running the background Stellar RPC indexer against SQLite databases under `/data` ([`services/api/src/config.ts`](../../services/api/src/config.ts#L165)). This guide covers deploying Concord on Fly.io with a persistent volume, configuring Google OAuth secrets, wiring the `/api/health` check, enforcing a single-machine topology, and managing volume snapshots.

---

## 1. Create the Fly App and Persistent Volume

From a checkout of the repository, create a new Fly application without deploying yet:

```sh
fly apps create concord-prod
```

Create a persistent volume named `concord_data` in your target region (for example, `iad`). Concord stores `control.db` and every workspace database (`orgs/<orgId>.db`) on this volume:

```sh
fly volumes create concord_data --app concord-prod --region iad --size 10
```

---

## 2. Configure `fly.toml` (Single Machine Only)

Create `fly.toml` in the repository root. Because Concord runs an in-process background indexer (`services/api/src/main.ts#L133-L155`) and writes to local SQLite files in WAL mode (`services/api/src/db.ts#L20`), it must run as **one always-on machine** (`min_machines_running = 1`, `auto_stop_machines = "off"`):

```toml
app = "concord-prod"
primary_region = "iad"

[build]
  dockerfile = "Dockerfile"

[env]
  CONCORD_HOST = "0.0.0.0"
  CONCORD_PORT = "4400"
  CONCORD_DATA_DIR = "/data"
  CONCORD_PUBLIC_URL = "https://concord-prod.fly.dev"
  CONCORD_TRUST_PROXY = "1"
  CONCORD_SIGNUP = "code"

[[mounts]]
  source = "concord_data"
  destination = "/data"
  initial_size = "10gb"

[http_service]
  internal_port = 4400
  force_https = true
  auto_stop_machines = "off"
  auto_start_machines = true
  min_machines_running = 1

  [[http_service.checks]]
    interval = "30s"
    timeout = "5s"
    grace_period = "20s"
    method = "GET"
    path = "/api/health"

[[vm]]
  size = "shared-cpu-1x"
  memory = "512mb"
```

Key settings verified against [`services/api/src/config.ts`](../../services/api/src/config.ts):
- **`CONCORD_DATA_DIR = "/data"`:** Matches the `Dockerfile` default (`Dockerfile#L35`) where the `concord_data` volume is mounted.
- **`CONCORD_PUBLIC_URL`:** Must be the `https://` origin users open in their browser. It determines `Secure` session cookie flags and the Google OAuth callback URL (`services/api/src/config.ts#L54-L55`).
- **`CONCORD_TRUST_PROXY = "1"`:** Tells Concord to trust one `X-Forwarded-For` hop from Fly's edge proxy for per-IP rate limiting (`services/api/src/config.ts#L171`, `services/api/src/auth-api.ts#L27`).
- **`auto_stop_machines = "off"`:** Keeps the background indexer running continuously so watched assets do not fall behind the Stellar RPC retention window (`README.md#L158-L160`).

---

## 3. Secrets for Google OAuth and RPC Providers

Never commit OAuth credentials or private RPC API keys to `fly.toml`. Set them with `fly secrets set` so Fly injects them as runtime environment variables:

```sh
# Optional: Google OAuth sign-in (both must be set together; see services/api/src/config.ts#L185-L192)
fly secrets set \
  CONCORD_GOOGLE_CLIENT_ID="your-client-id.apps.googleusercontent.com" \
  CONCORD_GOOGLE_CLIENT_SECRET="your-client-secret" \
  --app concord-prod

# Optional: Dedicated Stellar Mainnet RPC endpoint and auth headers
fly secrets set \
  CONCORD_MAINNET_RPC_URLS="https://your-rpc-provider.example.com" \
  CONCORD_RPC_HEADERS='{"your-rpc-provider.example.com":{"Authorization":"Bearer YOUR_TOKEN"}}' \
  --app concord-prod
```

In the Google Cloud Console, register `<CONCORD_PUBLIC_URL>/api/auth/google/callback` as an Authorized redirect URI (see [`docs/google-signin.md`](../google-signin.md)).

---

## 4. Deploy and Verify the Health Check

Deploy the application with the `--ha=false` flag so Fly creates **only one machine** attached to your `concord_data` volume:

```sh
fly deploy --ha=false --app concord-prod
```

### Health Check Behavior

Both the [`Dockerfile`](../../Dockerfile#L38-L39) and `[[http_service.checks]]` in `fly.toml` poll `GET /api/health` (`services/api/src/api.ts#L81-L84`), which queries `auth.orgIds()` against `/data/control.db` and returns `200 OK` with `{"ok":true}`:

```sh
curl -fsS https://concord-prod.fly.dev/api/health
# {"ok":true}
```

### Running Operator CLI Commands

To generate a sign-up code or password reset link (`services/api/src/cli.ts`), open an SSH console into the running machine:

```sh
fly ssh console --app concord-prod -C "pnpm concord signup-code --note 'initial-owner'"
fly ssh console --app concord-prod -C "pnpm concord orgs"
```

---

## 5. Scaling Warnings (Single Process and One Disk)

- **Never scale above 1 machine (`fly scale count 1`):** Fly volumes are attached to a single machine at a time. Scaling to two or more machines creates a second instance either without a volume or with a separate empty volume. Because accounts, sessions, and workspaces live in local SQLite files (`/data/control.db` and `/data/orgs/*.db`), multiple machines will have split state, failed session lookups, and duplicate RPC indexing.
- **Check machine count after deploy:**
  ```sh
  fly status --app concord-prod
  ```
  If Fly created a standby machine, destroy the extra machine or run `fly scale count 1 --app concord-prod`.
- **Vertical scaling is safe:** You can increase memory or CPU on the single machine (`fly scale memory 1024 --app concord-prod` or `fly scale vm shared-cpu-2x --app concord-prod`) without affecting the `/data` volume.

---

## 6. Volume Snapshots and Backups

### Fly Volume Snapshots

Fly automatically takes daily block-level snapshots of attached volumes and retains them for 5 days by default. You can list snapshots or trigger an on-demand snapshot before an upgrade:

```sh
# List existing volume IDs
fly volumes list --app concord-prod

# Create an on-demand snapshot and check snapshot history
fly volumes snapshots create <vol_id> --app concord-prod
fly volumes snapshots list <vol_id> --app concord-prod
```

### Application-Level SQLite Backups

Because SQLite runs in WAL mode (`services/api/src/db.ts#L20`), a block snapshot taken mid-write relies on WAL recovery when restored. For a clean application-level backup before upgrading (`docs/upgrading.md#take-a-backup-first`), run `pnpm concord backup` inside the machine and copy the archive off-host with `fly sftp`:

```sh
fly ssh console --app concord-prod -C "pnpm concord backup /tmp/backup-pre-upgrade"
fly ssh console --app concord-prod -C "tar czf /tmp/backup-pre-upgrade.tgz -C /tmp backup-pre-upgrade"
fly sftp get /tmp/backup-pre-upgrade.tgz ./backup-pre-upgrade.tgz --app concord-prod
fly ssh console --app concord-prod -C "rm -rf /tmp/backup-pre-upgrade /tmp/backup-pre-upgrade.tgz"
```
