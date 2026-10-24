# Vyre Deploy billing: hand-off brief

For the session that builds the chain and the VYRE website. It says what exists, what is proven, what is not, what is the owner's decision, and what to add.
No secrets are in this file (none belong in the repo).

## 1. What this is

Vyre Deploy is the owner's own Vercel-style hosting on one DigitalOcean server (git repo in, site on its own domain with HTTPS out). The owner wants to sell it as a service,
paid in **USDC on VYRE (chain 3045)**, priced one third under Vercel, **free for the owner**. This brief covers the money side that was just built. The hosting side is already live
(six real sites run on it).

## 2. Where everything is

- Repo: `vyredevbrian/Vyre` (public). Branch: `claude/self-hosted-vercel-digitalocean-5432vd` (not merged to `main`). No pull request opened.
- Billing code (all in `dashboard/`, zero npm packages, Node 22 built-ins only):
  - `billing.js`: accounts, balance, ledger, invoices, payment matching, app ownership, invites. SQLite through `node:sqlite`.
  - `chainwatch.js`: reads VYRE for payments (no key on the server).
  - `server.js`: accounts and sessions, signup and login with limits, per-account app scoping, billing and admin endpoints, charging, customer safety rules.
  - `public/index.html`: login and signup, billing card with top-up instructions, owner admin card.
  - `oauth.js` and `mcp.js`: the owner's MCP connector (unchanged; owner level only).
- Tests: `node --no-warnings --test dashboard/test/billing.test.js dashboard/test/server.test.js` (27 tests, all pass). Do not run `node --test dashboard/test/` (the folder form fails on this Node).
- Related: `bin/vyre` (deploy tool), `runtime/vercel/` (Vercel-style functions runtime), `server/compose.yml` (all settings), `docs/FEATURES.md` (checklist).

## 3. Live state (not secret)

- Server: DigitalOcean droplet, NYC1, 2 vCPU / 4 GB, IP `147.182.171.109`. Dashboard at `https://deploy.vyrechain.com`. `*.deploy.vyrechain.com` points at it (wildcard A record).
- Running on their own domains: junkjunkiestexas.com, junkjunkiestomball.com, junkjunkiescypress.com, junkjunkiescollegestation.com, www.junkjunkiesflorida.com.
- Waiting on the owner: junkjunkiesindiana.com DNS; each site's environment variables (database, storage token, PINs; copied from Vercel by the owner, never through chat); `ebay-for-junk`
  (private repo, needs a read-only GitHub token and a domain); repos for stagr-app (probably `stag`) and simplicitybuilds.com (probably `Web`).
- **The billing code is NOT deployed on the server yet.** The server runs the commit before it. To deploy: on the server, `cd /opt/vyre && git pull`, set the values in section 7 in
  `/opt/vyre/.env`, then `docker compose --env-file .env -f server/compose.yml up -d --build`. The image build has not been run in the build environment (Docker Hub rate-limited it); expect to check it.

## 4. What it does

- **Accounts.** Email and password (scrypt). Roles: `owner` and `customer`. The owner keeps signing in with the dashboard password (leave the email empty); that maps to a built-in owner account.
  Signup is `closed` (default), `invite` (one-use codes the owner creates) or `open`. Passwords 10 characters or more. Wrong-password limits: five tries a minute per email and per visitor address.
- **Ownership.** Every app has one owner account. Customers see and touch only their own apps (everything else answers 404). Apps with no recorded owner belong to the owner.
- **Balance.** Prepaid, in whole nano-USDC (1e-9) as BigInt in code and 64-bit INTEGER in the database, with a database CHECK that a balance never goes negative. No floating point.
  The ledger records every credit and debit; one credit per payment (the transaction hash is unique).
- **Metering and gating.** A customer needs credit worth five build minutes to start a build. A build is charged by the second (rounded up) at the build price, whether or not it succeeds.
  Charges never take more than the balance. The owner is never charged and never needs credit. Running sites are not stopped when credit runs out; only new builds are refused.
- **Price.** Default 0.009333333 USDC per build minute = two thirds of Vercel's Standard build machine ($0.014 a minute; vercel.com/pricing and its April 2026 changelog, read October 2026; one docs
  page still shows older numbers for other machines). Setting: `PRICE_BUILD_PER_MIN_USDC`. Re-check Vercel's page before any public price claim.
