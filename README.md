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

Several domains: give a comma-separated list. The first is the main address and the others redirect to it, for example `vyre deploy <repo> site example.com,www.example.com` serves `example.com` and sends `www` there. Point every domain's DNS at the server before deploying, so the HTTPS certificates can be issued straight away.

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

**Claude app / claude.ai connector:** Settings, Connectors, Add custom connector, URL `https://deploy.vyrechain.com/mcp`, leave any client ID and secret fields empty, Connect. A Vyre sign-in page opens; enter the dashboard password. The server speaks OAuth 2.1 (discovery, dynamic client registration, PKCE) and only accepts Claude and localhost callbacks. Changing the dashboard password signs every connection out.

Claude Code (fixed token instead of sign-in): `claude mcp add --transport http vyre https://deploy.vyrechain.com/mcp --header "Authorization: Bearer <MCP_TOKEN>"`

Anyone with the token can deploy code to your server, so treat it like the dashboard password. To apply on an existing server: `git pull` in `/opt/vyre`, then `docker compose --env-file .env -f server/compose.yml up -d --build`.

## Usage metering and pricing (groundwork)

Every deploy records its build time in `/opt/vyre/usage.jsonl`; the dashboard shows this month's build minutes (`/api/usage`).
Billing itself (accounts, plans, payments, an exempt owner account) is not built yet.

Vercel's list prices when checked (Oct 2026, via vercel.com/pricing and its Apr 2026 changelog; re-check before publishing): build minutes Standard $0.014, Enhanced $0.028, Turbo $0.105. One third less would be about $0.0093, $0.0187 and $0.070.

## Create the droplet from the command line

`server/create-droplet.sh` creates the droplet through the DigitalOcean API with your SSH key and runs `bootstrap.sh` on first boot (see the header of the script for the variables). The API token stays on your computer. Until this branch is merged into `main`, pass `VYRE_BRANCH=<branch>`.

## Sites built for Vercel (static pages plus `api/*.js`)

Prebuilt sites that use `vercel.json` and an `api/` folder run on `runtime/vercel`, a small Node server that serves the files, runs the functions and applies cleanUrls, trailing slashes, redirects, rewrites, headers and crons. `vyre deploy` chooses it automatically when the repo (or the `--root` folder) has a `vercel.json` or `api/` and no build step; repos with a `Dockerfile` use that, and others use Nixpacks.

```sh
vyre deploy https://github.com/you/Junk-Junkie-Texas.git spring spring.example.com --root dist/spring
```

Environment variables (`DATABASE_URL`, `BLOB_READ_WRITE_TOKEN`, ...) are set per app as before. Smoke test: `bash runtime/vercel/test/run.sh`.
