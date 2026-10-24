// End-to-end: the real server, a fake VYRE chain (JSON-RPC) and a stand-in for the vyre tool. Run: node --no-warnings --test dashboard/test/server.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { spawn } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-'));
const APPS = path.join(tmp, 'apps'); fs.mkdirSync(APPS);
const PAY = '0x00000000000000000000000000000000000000AA';
const stub = path.join(tmp, 'vyre-stub.sh');
fs.writeFileSync(stub, `#!/usr/bin/env bash
case $1 in
  deploy) mkdir -p "$VYRE_APPS/$3"; printf 'REPO=%s\\nDOMAIN=%s\\nPORT=3000\\nBRANCH=main\\n' "$2" "$4" > "$VYRE_APPS/$3/app.conf"; env > "$VYRE_APPS/$3/envdump"; sleep 2;;
  redeploy) sleep 2;;
  rm) rm -rf "\${VYRE_APPS:?}/$2";;
  env) mkdir -p "$VYRE_APPS/$2"; name=$2; shift 2; for kv in "$@"; do echo "$kv" >> "$VYRE_APPS/$name/.env"; done;;
esac
`, { mode: 0o755 });

// fake chain
const chain = { head: 100, blocks: {}, receipts: {} };
const rpc = http.createServer((req, res) => {
  let d = ''; req.on('data', (c) => d += c); req.on('end', () => {
    const { method, params, id } = JSON.parse(d); let result = null;
    if (method === 'eth_chainId') result = '0xbe5';
    else if (method === 'eth_blockNumber') result = '0x' + chain.head.toString(16);
    else if (method === 'eth_getBlockByNumber') result = chain.blocks[parseInt(params[0], 16)] || { timestamp: '0x1', transactions: [] };
    else if (method === 'eth_getTransactionReceipt') result = chain.receipts[params[0]] || { status: '0x1' };
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  });
});
let txn = 0;
const pay = (usdcStr, to = PAY) => { // a native transfer of an exact USDC amount (18 decimals), in a new block
  const [w, f = ''] = usdcStr.split('.'); const wei = BigInt(w) * 10n ** 18n + BigInt(f.padEnd(18, '0'));
  const block = ++chain.head, hash = '0x' + (++txn).toString(16).padStart(64, '0');
  chain.blocks[block] = { timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16), transactions: [{ hash, to, from: '0xabc', value: '0x' + wei.toString(16) }] };
  return hash;
};

let server, base;
const port = 4000 + Math.floor(Math.random() * 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out'); await sleep(100); } };
let clients = 0;
const client = () => { // each client is a different visitor address, as Caddy would pass on
  let ck = ''; const ip = `10.1.${Math.floor(++clients / 250)}.${clients % 250}`;
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, ...(ck ? { Cookie: ck } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) ck = sc.split(';')[0];
    let json = null; try { json = await r.json(); } catch {}
    return { status: r.status, json };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b || {}), del: (p) => call('DELETE', p) };
};

test.before(async () => {
  await new Promise((r) => rpc.listen(0, '127.0.0.1', r));
  server = spawn('node', ['--no-warnings', path.join(__dirname, '../server.js')], {
    env: { PATH: process.env.PATH, NODE_ENV: 'test', PORT: String(port), DASH_PASSWORD: 'ownerpw-123', MCP_TOKEN: 'mcp-test-token', VYRE_APPS: APPS, VYRE_BIN: stub, VYRE_DB: path.join(tmp, 'b.db'), VYRE_USAGE: path.join(tmp, 'u.jsonl'),
      SIGNUPS: 'invite', PAY_TO: PAY, CHAIN_RPC: `http://127.0.0.1:${rpc.address().port}`, CHAIN_ID: '3045', CONFIRM_SECONDS: '1', WATCH_MS: '150', SERVER_IP: '1.2.3.4',
      APPS_DOMAIN: 'apps.example.com', DASH_DOMAIN: 'deploy.example.com', RESERVED_ZONES: 'vyrechain.com', CUSTOMER_MAX_APPS: '2', PRICE_BUILD_PER_MIN_USDC: '0.6', MIN_TOPUP_USDC: '1',
      DNS_MOCK: JSON.stringify({ 'mine.com': ['1.2.3.4'], 'www.mine.com': ['1.2.3.4'], 'other.com': ['9.9.9.9'] }), GITHUB_TOKEN: 'ghp_owner_secret_token', OAUTH_EXTRA_REDIRECTS: 'https://otherai.example/oauth/callback, http://not-https.example/cb' },
  });
  server.stderr.on('data', (d) => process.stderr.write(d));
  base = `http://127.0.0.1:${port}`;
  await until(async () => { try { return (await fetch(base + '/api/config')).ok; } catch { return false; } });
});
test.after(() => { server.kill(); rpc.close(); });

