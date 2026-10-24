// Vyre dashboard: zero-dependency Node server that wraps the `vyre` CLI, with customer accounts and prepaid billing in USDC on VYRE.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns').promises;
const { spawn, execFile } = require('child_process');
const Billing = require('./billing');
const chainwatch = require('./chainwatch');

const PASSWORD = process.env.DASH_PASSWORD;
if (!PASSWORD) { console.error('DASH_PASSWORD is required'); process.exit(1); }
const SECRET = process.env.DASH_SECRET || crypto.createHash('sha256').update('vyre:' + PASSWORD).digest('hex');
const APPS = process.env.VYRE_APPS || '/opt/vyre/apps';
const VYRE = process.env.VYRE_BIN || '/opt/vyre/bin/vyre';
const PORT = process.env.PORT || 3000;
const MCP_TOKEN = process.env.MCP_TOKEN || '';
const SESSION_MS = 7 * 24 * 3600 * 1000;

// Billing and customer settings (all optional; payments and signups are off until the owner sets them).
const SIGNUPS = ['open', 'invite'].includes(process.env.SIGNUPS) ? process.env.SIGNUPS : 'closed';
const PAY_TO = /^0x[0-9a-fA-F]{40}$/.test(process.env.PAY_TO || '') ? process.env.PAY_TO : '';
const CHAIN_RPC = process.env.CHAIN_RPC || 'https://rpc.vyrechain.com';
const CHAIN_ID = Number(process.env.CHAIN_ID || 3045);
const SERVER_IP = process.env.SERVER_IP || '';
const DASH_DOMAIN = (process.env.DASH_DOMAIN || '').toLowerCase();
const APPS_DOMAIN = (process.env.APPS_DOMAIN || '').toLowerCase();       // customers without a domain get <name>.<APPS_DOMAIN>
const RESERVED_ZONES = (process.env.RESERVED_ZONES || 'vyrechain.com').toLowerCase().split(',').map((z) => z.trim()).filter(Boolean);
const MAX_APPS = Number(process.env.CUSTOMER_MAX_APPS || 3);
const MIN_TOPUP = Billing.parseUsdc(process.env.MIN_TOPUP_USDC || '5') ?? 5n * Billing.NANO;
const MAX_TOPUP = Billing.parseUsdc(process.env.MAX_TOPUP_USDC || '500') ?? 500n * Billing.NANO;
const OWNER_EMAIL = 'owner@vyre.local';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const DOMAIN_RE = /^([a-z0-9-]+\.)+[a-z]{2,}$/i;
const BRANCH_RE = /^[A-Za-z0-9._\/-]{1,100}$/;
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@.]{1,190}(\.[^\s@.]{2,})+$/;

const billing = Billing.open(process.env.VYRE_DB || path.join(path.dirname(APPS), 'billing.db'), { buildPerMinNano: Billing.parseUsdc(process.env.PRICE_BUILD_PER_MIN_USDC || '') ?? undefined });
const owner = billing.ensureOwner(OWNER_EMAIL);
const watcher = PAY_TO && process.env.BILLING_WATCH !== '0'
  ? chainwatch({ billing, rpcUrl: CHAIN_RPC, payTo: PAY_TO, chainId: CHAIN_ID, confirmSeconds: Number(process.env.CONFIRM_SECONDS || 15) }).start(Number(process.env.WATCH_MS || 15000)) : null;

const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('hex');
const safeEq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const makeToken = (acct) => { const body = `${Date.now() + SESSION_MS}:${acct.id}`; return body + '.' + sign(body); };
function authed(req) { // the signed-in account, or null
  const m = /(?:^|;\s*)vyre=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const [body, sig] = m[1].split('.');
  if (!sig || !safeEq(sig, sign(body))) return null;
  const [exp, id] = body.split(':');
  return Number(exp) > Date.now() ? billing.account(Number(id)) : null;
}
const cookie = (acct) => `vyre=${makeToken(acct)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`;

// Wrong-password limits: the owner password and each email get five tries a minute.
let failures = 0, lockedUntil = 0;
function tryPassword(p) {
  if (Date.now() < lockedUntil) return 'locked';
  if (safeEq(String(p), PASSWORD)) { failures = 0; return 'ok'; }
  if (++failures >= 5) { lockedUntil = Date.now() + 60_000; failures = 0; }
  return 'bad';
}
const tries = new Map();
const blocked = (k) => { const t = tries.get(k); return !!t && t.n >= 5 && Date.now() < t.until; };
const failed = (k) => { const t = tries.get(k) || { n: 0, until: 0 }; if (Date.now() >= t.until) t.n = 0; t.n++; t.until = Date.now() + 60_000; tries.set(k, t); };
const ipOf = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

