// Run: DASH_PASSWORD=pw MCP_TOKEN=tok DASH_DOMAIN=deploy.example.com PORT=3333 node server.js &  then  node test/oauth.test.js
const http = require('http'), crypto = require('crypto'), assert = require('assert');
const P = 3333, B = `http://127.0.0.1:${P}`;
const req = (method, path, { body, headers = {}, form } = {}) => new Promise((res, rej) => {
  const data = form ? new URLSearchParams(form).toString() : body ? JSON.stringify(body) : undefined;
  const r = http.request({ host: '127.0.0.1', port: P, path, method, headers: { ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : body ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (x) => {
    let d = ''; x.on('data', (c) => d += c); x.on('end', () => res({ status: x.statusCode, headers: x.headers, text: d, json: () => JSON.parse(d) }));
  }); r.on('error', rej); if (data) r.write(data); r.end();
});
const rpc = (tok, m) => req('POST', '/mcp', { body: { jsonrpc: '2.0', id: 1, method: m }, headers: { Authorization: 'Bearer ' + tok } });
(async () => {
  let r = await req('POST', '/mcp', { body: {} });
  assert.equal(r.status, 401); assert(/resource_metadata="https:\/\/deploy\.example\.com\/\.well-known\/oauth-protected-resource"/.test(r.headers['www-authenticate']), 'WWW-Authenticate');
  r = await req('GET', '/.well-known/oauth-protected-resource'); assert.equal(r.json().authorization_servers[0], 'https://deploy.example.com');
  r = await req('GET', '/.well-known/oauth-authorization-server'); assert.equal(r.json().code_challenge_methods_supported[0], 'S256');
  // registration: bad redirect rejected, claude callback accepted
  r = await req('POST', '/oauth/register', { body: { redirect_uris: ['https://evil.example/cb'] } }); assert.equal(r.status, 400);
  r = await req('POST', '/oauth/register', { body: { redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], client_name: 'Claude' } }); assert.equal(r.status, 201);
  const cid = r.json().client_id, redirect = 'https://claude.ai/api/mcp/auth_callback';
  const verifier = crypto.randomBytes(32).toString('base64url'), challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const q = { response_type: 'code', client_id: cid, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz' };
  r = await req('GET', '/oauth/authorize?' + new URLSearchParams(q)); assert.equal(r.status, 200); assert(r.text.includes('Dashboard password'));
  r = await req('GET', '/oauth/authorize?' + new URLSearchParams({ ...q, redirect_uri: 'https://evil.example/cb' })); assert.equal(r.status, 400);
  r = await req('GET', '/oauth/authorize?' + new URLSearchParams({ ...q, code_challenge_method: 'plain' })); assert.equal(r.status, 400);
  r = await req('POST', '/oauth/authorize', { form: { ...q, password: 'wrong' } }); assert.equal(r.status, 401);
  r = await req('POST', '/oauth/authorize', { form: { ...q, password: 'pw' } }); assert.equal(r.status, 302);
  const loc = new URL(r.headers.location); assert.equal(loc.origin + loc.pathname, redirect); assert.equal(loc.searchParams.get('state'), 'xyz');
  const code = loc.searchParams.get('code');
  // wrong verifier fails, wrong redirect fails, then success once, then replay fails
  r = await req('POST', '/oauth/token', { form: { grant_type: 'authorization_code', code, client_id: cid, redirect_uri: redirect, code_verifier: crypto.randomBytes(32).toString('base64url') } }); assert.equal(r.status, 400);
  r = await req('POST', '/oauth/token', { form: { grant_type: 'authorization_code', code, client_id: cid, redirect_uri: 'https://claude.com/x', code_verifier: verifier } }); assert.equal(r.status, 400);
  r = await req('POST', '/oauth/token', { form: { grant_type: 'authorization_code', code, client_id: cid, redirect_uri: redirect, code_verifier: verifier } }); assert.equal(r.status, 200);
  const tok = r.json(); assert(tok.access_token && tok.refresh_token);
  r = await req('POST', '/oauth/token', { form: { grant_type: 'authorization_code', code, client_id: cid, redirect_uri: redirect, code_verifier: verifier } }); assert.equal(r.status, 400, 'replay');
  // access token works on MCP; garbage and refresh token do not; static token still works
  r = await rpc(tok.access_token, 'tools/list'); assert.equal(r.status, 200); assert(r.json().result.tools.length >= 8);
  assert.equal((await rpc(tok.refresh_token, 'tools/list')).status, 401);
  assert.equal((await rpc(tok.access_token + 'x', 'tools/list')).status, 401);
  assert.equal((await rpc('tok', 'tools/list')).status, 200);
  r = await req('POST', '/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: cid } }); assert.equal(r.status, 200);
  assert.equal((await rpc(r.json().access_token, 'tools/list')).status, 200);
  console.log('all oauth checks passed');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