const owner = async () => { const c = client(); assert.equal((await c.post('/api/login', { password: 'ownerpw-123' })).status, 200); return c; };
const signup = async (email, invite) => { const c = client(); const r = await c.post('/api/signup', { email, password: 'a-long-password', invite }); assert.equal(r.status, 200, JSON.stringify(r.json)); return c; };
const invite = async (o) => (await o.post('/api/admin/invite')).json.code;
const waitJob = async (c, name) => until(async () => { const r = await c.get(`/api/apps/${name}/deploy-log`); return r.json && r.json.running === false && r.json.text.includes('[exit') ? r.json : null; }, 15000);

test('config, and nothing works without a login', async () => {
  const c = client();
  assert.deepEqual((await c.get('/api/config')).json, { signups: 'invite', payments: true, appsDomain: 'apps.example.com' });
  for (const p of ['/api/apps', '/api/billing', '/api/admin/overview', '/api/system', '/api/me']) assert.equal((await c.get(p)).status, 401, p);
  assert.equal((await c.post('/api/deploy', { repo: 'https://x/y.git', name: 'a' })).status, 401);
});

test('signup needs a valid, unused invite; bad emails and short passwords are refused', async () => {
  const o = await owner(), code = await invite(o), c = client();
  assert.equal((await c.post('/api/signup', { email: 'a@x.com', password: 'a-long-password' })).status, 403);
  assert.equal((await c.post('/api/signup', { email: 'a@x.com', password: 'a-long-password', invite: 'bogus' })).status, 403);
  assert.equal((await c.post('/api/signup', { email: 'not-an-email', password: 'a-long-password', invite: code })).status, 400);
  assert.equal((await c.post('/api/signup', { email: 'a@x.com', password: 'short', invite: code })).status, 400);
  assert.equal((await c.post('/api/signup', { email: 'owner@vyre.local', password: 'a-long-password', invite: code })).status, 400);
  assert.equal((await c.post('/api/signup', { email: 'a@x.com', password: 'a-long-password', invite: code })).status, 200); // the earlier failures did not burn the code
  assert.equal((await client().post('/api/signup', { email: 'b@x.com', password: 'a-long-password', invite: code })).status, 403); // used
  const code2 = await invite(o);
  assert.equal((await client().post('/api/signup', { email: 'a@x.com', password: 'a-long-password', invite: code2 })).status, 409); // duplicate email
  assert.equal((await client().post('/api/signup', { email: 'c@x.com', password: 'a-long-password', invite: code2 })).status, 200); // and that did not burn code2
});

test('logins: owner password, customer email, wrong credentials, and the owner account cannot be reached by email', async () => {
  const o = await owner(); await signup('login@x.com', await invite(o));
  assert.equal((await client().post('/api/login', { password: 'nope' })).status, 401);
  assert.equal((await client().post('/api/login', { email: 'login@x.com', password: 'wrong-password' })).status, 401);
  assert.equal((await client().post('/api/login', { email: 'ghost@x.com', password: 'a-long-password' })).status, 401);
  assert.equal((await client().post('/api/login', { email: 'owner@vyre.local', password: 'ownerpw-123' })).status, 401);
  const c = client(); assert.equal((await c.post('/api/login', { email: 'LOGIN@x.com', password: 'a-long-password' })).status, 200);
  assert.deepEqual((await c.get('/api/me')).json, { email: 'login@x.com', role: 'customer' });
  const bad = client(); let last; for (let i = 0; i < 7; i++) last = await bad.post('/api/login', { email: 'rl@x.com', password: 'x' + i });
  assert.equal(last.status, 429);
});