const USAGE = process.env.VYRE_USAGE || path.join(path.dirname(APPS), 'usage.jsonl');
const deployLogs = new Map(); // name -> { running, text }
const pendingAuto = new Set(); // apps with a push waiting behind a build that is already running
const seenDeliveries = new Set(); // GitHub delivery ids already handled (GitHub retries)

const send = (res, code, body, headers = {}) => {
  const isStr = typeof body === 'string';
  res.writeHead(code, { 'Content-Type': isStr ? 'text/plain; charset=utf-8' : 'application/json', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(isStr ? body : JSON.stringify(body));
};
const readBody = (req) => new Promise((resolve, reject) => {
  let d = ''; req.on('data', (c) => { d += c; if (d.length > 100_000) { reject(new Error('too large')); req.destroy(); } });
  req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
});
const run = (cmd, args) => new Promise((resolve) =>
  execFile(cmd, args, { timeout: 15000, maxBuffer: 5_000_000 }, (err, stdout, stderr) => resolve({ ok: !err, out: stdout + stderr })));

function meta(name) {
  try {
    return Object.fromEntries(fs.readFileSync(path.join(APPS, name, 'app.conf'), 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  } catch { return null; }
}
const appNames = () => (fs.existsSync(APPS) ? fs.readdirSync(APPS).filter((n) => meta(n)) : []);
const isOwner = (a) => !a || a.role === 'owner';                         // no account means the owner (MCP and the CLI)
const canSee = (a, name) => isOwner(a) || billing.ownerOf(name) === a.id; // apps with no recorded owner belong to the owner

// A job is one `vyre` run. Customers' jobs get a bare environment (no server secrets, no GitHub token) and are charged for their build time.
function startJob(name, args, acct) {
  const log = deployLogs.get(name);
  if (log && log.running) return false;
  const job = { running: true, text: '' };
  deployLogs.set(name, job);
  const t0 = Date.now();
  const env = isOwner(acct) ? { ...process.env, VYRE_APPS: APPS }
    : Object.fromEntries(Object.entries({ PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', DOCKER_HOST: process.env.DOCKER_HOST, VYRE_APPS: APPS }).filter(([, v]) => v));
  const p = spawn('timeout', ['1800', 'bash', VYRE, ...args], { env }); // a build that runs half an hour is stopped
  const add = (c) => { job.text = (job.text + c).slice(-60_000); };
  p.stdout.on('data', add); p.stderr.on('data', add);
  p.on('error', (e) => add(`could not start: ${e.message}\n`));
  p.on('close', (code) => {
    add(`\n[exit ${code}]\n`); job.running = false; job.ok = code === 0;
    const seconds = Math.round((Date.now() - t0) / 1000);
    if (['deploy', 'redeploy'].includes(args[0])) {
      if (!isOwner(acct)) { // customers pay for build time, whether or not the build worked; the owner is never charged
        const r = billing.debit(acct.id, 'build', billing.buildCost(seconds), `${name}-${t0}`, `${args[0]} ${name}, ${seconds}s${code === 0 ? '' : ' (failed)'}`);
        if (r.short > 0n) add(`[credit ran out: ${Billing.fmt(r.short)} USDC of this build was not charged]\n`);
      }
      fs.appendFile(USAGE, JSON.stringify({ app: name, account: isOwner(acct) ? owner.id : acct.id, kind: args[0], seconds, ok: code === 0, at: new Date().toISOString() }) + '\n', () => {});
    }
    if (pendingAuto.delete(name)) setImmediate(() => autoDeploy(name, acct)); // a push arrived during this build: build the latest once
  });
  return true;
}

// ---- auto-deploy from GitHub pushes ----
const repoKey = (url) => { const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(String(url)); return m ? `${m[1]}/${m[2]}`.toLowerCase() : null; };
const ownedBy = (a, name) => { const o = billing.ownerOf(name); return o === a.id || (o === null && a.role === 'owner'); };
function note(name, text) { const j = deployLogs.get(name); if (!j || !j.running) deployLogs.set(name, { running: false, ok: false, text: `[auto-deploy] ${new Date().toISOString()} ${text}\n` }); }
// Returns 'started', 'queued' (one more build runs when the current one ends) or 'skipped' (a customer without enough credit).
function autoDeploy(name, acct) {
  if (!isOwner(acct) && !billing.canBuild(acct)) { note(name, `skipped: add credit to build (at least ${Billing.fmt(billing.minToBuild())} USDC)`); return 'skipped'; }
  const j = deployLogs.get(name);
  if (j && j.running) { pendingAuto.add(name); return 'queued'; }
  return startJob(name, ['redeploy', name], acct) ? 'started' : 'queued';
}
const readRaw = (req, limit) => new Promise((resolve, reject) => {
  const chunks = []; let n = 0, big = false;
  req.on('data', (c) => { n += c.length; if (n > limit) big = true; else if (!big) chunks.push(c); });
  req.on('end', () => (big ? reject(Object.assign(new Error('too large'), { status: 413 })) : resolve(Buffer.concat(chunks))));
  req.on('error', reject);
});
async function githubHook(req, res, id) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  const k = `h:${ipOf(req)}`;
  if (blocked(k)) return send(res, 429, { error: 'Too many bad requests' });
  const hook = /^[0-9a-f]{24}$/.test(id) ? billing.hookById(id) : null;
  let raw; try { raw = await readRaw(req, 10 * 1024 * 1024); } catch (e) { return send(res, e.status || 400, { error: 'Body too large' }); }
  const sig = String(req.headers['x-hub-signature-256'] || '');
  const want = hook ? 'sha256=' + crypto.createHmac('sha256', hook.secret).update(raw).digest('hex') : '';
  if (!hook || !/^sha256=[0-9a-f]{64}$/.test(sig) || !safeEq(sig, want)) { failed(k); return send(res, hook ? 401 : 404, { error: hook ? 'Bad signature' : 'Unknown hook' }); }
  const event = req.headers['x-github-event'];
  if (event === 'ping') return send(res, 200, { ok: true, repo: hook.repo });
  if (event !== 'push') return send(res, 200, { ignored: `event ${event}` });
  let p; try { p = JSON.parse(raw.toString('utf8')); } catch { return send(res, 400, { error: 'Bad payload' }); }
  const delivery = String(req.headers['x-github-delivery'] || '');
  if (delivery) { if (seenDeliveries.has(delivery)) return send(res, 200, { ignored: 'already handled' }); seenDeliveries.add(delivery); if (seenDeliveries.size > 500) seenDeliveries.delete(seenDeliveries.values().next().value); }
  const repo = String(p.repository && p.repository.full_name || '').toLowerCase(), ref = String(p.ref || '');
  if (repo !== hook.repo) return send(res, 200, { ignored: 'a different repository' });
  const m = /^refs\/heads\/(.+)$/.exec(ref);
  if (!m || p.deleted) return send(res, 200, { ignored: 'not a branch update' });
  const acct = billing.account(hook.account);
  const result = { deploying: [], queued: [], skipped: [] };
  for (const name of appNames()) {
    const c = meta(name);
    if (repoKey(c.REPO) !== hook.repo || c.BRANCH !== m[1] || !ownedBy(acct, name)) continue;
    const r = autoDeploy(name, acct);
    (r === 'started' ? result.deploying : r === 'queued' ? result.queued : result.skipped).push(name);
  }
  return send(res, 202, result);
}

async function listApps(acct) {
  const names = appNames().filter((n) => canSee(acct, n));
  const emails = isOwner(acct) ? new Map(billing.accounts().map((a) => [a.id, a.email])) : null;
  return Promise.all(names.map(async (name) => {
    const m = meta(name), doms = m.DOMAIN.split(',');
    const ps = await run('docker', ['ps', '-a', '--filter', `label=vyre.app=${name}`, '--format', '{{.Status}}']);
    const job = deployLogs.get(name);
    return { name, domain: doms[0], aliases: doms.slice(1), repo: m.REPO.replace(/\/\/[^@/]*@/, '//***@'), branch: m.BRANCH, port: m.PORT, status: ps.out.trim() || 'not running', deploying: !!(job && job.running),
      ...(emails ? { account: emails.get(billing.ownerOf(name)) || 'owner' } : {}) };
  }));
}

async function sysInfo() {
  const mem = Object.fromEntries(fs.readFileSync('/proc/meminfo', 'utf8').split('\n').filter(Boolean).map((l) => { const [k, v] = l.split(':'); return [k, parseInt(v, 10) * 1024]; }));
  const df = await run('df', ['-B1', '--output=size,used', '/']);
  const [size, used] = (df.out.split('\n')[1] || '').trim().split(/\s+/).map(Number);
  return { memTotal: mem.MemTotal, memAvailable: mem.MemAvailable, swapTotal: mem.SwapTotal, swapFree: mem.SwapFree, diskSize: size, diskUsed: used, load: fs.readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3) };
}

// Returns { error } or { name, args }.
function deployArgs(b) {
  const { repo = '', name = '', domain = '' } = b;
  const port = String(b.port || 3000), branch = b.branch || 'main';
  if (!/^https:\/\/\S+$/.test(repo)) return { error: 'Repo must be an https:// git URL' };
  if (!NAME_RE.test(name)) return { error: 'Name: lowercase letters, digits, dashes' };
  const doms = String(domain).split(',');
  if (doms.length > 8 || !doms.every((d) => DOMAIN_RE.test(d))) return { error: 'Invalid domain' };
  if (!/^\d{2,5}$/.test(port)) return { error: 'Invalid port' };
  if (!BRANCH_RE.test(branch)) return { error: 'Invalid branch' };
  const root = b.root || '';
  if (root && !(/^[A-Za-z0-9._\/-]+$/.test(root) && !root.includes('..') && !root.startsWith('/'))) return { error: 'Invalid folder' };
  return { name, args: ['deploy', repo, name, domain, '--port', port, '--branch', branch, ...(root ? ['--root', root] : [])] };
}

// Where may a customer's app live? Not on the dashboard's own name, not on the owner's zones, not on a name another app already has,
// and anywhere else only if the domain already points at this server (that is the proof it is theirs).
async function resolvesHere(d) {
  if (process.env.NODE_ENV === 'test' && process.env.DNS_MOCK) return (JSON.parse(process.env.DNS_MOCK)[d] || []).includes(SERVER_IP);
  try { return !!SERVER_IP && (await dns.resolve4(d)).includes(SERVER_IP); } catch { return false; }
}
async function checkCustomerDomains(domain, appName) {
  const used = new Set(appNames().filter((n) => n !== appName).flatMap((n) => meta(n).DOMAIN.split(',')));
  for (const d of String(domain).toLowerCase().split(',')) {
    if (d === DASH_DOMAIN || used.has(d)) return `${d} is not available`;
    if (APPS_DOMAIN && d.endsWith('.' + APPS_DOMAIN)) { if (!/^[a-z0-9-]{1,40}$/.test(d.slice(0, -APPS_DOMAIN.length - 1))) return `${d} is not a valid name under ${APPS_DOMAIN}`; continue; }
    if (RESERVED_ZONES.some((z) => d === z || d.endsWith('.' + z))) return `${d} is not available`;
    if (!(await resolvesHere(d))) return `Point ${d} at ${SERVER_IP || 'this server'} first (an A record), then deploy again`;
  }
  return null;
}

// Build time per app for the current UTC month, from the usage log.
function usageThisMonth() {
  const month = new Date().toISOString().slice(0, 7), apps = {};
  let lines = []; try { lines = fs.readFileSync(USAGE, 'utf8').split('\n').filter(Boolean); } catch {}
  for (const l of lines) {
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (!r.at || !r.at.startsWith(month)) continue;
    const a = (apps[r.app] ||= { builds: 0, seconds: 0 });
    a.builds++; a.seconds += r.seconds;
  }
  const seconds = Object.values(apps).reduce((n, a) => n + a.seconds, 0);
  return { month, apps, buildMinutes: Math.round(seconds / 6) / 10 };
}

const readEnvKeys = (name) => {
  const file = path.join(APPS, name, '.env');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => l.split('=')[0]) : [];
};

// Returns an error string or null.
async function setEnv(name, vars) {
  const pairs = String(vars).split('\n').map((l) => l.trim()).filter(Boolean);
  for (const kv of pairs) if (!kv.includes('=') || !KEY_RE.test(kv.split('=')[0])) return `Bad line: ${kv.split('=')[0]}`;
  const r = await run('bash', [VYRE, 'env', name, ...pairs]);
  return r.ok ? null : 'Failed to save';
}

function adminOverview() {
  const s = billing.summary();
  return { accounts: billing.accounts().map((a) => ({ id: a.id, email: a.email, role: a.role, balance: Billing.fmt(a.balance), apps: billing.appCount(a.id) })),
    creditSold: Billing.fmt(s.creditSold), creditOwed: Billing.fmt(s.creditOwed), signups: SIGNUPS,
    chain: PAY_TO ? { payTo: PAY_TO, ...(watcher ? watcher.state : { lastError: 'watcher off' }) } : null,
    unmatched: billing.unmatched().map((u) => ({ tx: u.tx, from: u.from, usdc: Billing.fmt(u.amount), block: u.block })) };
}

const core = { adminOverview, APPS, NAME_RE, meta, listApps: () => listApps(null), sysInfo, deployArgs, startJob: (n, a) => startJob(n, a, null), readEnvKeys, setEnv, run, VYRE, deployLogs };

const moneyJson = (a) => ({ usdc: Billing.fmt(a), nano: a.toString() });
function billingView(acct) {
  return {
    role: acct.role, email: acct.email, balance: moneyJson(billing.balance(acct.id)),
    price: { buildPerMinute: Billing.fmt(billing.buildPerMin, 9), minToBuild: Billing.fmt(billing.minToBuild()) },
    ledger: billing.ledger(acct.id).map((r) => ({ ts: r.ts, kind: r.kind, usdc: Billing.fmt(r.amount), note: r.note })),
    invoices: billing.invoices(acct.id).map((i) => ({ id: i.id, usdc: Billing.fmt6(i.amount), expires: i.expires, status: i.status })),
    pay: PAY_TO ? { enabled: true, to: PAY_TO, chainId: CHAIN_ID, min: Billing.fmt(MIN_TOPUP), max: Billing.fmt(MAX_TOPUP) } : { enabled: false },
  };
}

async function api(req, res, url) {
  if (url.pathname === '/api/config' && req.method === 'GET') return send(res, 200, { signups: SIGNUPS, payments: !!PAY_TO, appsDomain: APPS_DOMAIN || null });

  if (url.pathname === '/api/login' && req.method === 'POST') {
    const { email = '', password = '' } = await readBody(req);
    if (!String(email).trim()) { // the owner's password, as before
      const r = tryPassword(password);
      if (r === 'locked') return send(res, 429, { error: 'Too many attempts, wait a minute' });
      return r === 'ok' ? send(res, 200, { ok: true, role: 'owner' }, { 'Set-Cookie': cookie(owner) }) : send(res, 401, { error: 'Wrong password' });
    }
    const keys = [`e:${String(email).toLowerCase()}`, `i:${ipOf(req)}`];
    if (keys.some(blocked)) return send(res, 429, { error: 'Too many attempts, wait a minute' });
    const acct = String(email).toLowerCase() === OWNER_EMAIL ? null : billing.login(email, String(password));
    if (!acct) { keys.forEach(failed); return send(res, 401, { error: 'Wrong email or password' }); }
    return send(res, 200, { ok: true, role: acct.role }, { 'Set-Cookie': cookie(acct) });
  }

  if (url.pathname === '/api/signup' && req.method === 'POST') {
    if (SIGNUPS === 'closed') return send(res, 403, { error: 'Signups are closed' });
    const { email = '', password = '', invite = '' } = await readBody(req);
    if (blocked(`i:${ipOf(req)}`)) return send(res, 429, { error: 'Too many attempts, wait a minute' });
    if (!EMAIL_RE.test(email) || String(email).toLowerCase() === OWNER_EMAIL) return send(res, 400, { error: 'Enter a valid email' });
    if (typeof password !== 'string' || password.length < 10 || password.length > 200) return send(res, 400, { error: 'Password must be at least 10 characters' });
    let acct;
    try { acct = billing.createAccount(email, password, 'customer', SIGNUPS === 'invite' ? String(invite) : undefined); }
    catch (e) { if (e.message === 'invite') { failed(`i:${ipOf(req)}`); return send(res, 403, { error: 'That invite code is not valid' }); } throw e; }
    if (!acct) return send(res, 409, { error: 'That email already has an account' });
    return send(res, 200, { ok: true, role: acct.role }, { 'Set-Cookie': cookie(acct) });
  }

  const acct = authed(req);
  if (!acct) return send(res, 401, { error: 'Not logged in' });
  const isAdmin = acct.role === 'owner';

  if (url.pathname === '/api/logout') return send(res, 200, { ok: true }, { 'Set-Cookie': 'vyre=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0' });
  if (url.pathname === '/api/me') return send(res, 200, { email: acct.email, role: acct.role });

  // ---- billing ----
  if (url.pathname === '/api/billing' && req.method === 'GET') return send(res, 200, billingView(acct));
  if (url.pathname === '/api/billing/topup' && req.method === 'POST') {
    if (!PAY_TO) return send(res, 503, { error: 'Payments are not switched on yet' });
    const amount = Billing.parseUsdc((await readBody(req)).usdc, 6);
    if (amount === null || amount < MIN_TOPUP || amount > MAX_TOPUP) return send(res, 400, { error: `Enter an amount from ${Billing.fmt(MIN_TOPUP)} to ${Billing.fmt(MAX_TOPUP)} USDC` });
    if (billing.invoices(acct.id).filter((i) => i.status === 'open').length >= 3) return send(res, 429, { error: 'You already have open invoices; pay or wait for them to expire' });
    const inv = billing.createInvoice(acct.id, amount);
    return send(res, 200, { id: inv.id, usdc: Billing.fmt6(inv.amount), to: PAY_TO, chainId: CHAIN_ID, expires: inv.expires });
  }

  // ---- owner only ----
  if (url.pathname.startsWith('/api/admin/') || url.pathname === '/api/system' || url.pathname === '/api/usage') {
    if (!isAdmin) return send(res, 403, { error: 'Not allowed' });
    if (url.pathname === '/api/system') return send(res, 200, await sysInfo());
    if (url.pathname === '/api/usage') return send(res, 200, usageThisMonth());
    if (url.pathname === '/api/admin/overview') return send(res, 200, adminOverview());
    if (url.pathname === '/api/admin/invite' && req.method === 'POST') return send(res, 200, { code: billing.createInvite() });
    if (url.pathname === '/api/admin/credit' && req.method === 'POST') {
      const { email = '', usdc = '', note = '' } = await readBody(req);
      const target = billing.accounts().find((a) => a.email === String(email).toLowerCase()), amount = Billing.parseUsdc(usdc);
      if (!target || !amount || amount === 0n) return send(res, 400, { error: 'Unknown account or bad amount' });
      billing.credit(target.id, 'adjust', amount, `manual-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`, String(note).slice(0, 120) || 'added by owner');
      return send(res, 200, { ok: true, balance: Billing.fmt(billing.balance(target.id)) });
    }
    return send(res, 404, { error: 'Not found' });
  }

  // ---- apps ----
  if (url.pathname === '/api/apps' && req.method === 'GET') return send(res, 200, await listApps(acct));

  if (url.pathname === '/api/deploy' && req.method === 'POST') {
    const body = await readBody(req);
    if (!isAdmin && APPS_DOMAIN && !String(body.domain || '').trim() && NAME_RE.test(body.name || '')) body.domain = `${body.name}.${APPS_DOMAIN}`;
    const d = deployArgs(body);
    if (d.error) return send(res, 400, { error: d.error });
    const exists = !!meta(d.name);
    if (!isAdmin) {
      if (exists && !canSee(acct, d.name)) return send(res, 403, { error: 'That name is taken' });
      if (exists && billing.ownerOf(d.name) === null) return send(res, 403, { error: 'That name is taken' });
      if (!exists && billing.appCount(acct.id) >= MAX_APPS) return send(res, 403, { error: `You can have up to ${MAX_APPS} apps` });
      if (!billing.canBuild(acct)) return send(res, 402, { error: `Add credit to build (at least ${Billing.fmt(billing.minToBuild())} USDC)` });
      const bad = await checkCustomerDomains(body.domain, d.name);
      if (bad) return send(res, 400, { error: bad });
    }
    if (!exists) billing.setOwner(d.name, acct.id);
    if (!startJob(d.name, d.args, acct)) return send(res, 409, { error: 'Already deploying' });
    return send(res, 202, { ok: true });
  }

  const m = /^\/api\/apps\/([a-z0-9-]+)(?:\/(redeploy|env|logs|deploy-log|hook|hook\/rotate))?$/.exec(url.pathname);
  if (m && NAME_RE.test(m[1]) && meta(m[1]) && canSee(acct, m[1])) {
    const name = m[1], action = m[2];
    if (!action && req.method === 'DELETE') { const r = await run('bash', [VYRE, 'rm', name]); if (r.ok) billing.removeOwner(name); deployLogs.delete(name); return send(res, r.ok ? 200 : 500, { ok: r.ok, out: r.out }); }
    if (action === 'redeploy' && req.method === 'POST') {
      if (!isAdmin && !billing.canBuild(acct)) return send(res, 402, { error: `Add credit to build (at least ${Billing.fmt(billing.minToBuild())} USDC)` });
      return startJob(name, ['redeploy', name], acct) ? send(res, 202, { ok: true }) : send(res, 409, { error: 'Already deploying' });
    }
    if (action === 'deploy-log') { const j = deployLogs.get(name); return send(res, 200, { running: !!(j && j.running), text: j ? j.text : '' }); }
    if (action === 'logs') { const r = await run('docker', ['logs', '--tail', '300', `vyre-${name}`]); return send(res, 200, { text: r.out }); }
    if (action === 'hook' || action === 'hook/rotate') {
      const key = repoKey(meta(name).REPO);
      if (!key) return send(res, 400, { error: 'Auto-deploy needs a repo on github.com' });
      const holder = billing.ownerOf(name) ?? owner.id; // the account the app belongs to (older apps belong to the owner)
      const h = billing.hookFor(holder, key);
      if (action === 'hook/rotate') { if (req.method !== 'POST') return send(res, 405, { error: 'POST only' }); h.secret = billing.rotateHook(h.id); }
      const base = DASH_DOMAIN ? `https://${DASH_DOMAIN}` : `https://${req.headers.host}`;
      return send(res, 200, { repo: key, url: `${base}/hooks/github/${h.id}`, secret: h.secret, branch: meta(name).BRANCH,
        apps: appNames().filter((n) => repoKey(meta(n).REPO) === key && ownedBy(billing.account(holder), n)) });
    }
    if (action === 'env') {
      if (req.method === 'GET') return send(res, 200, { keys: readEnvKeys(name) });
      if (req.method === 'POST') {
        const err = await setEnv(name, (await readBody(req)).vars || '');
        return err ? send(res, 400, { error: err }) : send(res, 200, { ok: true });
      }
    }
  }
  send(res, 404, { error: 'Not found' });
}

const MIME = { '.png': 'image/png', '.woff2': 'font/woff2', '.css': 'text/css', '.txt': 'text/plain; charset=utf-8' };
const PUBLIC = path.join(__dirname, 'public');
function serveAsset(res, pathname) {
  const file = path.normalize(path.join(PUBLIC, decodeURIComponent(pathname)));
  const type = MIME[path.extname(file)];
  if (!file.startsWith(path.join(PUBLIC, 'assets') + path.sep) || !type || !fs.existsSync(file)) return send(res, 404, 'Not found');
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(file).pipe(res);
}

const oauth = MCP_TOKEN ? require('./oauth')({ secret: SECRET, baseUrl: DASH_DOMAIN ? `https://${DASH_DOMAIN}` : '', tryPassword,
  extraRedirects: (process.env.OAUTH_EXTRA_REDIRECTS || '').split(',').map((x) => x.trim()).filter((x) => /^https:\/\/\S+$/.test(x)) }) : null;
const mcp = require('./mcp')(core, MCP_TOKEN, oauth);

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (oauth && (url.pathname.startsWith('/.well-known/oauth-') || url.pathname.startsWith('/oauth/')) && await oauth.handle(req, res, url)) return;
    const hm = /^\/hooks\/github\/([^/]+)$/.exec(url.pathname);
    if (hm) return await githubHook(req, res, hm[1]);
    if (url.pathname === '/mcp') return await mcp.handle(req, res, readBody);
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname.startsWith('/assets/')) return serveAsset(res, url.pathname);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return send(res, 200, fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8'), { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'unsafe-inline'; font-src 'self'; img-src 'self'" });
    }
    send(res, 404, 'Not found');
  } catch (e) { send(res, 500, { error: 'Server error' }); console.error(e); }
}).listen(PORT, () => console.log('Vyre dashboard on', PORT));
