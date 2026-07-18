# Linux + Tailscale deployment

PostgreSQL and immutable raw objects remain on the 16 GB Linux host. No R2 or public ingress is required. Only Web and API ports bind to the configured Tailscale IPv4 address; PostgreSQL and Temporal remain inside the Compose network.

## Host preparation

1. Install Ubuntu 24.04 LTS or Debian 13, Docker Engine with the Compose plugin, and Tailscale.
2. Enable Tailscale SSH or retain a separate recovery path. Put the output of `tailscale ip -4` in `deploy/linux/.env` as `TAILSCALE_BIND_IP`.
3. Create private local storage and configuration:

   ```bash
   sudo install -d -m 0700 /srv/japan-job-agent/{postgres,raw,backups}
   cp deploy/linux/.env.example deploy/linux/.env
   chmod 0600 deploy/linux/.env
   ```

4. Set the GitHub OAuth callback to `${AUTH_URL}/api/auth/callback/github`. The application still allows only `Kaedeeeeeeeeee`.

## Start and verify

```bash
docker compose --env-file deploy/linux/.env -f deploy/linux/compose.yml build
docker compose --env-file deploy/linux/.env -f deploy/linux/compose.yml up -d
curl --fail "http://${TAILSCALE_BIND_IP}:3001/health/ready"
```

Use `tailscale serve --bg --https=443 http://127.0.0.1:3000` when MagicDNS HTTPS is preferred. Keep the WAN firewall closed. For recovery, restore a verified logical backup before starting API and Worker.

Copy the systemd units and timers from `deploy/linux/systemd/` to `/etc/systemd/system/`, adjust `WorkingDirectory`, then enable them:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now japan-job-agent-backup.timer
sudo systemctl enable --now japan-job-agent-discovery-refresh.timer
sudo systemctl enable --now japan-job-agent-public-ats-refresh.timer
sudo systemctl enable --now japan-job-agent-source-expansion.timer
sudo systemctl enable --now japan-job-agent-promotion.timer
sudo systemctl enable --now japan-job-agent-freshness.timer
```

The daily Discovery jobs search the newest Talentio, Engage, and YOLO Japan entries plus every persisted public ATS tenant. Set `ENGAGE_DISCOVERY_MODE=pause_new` to observe existing Engage IDs from its sitemap without fetching or saving new Engage details. The source-expansion timer is inert while `SOURCE_EXPANSION_ENABLED=false`; after a backup, migration, and artifact dry-run, set it to `true` to scan at most 400 ranked tenants with four workers, a one-request-per-second host cap, and strict 30-day publication filtering. The later promotion job only advances candidates whose exact official Company–Source relationship can be verified, then reconciles Temporal schedules so sources with at least 100 current jobs run every 12 hours and smaller sources every 24 hours. At 08:30 JST, freshness applies the six-month retention policy. Backups remain local by default; copy one encrypted backup to a second user-controlled disk for machine-loss recovery.

Set repository variable `JJA_ENABLE_TAILSCALE_HEALTH=true` and secrets `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`, and `JJA_TAILSCALE_HEALTH_URL` to enable the nightly private readiness check. A failed source audit or Tailscale health check opens (or comments on) the single `Nightly live health failed` GitHub issue, so repeated failures remain visible without creating one issue per day.

The Compose limits total 11 GB: PostgreSQL 4 GB, Worker 3 GB, Temporal 2 GB, API and Web 1 GB each. The remaining memory is reserved for Linux, Docker, filesystem cache, and backup bursts.
