# Vyre

A tiny self-hosted Vercel for a DigitalOcean droplet. One server, many sites, automatic HTTPS.

- **Caddy** (via `caddy-docker-proxy`) routes domains to containers and gets TLS certs automatically.
- **Docker** runs each project. Uses your `Dockerfile` if present, otherwise **Nixpacks** auto-detects Next.js, Node, Python, static sites, etc.
- **`vyre` CLI** does clone → build → start → swap (old version is kept if the new one crashes).

## Setup

1. Create a droplet: Ubuntu 24.04, 2 GB RAM / 1 vCPU (~$12/mo) is a good start. Add your SSH key.
2. SSH in and run `server/bootstrap.sh` (as root). It installs Docker + Nixpacks, enables the firewall and 2 GB swap, and starts Caddy.
3. In your DNS, point an `A` record for each domain at the droplet IP.
4. Deploy:

```sh
vyre deploy https://github.com/you/site.git mysite mysite.com
vyre deploy https://github.com/you/api.git api api.mysite.com --port 8080 --branch main
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