test('customers cannot use owner endpoints', async () => {
  const c = await signup('plain@x.com', await invite(await owner()));
  for (const p of ['/api/admin/overview', '/api/system', '/api/usage']) assert.equal((await c.get(p)).status, 403, p);
  assert.equal((await c.post('/api/admin/invite')).status, 403);
  assert.equal((await c.post('/api/admin/credit', { email: 'plain@x.com', usdc: '100' })).status, 403);
});

test('money: no credit means no build; top-up rules; exact-amount payment credits once; wrong amounts do not', async () => {
  const o = await owner(), c = await signup('pay@x.com', await invite(o));
  assert.equal((await c.post('/api/deploy', { repo: 'https://github.com/a/b.git', name: 'nocredit' })).status, 402);
  assert.equal((await c.post('/api/billing/topup', { usdc: '0.5' })).status, 400);     // under the minimum
  assert.equal((await c.post('/api/billing/topup', { usdc: '1000000' })).status, 400); // over the maximum
  assert.equal((await c.post('/api/billing/topup', { usdc: '1.0000001' })).status, 400); // seven decimals
  assert.equal((await c.post('/api/billing/topup', { usdc: '-5' })).status, 400);
  assert.equal((await c.post('/api/billing/topup', { usdc: '1e3' })).status, 400);
  const inv = (await c.post('/api/billing/topup', { usdc: '5' })).json;
  assert.match(inv.usdc, /^5\.00\d{4}$/); assert.equal(inv.to, PAY); assert.equal(inv.chainId, 3045);
  pay(inv.usdc.slice(0, -1) + (inv.usdc.endsWith('9') ? '8' : '9'));   // off by a micro
  pay(inv.usdc, '0x00000000000000000000000000000000000000BB');        // right amount, wrong wallet
  await sleep(2000); // longer than the one second a block must age before it is trusted
  assert.equal((await c.get('/api/billing')).json.balance.usdc, '0.00');
  const unmatched = (await o.get('/api/admin/overview')).json.unmatched; assert.equal(unmatched.length, 1);
  pay(inv.usdc);
  await until(async () => (await c.get('/api/billing')).json.balance.usdc === inv.usdc.replace(/0+$/, ''));
  const b = (await c.get('/api/billing')).json; assert.equal(b.ledger.length, 1); assert.equal(b.invoices[0].status, 'paid');
  pay(inv.usdc); await sleep(2000);                                         // the same amount again: the invoice is used up
  assert.equal((await c.get('/api/billing')).json.ledger.length, 1);
  assert.equal((await o.get('/api/admin/overview')).json.unmatched.length, 2);
});

