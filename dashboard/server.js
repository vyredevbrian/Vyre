// Vyre dashboard: zero-dependency Node server that wraps the `vyre` CLI.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const PASSWORD = process.env.DASH_PASSWORD;
if (!PASSWORD) { console.error('DASH_PASSWORD is required'); process.exit(1); }
const SECRET = process.env.DASH_SECRET || crypto.createHash('sha256').update('vyre:' + PASSWORD).digest('hex');
const APPS = process.env.VYRE_APPS || '/opt/vyre/apps';
const VYRE = process.env.VYRE_BIN || '/opt/vyre/bin/vyre';
const PORT = process.env.PORT || 3000;
const MCP_TOKEN = process.env.MCP_TOKEN || '';
const SESSION_MS = 7 * 24 * 3600 * 1000;

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const DOMAIN_RE = /^([a-z0-9-]+\.)+[a-z]{2,}$/i;
const BRANCH_RE = /^[A-Za-z0-9._\/-]{1,100}$/;
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('hex');
const safeEq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const makeToken = () => { const exp = String(Date.now() + SESSION_MS); return exp + '.' + sign(exp); };
function authed(req) {
  const m = /(?:^|;\s*)vyre=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  return !!sig && safeEq(sig, sign(exp)) && Number(exp) > Date.now();
}

let failures = 0, lockedUntil = 0;
const deployLogs = new Map(); // name -> { running, text }

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
    const conf = Object.fromEntries(fs.readFileSync(path.join(APPS, name, 'app.conf'), 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    return conf;
  } catch { return null; }
}

function startJob(name, args) {
  const log = deployLogs.get(name);
  if (log && log.running) return false;
  const job = { running: true, text: '' };
  deployLogs.set(name, job);
  const p = spawn(VYRE, args, { env: { ...process.env, VYRE_APPS: APPS } });
  const add = (c) => { job.text = (job.text + c).slice(-60_000); };
  p.stdout.on('data', add); p.stderr.on('data', add);
  p.on('close', (code) => { add(`\n[exit ${code}]\n`); job.running = false; job.ok = code === 0; });
  return true;
}

async function listApps() {
  const names = fs.existsSync(APPS) ? fs.readdirSync(APPS).filter((n) => meta(n)) : [];
  return Promise.all(names.map(async (name) => {
    const m = meta(name);
    const ps = await run('docker', ['ps', '-a', '--filter', `label=vyre.app=${name}`, '--format', '{{.Status}}']);
    const job = deployLogs.get(name);
    return { name, domain: m.DOMAIN, repo: m.REPO.replace(/\/\/[^@/]*@/, '//***@'), branch: m.BRANCH, port: m.PORT, status: ps.out.trim() || 'not running', deploying: !!(job && job.running) };
  }));
}

async function sysInfo() {
  const mem = Object.fromEntries(fs.readFileSync('/proc/meminfo', 'utf8').split('\n').filter(Boolean).map((l) => { const [k, v] = l.split(':'); return [k, parseInt(v, 10) * 1024]; }));
  const df = await run('df', ['-B1', '--output=size,used', '/']);
  const [size, used] = (df.out.split('\n')[1] || '').trim().split(/\s+/).map(Number);
  return { memTotal: mem.MemTotal, memAvailable: mem.MemAvailable, swapTotal: mem.SwapTotal, swapFree: mem.SwapFree, diskSize: size, diskUsed: used, load: fs.readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3) };
}

// Returns an error string, or null and the vyre args.
function deployArgs(b) {
  const { repo = '', name = '', domain = '' } = b;
  const port = String(b.port || 3000), branch = b.branch || 'main';
  if (!/^https:\/\/\S+$/.test(repo)) return { error: 'Repo must be an https:// git URL' };
  if (!NAME_RE.test(name)) return { error: 'Name: lowercase letters, digits, dashes' };
  if (!DOMAIN_RE.test(domain)) return { error: 'Invalid domain' };
  if (!/^\d{2,5}$/.test(port)) return { error: 'Invalid port' };
  if (!BRANCH_RE.test(branch)) return { error: 'Invalid branch' };
  return { name, args: ['deploy', repo, name, domain, '--port', port, '--branch', branch] };
}

const readEnvKeys = (name) => {
  const file = path.join(APPS, name, '.env');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => l.split('=')[0]) : [];
};

// Returns an error string or null.
async function setEnv(name, vars) {
  const pairs = String(vars).split('\n').map((l) => l.trim()).filter(Boolean);
  for (const kv of pairs) if (!kv.includes('=') || !KEY_RE.test(kv.split('=')[0])) return `Bad line: ${kv.split('=')[0]}`;
  const r = await run(VYRE, ['env', name, ...pairs]);
  return r.ok ? null : 'Failed to save';
}

const core = { APPS, NAME_RE, meta, listApps, sysInfo, deployArgs, startJob, readEnvKeys, setEnv, run, VYRE, deployLogs };

async function api(req, res, url) {
  if (url.pathname === '/api/login' && req.method === 'POST') {
    if (Date.now() < lockedUntil) return send(res, 429, { error: 'Too many attempts, wait a minute' });
    const { password = '' } = await readBody(req);
    if (safeEq(String(password), PASSWORD)) {
      failures = 0;
      return send(res, 200, { ok: true }, { 'Set-Cookie': `vyre=${makeToken()}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}` });
    }
    if (++failures >= 5) { lockedUntil = Date.now() + 60_000; failures = 0; }
    return send(res, 401, { error: 'Wrong password' });
  }
  if (!authed(req)) return send(res, 401, { error: 'Not logged in' });

  if (url.pathname === '/api/logout') return send(res, 200, { ok: true }, { 'Set-Cookie': 'vyre=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0' });

  if (url.pathname === '/api/system') return send(res, 200, await sysInfo());

  if (url.pathname === '/api/apps' && req.method === 'GET') return send(res, 200, await listApps());

  if (url.pathname === '/api/deploy' && req.method === 'POST') {
    const d = deployArgs(await readBody(req));
    if (d.error) return send(res, 400, { error: d.error });
    return startJob(d.name, d.args) ? send(res, 202, { ok: true }) : send(res, 409, { error: 'Already deploying' });
  }

  const m = /^\/api\/apps\/([a-z0-9-]+)(?:\/(redeploy|env|logs|deploy-log))?$/.exec(url.pathname);
  if (m && NAME_RE.test(m[1]) && meta(m[1])) {
    const name = m[1], action = m[2];
    if (!action && req.method === 'DELETE') { const r = await run(VYRE, ['rm', name]); deployLogs.delete(name); return send(res, r.ok ? 200 : 500, { ok: r.ok, out: r.out }); }
    if (action === 'redeploy' && req.method === 'POST') return startJob(name, ['redeploy', name]) ? send(res, 202, { ok: true }) : send(res, 409, { error: 'Already deploying' });
    if (action === 'deploy-log') { const j = deployLogs.get(name); return send(res, 200, { running: !!(j && j.running), text: j ? j.text : '' }); }
    if (action === 'logs') { const r = await run('docker', ['logs', '--tail', '300', `vyre-${name}`]); return send(res, 200, { text: r.out }); }
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

const mcp = require('./mcp')(core, MCP_TOKEN);

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/mcp') return await mcp.handle(req, res, readBody);
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return send(res, 200, fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8'), { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" });
    }
    send(res, 404, 'Not found');
  } catch (e) { send(res, 500, { error: 'Server error' }); console.error(e); }
}).listen(PORT, () => console.log('Vyre dashboard on', PORT));