- **Top-up.** The customer asks for an amount (default 5 to 500 USDC). The server makes an invoice whose amount carries a small unique tag in the last digits (for example 5.004217 USDC; at most 0.01
  USDC extra, whole micro-USDC so any wallet can type it). The customer sends exactly that amount, as native USDC on VYRE, from any wallet, to the receiving wallet, within 24 hours.
  The watcher matches the amount and credits the full invoice amount. Anything that matches no open invoice (wrong amount, late, a second payment of the same amount, an amount with more than 6 decimals)
  is **not credited**; it is listed under "unmatched" in the owner view for the owner to handle by hand. At most three open invoices per account.
- **Owner view** (`/api/admin/overview`, shown on the dashboard): accounts and balances, credit sold, credit owed (a liability: money received for service not yet delivered), watcher status,
  unmatched payments; create invite codes; add credit by hand with a note.

## 5. The chain facts it relies on

| Fact | Status |
|---|---|
| VYRE mainnet chain ID 3045, public RPC `https://rpc.vyrechain.com` | Checked live: `eth_chainId` returned `0xbe5` (3045) |
| Gas and money are native USDC with 18 decimals (the native view; the ERC-20 view has 6) | VERIFIED-IN-DOCS (Arc's docs, as recorded in the Chain repo's `docs/nitro-orbit-reference.md`). That deposits and withdrawals move 18-decimal units one to one is that file's own inference, NOT run |
| A VYRE block is made only when a transaction arrives (head was block 0x37 when read) | Observed. This is why the watcher trusts a block by **age** (default 15 seconds) and not by blocks on top. Counting blocks would have made a payment wait for the next customer; that bug was found by a test and fixed |
| Sequencer-confirmed blocks are treated as final after the age delay | A judgment, not verified against a rollup reorg or a sequencer failure. It is a small risk and the owner should decide whether to wait longer for larger top-ups (`CONFIRM_SECONDS`) |
| The receiving wallet gets a direct transfer as `tx.to` | True for an ordinary wallet and for a Safe. A payment that arrives through a contract call (internal transfer) is not seen |
| A real payment on mainnet or testnet through this code | **NOT done.** Only a fake chain was used. Do this on testnet 7357 first (`CHAIN_RPC`, `CHAIN_ID`) |

## 6. Safety built in, and how it was checked

Built in: customers cannot claim the dashboard's own domain or any name under the owner's zones (`RESERVED_ZONES`, default `vyrechain.com`, except single names under `APPS_DOMAIN`); a customer's own domain is
accepted only if its A record already points at this server (that is the proof it is theirs); a domain another app already uses is refused; customer builds run with a bare environment (no server secrets, **no GitHub
token**: the token is the owner's and could read the owner's private repos); builds stop after 30 minutes; at most `CUSTOMER_MAX_APPS` (3) apps each; invite codes are used up atomically with the account;
unknown emails cost the same time as wrong passwords; the owner account cannot be reached by email login; endpoints for the owner (`/api/admin/*`, `/api/system`, `/api/usage`) answer 403 to customers.

Checked: 27 tests, including a fake VYRE chain, a stand-in for the deploy tool, and these cheating cases: replaying a transaction, paying one wei or one micro-USDC off, paying the right amount to the wrong
wallet, a failed transfer, a block that is too new, a block with no timestamp, history from before switch-on, a wrong chain, a bad RPC answer, an expired invoice, a customer reaching another's app (logs, env, redeploy,
delete), taking another's app name, leaking secrets into a build, the reserved and unresolved domains, the app limit, old apps with no owner, the owner being charged. **Mutation check:** 12 deliberate breaks of
the code (6 in the money and chain logic, 6 in the server rules) were each caught by a failing test.

Not checked: any outside review. Nothing in this brief should be called "audited".

## 7. Settings (in `/opt/vyre/.env`; all optional; billing and signups stay off until set)

| Setting | Meaning |
|---|---|
| `PAY_TO` | Receiving wallet for customer payments. **Owner's decision.** Unset or invalid means payments are off and the watcher does not run. Use a plain wallet or Safe |
| `SIGNUPS` | `closed` (default), `invite`, `open` |
| `SERVER_IP` | The server's public IP (`147.182.171.109`); customer domains must point here |
| `APPS_DOMAIN` | e.g. `deploy.vyrechain.com`: a customer with no domain gets `<name>.deploy.vyrechain.com` (the wildcard record already exists) |
| `RESERVED_ZONES` | Comma list customers cannot use (default `vyrechain.com`) |
| `CHAIN_RPC`, `CHAIN_ID` | Default `https://rpc.vyrechain.com` and `3045`; point at testnet for rehearsal |
| `CONFIRM_SECONDS` | Block age before it is trusted (default 15) |
| `PRICE_BUILD_PER_MIN_USDC` | Default 0.009333333 |
| `MIN_TOPUP_USDC`, `MAX_TOPUP_USDC` | Default 5 and 500 |
| `CUSTOMER_MAX_APPS` | Default 3 |