test('a paid customer builds, is charged exactly the metered amount, and sees only their own apps', async () => {
  const o = await owner(), a = await signup('own1@x.com', await invite(o)), b = await signup('own2@x.com', await invite(o));
  const inv = (await a.post('/api/billing/topup', { usdc: '5' })).json; pay(inv.usdc);
  await until(async () => parseFloat((await a.get('/api/billing')).json.balance.usdc) >= 5);
  const before = (await a.get('/api/billing')).json.balance.nano;
  assert.equal((await a.post('/api/deploy', { repo: 'https://github.com/a/b.git', name: 'alpha' })).status, 202); // no domain: gets alpha.apps.example.com
  await waitJob(a, 'alpha');
  const apps = (await a.get('/api/apps')).json; assert.equal(apps.length, 1); assert.equal(apps[0].domain, 'alpha.apps.example.com');
  const after = (await a.get('/api/billing')).json, charged = BigInt(before) - BigInt(after.balance.nano);
  assert.ok(charged > 0n, 'a build is never free for a customer');
  const secs = Number(charged / 10_000_000n); assert.ok(secs >= 2 && secs <= 6, `charged ${secs}s of build time`); assert.equal(charged % 10_000_000n, 0n); // 0.6 USDC a minute = 10,000,000 nano a second
  assert.equal(after.ledger[0].kind, 'build');
  // the other customer sees nothing and can touch nothing
  assert.deepEqual((await b.get('/api/apps')).json, []);
  for (const p of ['/api/apps/alpha/logs', '/api/apps/alpha/env', '/api/apps/alpha/deploy-log']) assert.equal((await b.get(p)).status, 404, p);
  assert.equal((await b.post('/api/apps/alpha/redeploy')).status, 404);
  assert.equal((await b.post('/api/apps/alpha/env', { vars: 'A=1' })).status, 404);
  assert.equal((await b.del('/api/apps/alpha')).status, 404);
  assert.ok(fs.existsSync(path.join(APPS, 'alpha')));
  // and cannot take the name, even with credit
  const inv2 = (await b.post('/api/billing/topup', { usdc: '5' })).json; pay(inv2.usdc);
  await until(async () => parseFloat((await b.get('/api/billing')).json.balance.usdc) >= 5);
  assert.equal((await b.post('/api/deploy', { repo: 'https://github.com/x/y.git', name: 'alpha' })).status, 403);
  // the owner sees all of it, and was never charged
  const all = (await o.get('/api/apps')).json; assert.ok(all.some((x) => x.name === 'alpha' && x.account === 'own1@x.com'));
  assert.equal((await o.get('/api/billing')).json.role, 'owner');
});

test('customer builds run with a bare environment; the owner keeps the GitHub token', async () => {
  const o = await owner(), c = await signup('env@x.com', await invite(o));
  pay((await c.post('/api/billing/topup', { usdc: '5' })).json.usdc);
  await until(async () => parseFloat((await c.get('/api/billing')).json.balance.usdc) >= 5);
  assert.equal((await c.post('/api/deploy', { repo: 'https://github.com/a/b.git', name: 'envcust' })).status, 202); await waitJob(c, 'envcust');
  const dump = fs.readFileSync(path.join(APPS, 'envcust/envdump'), 'utf8');
  for (const secret of ['DASH_PASSWORD', 'ownerpw-123', 'GITHUB_TOKEN', 'ghp_owner_secret_token', 'MCP_TOKEN', 'VYRE_DB']) assert.ok(!dump.includes(secret), `leaked ${secret}`);
  assert.ok(dump.includes('VYRE_APPS='));
  assert.equal((await o.post('/api/deploy', { repo: 'https://github.com/a/b.git', name: 'envowner', domain: 'envowner.example.net' })).status, 202); await waitJob(o, 'envowner');
  assert.ok(fs.readFileSync(path.join(APPS, 'envowner/envdump'), 'utf8').includes('GITHUB_TOKEN=ghp_owner_secret_token'));
});

