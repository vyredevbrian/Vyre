# Vyre Deploy: feature checklist

Compared against what Vercel's project dashboard offers. Status is what exists today.
`[x]` built, `[~]` partly, `[ ]` not built. Tiers are a first recommendation, to be reviewed together.

Tier 1 = needed before moving the real sites. Tier 2 = makes it a product. Tier 3 = later. Skip = not worth building.

## Ship it

| Feature | Status | Tier | Plan |
| --- | --- | --- | --- |
| Deploy from a git repo | [x] manual, from the dashboard, CLI or MCP | 1 | |
| Run Vercel-style `api/*.js` functions, `vercel.json` rewrites/redirects/headers and crons | [~] built (`runtime/vercel`), tested locally on the real Spring site and a fixture; not yet run in the server's container | 1 | `vyre deploy ... --root dist/spring` picks it automatically for prebuilt sites. Neon and Vercel Blob packages load; real credentials still to be tested on the server |
| Auto-deploy on `git push` | [x] built and tested (signed GitHub webhooks, one per repo and account, USDC-gated for customers) | 1 | Not yet set up on GitHub for the live sites; preview deployments per branch still not built |
| Deployment history (commit message, SHA, branch, duration, status, time) | [ ] only the latest build log is kept | 1 | Store one record per deploy; list with filters |
| Build logs per deployment | [~] latest only, in memory | 1 | Persist to disk with the history |
| Rollback / promote | [ ] | 1 | Keep the last N images; "make this live" re-runs the container from an old image |
| Preview deployments per branch | [ ] | 2 | Container per branch at `<branch>-<app>.preview.<domain>`; needs a wildcard DNS record; auto-delete when the branch is deleted |
| Environment variables, per environment (production / preview) | [~] one set per app, names only, no edit or delete in the UI | 1 | Separate sets per environment; edit and delete; redeploy hint |
| Domains | [~] several domains per app with redirects to the first, HTTPS automatic | 1 | Show the DNS record to create and whether it points here; edit domains without redeploying |
| GitHub project picker (click a repo, deploy it) | [ ] | 2 | GitHub App (or OAuth) so private repos work too; created on your GitHub account |
| Deployment retention | [ ] | 2 | Keep last N images and logs; weekly docker cleanup already runs |

## Watch it

| Feature | Status | Tier | Plan |
| --- | --- | --- | --- |
| Runtime logs | [~] last 300 lines | 1 | Live tail in the dashboard |
| Failed-deploy and down alerts | [ ] | 1 | Telegram or email message |
| Usage (build minutes, bandwidth, memory per app) | [~] build minutes only | 2 | Add per-app memory, disk and bandwidth from Caddy logs |
| Analytics (visits) | [ ] | 3 | Simple counts from Caddy access logs, or an open-source privacy-friendly tool |
| Observability / tracing | [ ] | Skip | Logs and alerts are enough |
| Speed Insights | [ ] | Skip | Use free tools |

## Scale it

| Feature | Status | Tier | Plan |
| --- | --- | --- | --- |
| Databases (Postgres, Redis) | [ ] | 2 | One-click container with a volume, a connection string as an env var, and nightly backups |
| Object storage (Blob) | [ ] | 3 | S3-compatible (DigitalOcean Spaces) |
| Cron jobs | [ ] | 2 | Schedule per app; replaces Vercel Cron |
| Image optimization | [x] works inside Next.js containers | | Nothing to build |
| CDN / edge caching | [ ] | 3 | Put free Cloudflare in front |
| Firewall | [ ] | 3 | Cloudflare rules, rate limits in Caddy, fail2ban |
| Feature flags | [ ] | Skip | |
| Sandboxes, Daemons, Workflows | [ ] | Skip | Plain containers and GitHub Actions cover these |
| AI Gateway, Integrations marketplace, Connect | [ ] | Skip | |

## Accounts and billing (for the VYRE hosting service)

| Feature | Status | Tier | Plan |
| --- | --- | --- | --- |
| Accounts and teams, each customer sees only their apps | [~] accounts and per-account apps built and tested; no teams, no email verification or password reset | 2 | Not deployed yet |
| Owner account that is never charged | [x] built and tested | 2 | |
| Per-account limits (apps, memory, builds) | [~] app count, memory and CPU limits, build timeout, credit needed to build | 2 | Network isolation and abuse limits not built |
| Prepaid balance paid in USDC on VYRE | [~] built; tested on a fake chain only; off until the owner sets the receiving wallet | 2 | Rehearse on testnet 7357; see `docs/BILLING-HANDOFF.md` |
| Metering | [~] build minutes charged to customers at two thirds of Vercel's Standard price | 2 | Re-check Vercel's price before any public claim; runtime and bandwidth not metered |
| Invoice / overdue states | [~] new builds refused below five minutes of credit; running sites stay up | 3 | Invoice emails and receipts not built |

## Platform and safety

| Feature | Status | Tier | Plan |
| --- | --- | --- | --- |
| MCP server for Claude | [x] | | |
| Dashboard in the VYRE look | [x] | | 3D logo and 3D headline text still to do |
| Backups of app data and `/opt/vyre` | [~] droplet backups only | 1 | Before moving any site with data |
| Two-factor sign-in | [ ] | 2 | |
| Audit log (who deployed what) | [ ] | 3 | |
| More than one server | [ ] | 3 | When one droplet is not enough |
