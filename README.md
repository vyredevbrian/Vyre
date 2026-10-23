# Vyre

A tiny self-hosted Vercel for a DigitalOcean droplet. One server, many sites, automatic HTTPS.

- **Caddy** (via `caddy-docker-proxy`) routes domains to containers and gets TLS certs automatically.
- **Docker** runs each project. Uses your `Dockerfile` if present, otherwise **Nixpacks** auto-detects Next.js, Node, Python, static sites, etc.
- **`vyre` CLI** does clone → build → start → swap (old version is kept if the new one crashes).

## Dashboard

`dashboard/` is a small web UI (no npm dependencies) served at your own domain, e.g. `deploy.vyrechain.com`.
Sign in with the generated password to deploy repos, redeploy, set env vars, read logs, delete apps, and watch server memory/disk.
It runs on the droplet and calls the `vyre` CLI. Note it mounts the Docker socket, which is root-equivalent: keep the password strong.

## Setup

1. Create a droplet: Ubuntu 24.04, 2 GB RAM / 1 vCPU (~$12/mo) is a good start. Add your SSH key.
2. Point an `A` record for your dashboard domain (e.g. `deploy.vyrechain.com`) at the droplet IP. SSH in and run `DASH_DOMAIN=deploy.vyrechain.com bash server/bootstrap.sh` as root; it prints the dashboard password. It installs Docker + Nixpacks, enables the firewall and 2 GB swap, and starts Caddy.
3. In your DNS, point an `A` record for each domain at the droplet IP.
4. Open `https://deploy.vyrechain.com`, or use the CLI:

```sh
vyre deploy https://github.com/you/site.git mysite mysite.vyrechain.com
vyre deploy https://github.com/you/api.git api api.mysite.vyrechain.com --port 8080 --branch main
vyre env mysite DATABASE_URL=postgres://... && vyre redeploy mysite
vyre ls
vyre logs mysite -f
```

Private repos: use an HTTPS URL with a GitHub token (`https://<token>@github.com/you/repo.git`) or add a deploy key on the server.

## Not built yet (next steps)

- Auto-deploy on `git push` (webhook receiver)
- Preview deployments per branch
- Multi-tenant mode for your blockchain: API + accounts + per-tenant resource limits, so others can deploy to it
- Databases, backups, monitoring

Apps run as plain Docker containers, so one droplet is a single point of failure; keep backups (DO droplet backups are +20%).

## MCP server (let Claude manage your server)

The dashboard also serves an MCP endpoint at `https://<DASH_DOMAIN>/mcp` (Streamable HTTP, bearer-token auth).
`bootstrap.sh` prints the token and stores it as `MCP_TOKEN` in `/opt/vyre/.env`; leave it unset to disable MCP.

Tools: `system_status`, `list_apps`, `deploy_app`, `redeploy_app`, `get_deploy_log`, `get_app_logs`, `list_env_keys`, `set_env`, `delete_app` (needs `confirm` = app name). Env values are never returned.

Claude Code: `claude mcp add --transport http vyre https://deploy.vyrechain.com/mcp --header "Authorization: Bearer <MCP_TOKEN>"`

Anyone with the token can deploy code to your server, so treat it like the dashboard password. To apply on an existing server: `git pull` in `/opt/vyre`, then `docker compose --env-file .env -f server/compose.yml up -d --build`.

## Usage metering and pricing (groundwork)

Every deploy records its build time in `/opt/vyre/usage.jsonl`; the dashboard shows this month's build minutes (`/api/usage`).
Billing itself (accounts, plans, payments, an exempt owner account) is not built yet.

Vercel's list prices when checked (Oct 2026, via vercel.com/pricing and its Apr 2026 changelog; re-check before publishing): build minutes Standard $0.014, Enhanced $0.028, Turbo $0.105. One third less would be about $0.0093, $0.0187 and $0.070.