test('customers cannot claim the dashboard, the owner zones, other people\'s names or domains that do not point here', async () => {
  const o = await owner(), c = await signup('dom@x.com', await invite(o));
  pay((await c.post('/api/billing/topup', { usdc: '50' })).json.usdc);
  await until(async () => parseFloat((await c.get('/api/billing')).json.balance.usdc) >= 50);
  const d = (name, domain) => c.post('/api/deploy', { repo: 'https://github.com/a/b.git', name, domain });
  assert.equal((await d('d1', 'deploy.example.com')).status, 400);          // the dashboard's own name
  assert.equal((await d('d1', 'rpc.vyrechain.com')).status, 400);           // the owner's zone
  assert.equal((await d('d1', 'vyrechain.com')).status, 400);
  assert.equal((await d('d1', 'other.com')).status, 400);                   // points somewhere else
  assert.equal((await d('d1', 'nowhere.com')).status, 400);                 // does not resolve
  assert.equal((await d('d1', 'a.b.apps.example.com')).status, 400);        // not a single name under the apps domain
  assert.equal((await d('d1', 'mine.com,other.com')).status, 400);          // one bad alias spoils the list
  assert.equal((await d('d1', 'bad_domain')).status, 400);
  assert.equal(fs.existsSync(path.join(APPS, 'd1')), false);                // nothing was created
  assert.equal((await d('d1', 'mine.com,www.mine.com')).status, 202); await waitJob(c, 'd1');
  const o2 = await signup('dom2@x.com', await invite(o)); pay((await o2.post('/api/billing/topup', { usdc: '5' })).json.usdc);
  await until(async () => parseFloat((await o2.get('/api/billing')).json.balance.usdc) >= 5);
  assert.equal((await o2.post('/api/deploy', { repo: 'https://github.com/a/b.git', name: 'd2', domain: 'mine.com' })).status, 400); // already taken by d1
  assert.equal((await d('d3', 'extra.apps.example.com')).status, 202); await waitJob(c, 'd3');
  assert.equal((await d('d4', '')).status, 403);                           // already at the two-app limit (d1, d3)
  const nope = await c.post('/api/deploy', { repo: 'git://x/y', name: 'd5', domain: 'd5.apps.example.com' }); assert.equal(nope.status, 400);
});

test('old apps with no recorded owner belong to the owner, not to customers', async () => {
  fs.mkdirSync(path.join(APPS, 'legacy')); fs.writeFileSync(path.join(APPS, 'legacy/app.conf'), 'REPO=https://x/y.git\nDOMAIN=legacy.example.net\nPORT=3000\nBRANCH=main\n');
  const o = await owner(), c = await signup('leg@x.com', await invite(o));
  assert.ok(!(await c.get('/api/apps')).json.some((x) => x.name === 'legacy'));
  assert.equal((await c.post('/api/apps/legacy/redeploy')).status, 404);
  assert.equal((await c.post('/api/deploy', { repo: 'https://github.com/a/b.git', name: 'legacy', domain: 'legacy2.apps.example.com' })).status, 403);
  assert.ok((await o.get('/api/apps')).json.some((x) => x.name === 'legacy'));
});

test('the owner is never charged and needs no credit', async () => {
  const o = await owner();
  assert.equal((await o.post('/api/deploy', { repo: 'https://github.com/a/b.git', name: 'free1', domain: 'free1.example.net' })).status, 202); await waitJob(o, 'free1');
  const b = (await o.get('/api/billing')).json; assert.equal(b.ledger.length, 0); assert.equal(b.balance.usdc, '0.00');
  assert.equal((await o.post('/api/apps/free1/redeploy')).status, 202);
});

test('owner can add credit by hand, and bad requests are refused', async () => {
  const o = await owner(), c = await signup('manual@x.com', await invite(o));
  assert.equal((await o.post('/api/admin/credit', { email: 'manual@x.com', usdc: '12.5', note: 'welcome' })).json.balance, '12.50');
  assert.equal((await o.post('/api/admin/credit', { email: 'ghost@x.com', usdc: '1' })).status, 400);
  assert.equal((await o.post('/api/admin/credit', { email: 'manual@x.com', usdc: 'abc' })).status, 400);
  assert.equal((await o.post('/api/admin/credit', { email: 'manual@x.com', usdc: '0' })).status, 400);
  const l = (await c.get('/api/billing')).json.ledger; assert.equal(l[0].note, 'welcome');
});

test('the MCP connector exposes a read-only billing overview, and only with the token', async () => {
  const call = (token) => fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'billing_overview', arguments: {} } }) });
  assert.equal((await call(null)).status, 401);
  assert.equal((await call('wrong')).status, 401);
  const r = await (await call('mcp-test-token')).json(); const o = JSON.parse(r.result.content[0].text);
  assert.ok(Array.isArray(o.accounts) && o.accounts.some((a) => a.role === 'owner'));
  assert.equal(o.chain.payTo, PAY); assert.ok(o.creditSold && o.creditOwed); assert.ok(!JSON.stringify(o).includes('pw'));
});