The database is `/opt/vyre/billing.db` (SQLite, next to the apps). **Back it up**; it is the record of what the owner owes customers.

## 8. The owner's decisions (do not decide these for them)

1. The receiving wallet (`PAY_TO`). Which wallet hosting income goes to is not decided.
2. Who may sign up (closed, invite, open), and whether strangers may run code on this server at all (see section 9).
3. The prices, and whether any free allowance exists. Public copy must not say "cheapest"; a "third less than Vercel" claim needs a date and a source.
4. Refund and unused-credit terms (the credit is a liability; there is no automatic refund), and what happens to unmatched payments.
5. What to do about the photos stored in the old Vercel Blob stores (they stay on Vercel).

## 9. Known gaps (be honest about these)

- **Isolation.** Customer code runs in ordinary Docker containers on one shared server. There are CPU and memory limits (1 CPU, 512 MB) and a bare build environment, but no stronger sandbox, no network isolation
  between customers, no egress limits and no abuse detection. **Do not open signups to strangers before a security review**, or run customers on separate machines or a stronger sandbox.
- The dashboard mounts the Docker socket (root-equivalent on the server). A flaw in the dashboard is a flaw in the server.
- No email verification, no password reset, no two-factor sign-in, no invoice emails.
- Only build time is metered. Runtime, bandwidth and storage are not charged. The brief from the owner said "build minutes etc."; decide what else.
- Single server, single point of failure; payments reconcile only while the watcher runs (it resumes from its saved block, so downtime delays credit but loses nothing, within the public RPC's limits).
- `node:sqlite` is marked experimental by Node (it prints a warning, silenced with `--no-warnings`). It worked in every test; consider a pinned Node version.
- Unique-amount invoices are simple but a customer must type an exact amount. The better design, already built in the Chain repo for the RPC gateway, is below.

## 10. What the chain session should add

Pick one, with the owner:

- **A. Keep the unique-amount invoices (works today, no contract).** Remaining work: rehearse on testnet 7357 with test money; a public page and docs copy for the service (follow the Chain copy rules); terms and privacy updates;
  a status line for the payment watcher; decide `PAY_TO`; then switch on.
- **B. Reuse the gateway's deposit design (better UX).** The Chain repo already has `engine/contracts/api/VyreApiCredit.sol` (deposit for an account, forwards every wei to the treasury in the same transaction, logs
  `Deposit(account, amount)`), the wallet-signature account model and `deploy/gateway/deposits.js`. The contract is **not deployed anywhere**; deploying it is the owner's action (never an agent's). With it, an
  account is a wallet address, a deposit of any amount credits that account by reading the log, and the exact-amount rule goes away. `chainwatch.js` would read the log instead of transfers; `billing.js`
  would credit by wallet address. The Chain repo's design says money is nano-USDC BigInt and one credit per (transaction hash, log index), which `billing.js` already follows.
- Either way: add a page on the site (for example `vyrechain.com/deploy`), the DNS note for `deploy.vyrechain.com`, and a line in the roadmap page. Chain copy rules apply (no "layer 2", "on Arc", "trustless",
  "audited", "cheapest", price or profit promises; say "testnet" where it is testnet).

## 11. Rules from the Chain repo that apply when work lands there

Read the Chain repo's `CLAUDE.md` first. In short: commits authored as Jarvis with no co-author or session lines; no AI or tool words in repo files; proof on every report (commit, exact command, counts); designed or untested
things are called that; never guess about Nitro, Orbit, ArbOS, Circle, Transak, Telegram or Uniswap (read the source or write NOT VERIFIED); nothing that touches gas, fees, the floor or the owner's income; never deploy,
sign or send a transaction as an agent; push only the designated branch. This repo (Vyre) is separate and public: keep secrets, keys and business notes out of it.

## 12. Operating notes

- Add credit by hand: dashboard, owner view, "Add credit". Unmatched payments: same view; the owner decides and credits by hand (with a note) or refunds from the wallet.
- If the watcher shows an error: check `CHAIN_RPC` and that the chain ID matches; it resumes from its saved block. To start it fresh, delete the `cursor` row from `meta` (it then starts at the current block and will
  **not** credit older payments; credit those by hand).
- Rotate the dashboard password: it also signs every MCP connection out. The signing secret for sessions comes from the dashboard password.
- Updating the server: `git pull` in `/opt/vyre`, then the compose command in section 3.

## 13. Go-live checklist

The receiving wallet has been chosen by the owner (it is set only in `/opt/vyre/.env`, not in this repo). Checked on VYRE mainnet on 2026-10-24: a valid address, a plain wallet (no contract code), no balance, no transactions yet.
That means nobody has used it; **whether the owner holds its key was not verified.** Before a customer pays, prove control: send 1 USDC to it from another wallet, then send 0.5 USDC back out.

1. Update the server: `cd /opt/vyre && git pull`.
2. In `/opt/vyre/.env` add: `PAY_TO=<the wallet>`, `SERVER_IP=147.182.171.109`, `APPS_DOMAIN=deploy.vyrechain.com`, `SIGNUPS=closed`, and for the rehearsal `MIN_TOPUP_USDC=1`.
3. Rebuild: `docker compose --env-file .env -f server/compose.yml up -d --build`, then `docker ps` and `docker logs vyre-dashboard` (the dashboard image has not been built in the build environment, so read the logs).
4. Rehearse with real money, small: owner view, "New invite code"; sign up a test customer with it; "Add credit" for 1 USDC; send exactly the shown amount from a different wallet; within about a minute the balance appears; deploy a tiny test site and check the charge and the ledger;
   send a deliberately wrong amount and check it shows under unmatched and is not credited. The `billing_overview` tool on the MCP connector shows the same information without the dashboard.
5. Then set `MIN_TOPUP_USDC` back to 5 (or the owner's choice). Keep signups invite-only until a security review and written terms exist.

## 14. Still to test (nothing below has been done)

- **A real payment.** Everything so far used a fake chain. The owner's receiving wallet is set on the server, billing is running (`/api/config` shows payments on, signups closed), but no real USDC has moved through it.
  Do the go-live rehearsal in section 13: prove the wallet's key is held, make a test customer, pay the exact invoice amount, then a wrong amount (must not be credited), then a small build and its charge.
- **A rehearsal on testnet 7357** if the owner wants one before mainnet money (`CHAIN_RPC`, `CHAIN_ID`).
- **Timing.** The watcher trusts a block 15 seconds after it was made (`CONFIRM_SECONDS`). Measure how long a real payment takes to show up, and decide whether larger top-ups should wait longer.
- **The dashboard image** was rebuilt on the server on 2026-10-24 and runs; the SQLite database file (`/opt/vyre/billing.db`) is created on first start. Confirm it exists and is backed up.
- **Real customer builds** on this server: only a stand-in for the deploy tool was used in the tests. The owner's own sites deploy fine, but a customer deploy (bare environment, domain rules, charging) has not been run end to end for real.
- **Outside security review** before any stranger signs up (section 9).

## 15. The MCP connector: where it stands, and other AI apps

- It is at `https://deploy.vyrechain.com/mcp` (Streamable HTTP, stateless JSON). Tools: `system_status`, `list_apps`, `billing_overview` (read-only), `deploy_app`, `redeploy_app`, `get_deploy_log`, `get_app_logs`, `list_env_keys`, `set_env`, `delete_app` (needs `confirm` = app name). Env values are never returned.
- **Where it is added:** only as a custom connector in the owner's own Claude account (it signs in with the dashboard password through OAuth). It is **not published in any directory**, and **no other AI app has it yet.** (An already-open Claude session caches the tool list; reconnecting the connector shows newer tools such as `billing_overview`.)
- **To add it to other AI apps** (for example ChatGPT, Cursor or any app that supports remote MCP servers): two ways in.
  1. **Fixed token.** Apps that let you set a header can use `Authorization: Bearer <MCP_TOKEN>` (the token is in `/opt/vyre/.env`, never in the repo or in chat).
  2. **Sign-in (OAuth).** The server speaks OAuth 2.1 with discovery, dynamic client registration and PKCE (S256), and the sign-in page asks for the dashboard password. For safety it only sends users back to Claude, localhost, and
     addresses the owner lists exactly in `OAUTH_EXTRA_REDIRECTS` (comma-separated `https://` callback addresses, set in `/opt/vyre/.env`, then rebuild the dashboard). **Read each app's own documentation for its exact callback address; it was not looked up here, and
     guessing one would either fail or open a hole.** After setting it, the app can register and connect.
  Either way the connection has full owner power over the server (deploy, delete, env names). Treat the token and the password like keys; changing the dashboard password signs every OAuth connection out.
- Anyone who writes the other AI apps' setup instructions should say which of the two ways is used, and that these tools can deploy and delete.