test('connector sign-in only sends users back to Claude, localhost, or addresses the owner listed exactly', async () => {
  const reg = async (uri) => (await fetch(base + '/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: [uri], client_name: 't' }) })).status;
  assert.equal(await reg('https://claude.ai/api/mcp/auth_callback'), 201);
  assert.equal(await reg('http://localhost:8123/callback'), 201);
  assert.equal(await reg('https://otherai.example/oauth/callback'), 201);       // listed by the owner
  assert.equal(await reg('https://otherai.example/oauth/callback/'), 400);      // near miss
  assert.equal(await reg('https://otherai.example/other'), 400);
  assert.equal(await reg('https://evil.example/cb'), 400);
  assert.equal(await reg('http://not-https.example/cb'), 400);                  // an owner entry that is not https is ignored
  assert.equal(await reg('https://claude.ai.evil.example/x'), 400);
  const meta = await (await fetch(base + '/.well-known/oauth-authorization-server')).json();
  assert.deepEqual(meta.code_challenge_methods_supported, ['S256']);
});

// ---- auto-deploy from GitHub pushes ----
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const hmac = (secret, body) => 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
let delivery = 0;
const hookCall = async (url, secret, payload, { event = 'push', sig, raw } = {}) => {
  const body = raw ?? JSON.stringify(payload);
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': event, 'X-GitHub-Delivery': 'd' + (++delivery), 'X-Hub-Signature-256': sig ?? hmac(secret, body), 'X-Forwarded-For': `10.9.${Math.floor(delivery / 250)}.${delivery % 250}` }, body });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json };
};
const push = (repo, ref = 'refs/heads/main', extra = {}) => ({ ref, repository: { full_name: repo }, ...extra });
const redeploys = (app) => fs.readFileSync(path.join(tmp, 'u.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.app === app && r.kind === 'redeploy').length;
const idle = async (c, name) => until(async () => { const r = await c.get(`/api/apps/${name}/deploy-log`); return r.json && r.json.running === false ? r.json : null; }, 20000);
const setBalance = (email, nano) => { const raw = new DatabaseSync(path.join(tmp, 'b.db')); raw.exec('PRAGMA busy_timeout=5000'); raw.prepare('UPDATE accounts SET balance_nano = ? WHERE email = ?').run(nano, email); raw.close(); };

test('auto-deploy: a signed push redeploys every matching app of the account, and nothing else', async () => {
  const o = await owner();
  for (const [n, d] of [['hk-a', 'hk-a.example.net'], ['hk-b', 'hk-b.example.net']]) { assert.equal((await o.post('/api/deploy', { repo: 'https://github.com/Acme/Site.git', name: n, domain: d })).status, 202); await waitJob(o, n); }
  assert.equal((await o.post('/api/deploy', { repo: 'https://github.com/acme/other.git', name: 'hk-c', domain: 'hk-c.example.net' })).status, 202); await waitJob(o, 'hk-c');
  const h = (await o.get('/api/apps/hk-a/hook')).json;
  assert.equal(h.repo, 'acme/site'); assert.deepEqual(h.apps.sort(), ['hk-a', 'hk-b']); assert.match(h.url, /^https:\/\/deploy\.example\.com\/hooks\/github\/[0-9a-f]{24}$/); assert.match(h.secret, /^[0-9a-f]{64}$/);
  assert.deepEqual((await o.get('/api/apps/hk-b/hook')).json.url, h.url); // one hook per repository, shared by its apps
  const url = base + new URL(h.url).pathname;
  assert.equal((await hookCall(url, h.secret, { zen: 'x' }, { event: 'ping' })).status, 200);
  const r = await hookCall(url, h.secret, push('Acme/Site'));
  assert.equal(r.status, 202); assert.deepEqual(r.json.deploying.sort(), ['hk-a', 'hk-b']);
  await idle(o, 'hk-a'); await idle(o, 'hk-b');
  assert.equal(redeploys('hk-a'), 1); assert.equal(redeploys('hk-b'), 1); assert.equal(redeploys('hk-c'), 0);
});

test('auto-deploy: bad or missing signatures, unknown hooks and other events do nothing', async () => {
  const o = await owner(); const h = (await o.get('/api/apps/hk-a/hook')).json; const url = base + new URL(h.url).pathname;
  const before = redeploys('hk-a');
  assert.equal((await hookCall(url, 'wrong-secret', push('acme/site'))).status, 401);
  assert.equal((await hookCall(url, h.secret, push('acme/site'), { sig: 'sha256=' + 'a'.repeat(64) })).status, 401);
  assert.equal((await hookCall(url, h.secret, push('acme/site'), { sig: 'nonsense' })).status, 401);
  assert.equal((await hookCall(url, h.secret, push('acme/site'), { sig: hmac(h.secret, 'different body') })).status, 401);
  assert.equal((await hookCall(base + '/hooks/github/' + '0'.repeat(24), h.secret, push('acme/site'))).status, 404);
  assert.equal((await hookCall(base + '/hooks/github/not-an-id', h.secret, push('acme/site'))).status, 404);
  assert.equal((await fetch(url, { method: 'GET' })).status, 405);
  assert.deepEqual((await hookCall(url, h.secret, push('acme/site'), { event: 'issues' })).json, { ignored: 'event issues' });
  assert.deepEqual((await hookCall(url, h.secret, push('acme/site', 'refs/tags/v1'))).json, { ignored: 'not a branch update' });
  assert.deepEqual((await hookCall(url, h.secret, push('acme/site', 'refs/heads/main', { deleted: true }))).json, { ignored: 'not a branch update' });
  assert.deepEqual((await hookCall(url, h.secret, push('acme/someone-elses-repo'))).json, { ignored: 'a different repository' });
  const other = await hookCall(url, h.secret, push('acme/site', 'refs/heads/feature-x')); assert.equal(other.status, 202); assert.deepEqual(other.json, { deploying: [], queued: [], skipped: [] });
  assert.equal((await hookCall(url, h.secret, null, { raw: '{not json' })).status, 400);
  await sleep(500); assert.equal(redeploys('hk-a'), before);
  // the same delivery twice (a GitHub retry) runs once
  const body = JSON.stringify(push('acme/site')), headers = { 'Content-Type': 'application/json', 'X-GitHub-Event': 'push', 'X-GitHub-Delivery': 'same-delivery', 'X-Hub-Signature-256': hmac(h.secret, body), 'X-Forwarded-For': '10.8.0.1' };
  assert.equal((await fetch(url, { method: 'POST', headers, body })).status, 202);
  assert.deepEqual(await (await fetch(url, { method: 'POST', headers, body })).json(), { ignored: 'already handled' });
  await idle(o, 'hk-a'); await idle(o, 'hk-b'); assert.equal(redeploys('hk-a'), before + 1);
});

test('auto-deploy: pushes that arrive during a build wait and run once, not once each', async () => {
  const o = await owner(); const h = (await o.get('/api/apps/hk-a/hook')).json; const url = base + new URL(h.url).pathname;
  await idle(o, 'hk-a'); await idle(o, 'hk-b'); const before = redeploys('hk-a');
  const rs = []; for (let i = 0; i < 4; i++) rs.push((await hookCall(url, h.secret, push('acme/site'))).json);
  assert.deepEqual(rs[0].deploying.sort(), ['hk-a', 'hk-b']); for (const r of rs.slice(1)) assert.deepEqual(r.queued.sort(), ['hk-a', 'hk-b']);
  await sleep(600); await until(async () => redeploys('hk-a') === before + 2, 20000); await sleep(2500); await idle(o, 'hk-a');
  assert.equal(redeploys('hk-a'), before + 2); // the build that was running, plus one for all the pushes behind it
});

test('auto-deploy: a customer without credit is skipped and told so; with credit it builds and is charged; accounts never cross', async () => {
  const o = await owner(), c = await signup('hook-cust@x.com', await invite(o));
  assert.equal((await o.post('/api/admin/credit', { email: 'hook-cust@x.com', usdc: '10' })).status, 200);
  assert.equal((await c.post('/api/deploy', { repo: 'https://github.com/acme/site.git', name: 'hk-cust', domain: 'hk-cust.apps.example.com' })).status, 202); await waitJob(c, 'hk-cust');
  assert.equal((await c.get('/api/apps/hk-a/hook')).status, 404);                  // not theirs
  const h = (await c.get('/api/apps/hk-cust/hook')).json; const url = base + new URL(h.url).pathname;
  assert.deepEqual(h.apps, ['hk-cust']);                                          // the owner's apps from the same repo are not in the customer's hook
  const ownerHook = (await o.get('/api/apps/hk-a/hook')).json; assert.notEqual(ownerHook.url, h.url);
  setBalance('hook-cust@x.com', 1_000_000_000n);                                  // 1 USDC: below the five build minutes needed
  const beforeCust = redeploys('hk-cust'), beforeOwner = redeploys('hk-a');
  const r = await hookCall(url, h.secret, push('acme/site'));
  assert.deepEqual(r.json, { deploying: [], queued: [], skipped: ['hk-cust'] });
  assert.match((await c.get('/api/apps/hk-cust/deploy-log')).json.text, /skipped: add credit/);
  await sleep(500); assert.equal(redeploys('hk-cust'), beforeCust); assert.equal(redeploys('hk-a'), beforeOwner);
  setBalance('hook-cust@x.com', 10_000_000_000n);
  const r2 = await hookCall(url, h.secret, push('acme/site')); assert.deepEqual(r2.json.deploying, ['hk-cust']);
  await idle(c, 'hk-cust'); assert.equal(redeploys('hk-cust'), beforeCust + 1); assert.equal(redeploys('hk-a'), beforeOwner);
  const ledger = (await c.get('/api/billing')).json.ledger; assert.ok(ledger.some((l) => l.kind === 'build' && /redeploy hk-cust/.test(l.note)));
  // the owner's push does not touch the customer's app
  const bc = redeploys('hk-cust'); await hookCall(base + new URL(ownerHook.url).pathname, ownerHook.secret, push('acme/site')); await idle(o, 'hk-a');
  assert.equal(redeploys('hk-cust'), bc);
});

test('auto-deploy: rotating the secret cuts off the old one; oversized and repeated bad requests are refused', async () => {
  const o = await owner(); const h = (await o.get('/api/apps/hk-c/hook')).json; const url = base + new URL(h.url).pathname;
  assert.equal((await hookCall(url, h.secret, { zen: 1 }, { event: 'ping' })).status, 200);
  const h2 = (await o.post('/api/apps/hk-c/hook/rotate')).json; assert.notEqual(h2.secret, h.secret); assert.equal(h2.url, h.url);
  assert.equal((await hookCall(url, h.secret, { zen: 1 }, { event: 'ping' })).status, 401);
  assert.equal((await hookCall(url, h2.secret, { zen: 1 }, { event: 'ping' })).status, 200);
  assert.equal((await o.get('/api/apps/hk-c/hook/rotate')).status, 405);
  const big = await fetch(url, { method: 'POST', headers: { 'X-GitHub-Event': 'push', 'X-Hub-Signature-256': hmac(h2.secret, 'x'), 'X-Forwarded-For': '10.7.0.1' }, body: 'x'.repeat(11 * 1024 * 1024) });
  assert.equal(big.status, 413);
  let last; for (let i = 0; i < 7; i++) last = await fetch(url, { method: 'POST', headers: { 'X-GitHub-Event': 'push', 'X-Hub-Signature-256': 'sha256=' + '0'.repeat(64), 'X-Forwarded-For': '10.6.0.1' }, body: '{}' });
  assert.equal(last.status, 429);
  const nonGit = await o.post('/api/deploy', { repo: 'https://gitlab.com/a/b.git', name: 'hk-gl', domain: 'hk-gl.example.net' }); assert.equal(nonGit.status, 202); await waitJob(o, 'hk-gl');
  assert.equal((await o.get('/api/apps/hk-gl/hook')).status, 400);                  // only github.com repos
});
