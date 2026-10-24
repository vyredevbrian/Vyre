// Minimal OAuth 2.1 authorization server for the MCP endpoint (what Claude's "custom connector" expects):
// discovery metadata, dynamic client registration, authorization code + PKCE (S256), refresh tokens.
// Stateless: clients, codes and tokens are HMAC-signed, so nothing is stored. The consent step asks for the dashboard password.
const crypto = require('crypto');

const b64u = (s) => Buffer.from(s).toString('base64url');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function allowedRedirect(u, extra = []) {
  if (extra.includes(u)) return true; // exact addresses the owner added for other AI apps (OAUTH_EXTRA_REDIRECTS)
  try {
    const x = new URL(u);
    if (x.hash) return false;
    if (x.protocol === 'https:') return x.hostname === 'claude.ai' || x.hostname === 'claude.com';
    if (x.protocol === 'http:') return x.hostname === 'localhost' || x.hostname === '127.0.0.1';
    return false;
  } catch { return false; }
}

module.exports = ({ secret, baseUrl, tryPassword, extraRedirects = [] }) => {
  const key = crypto.createHash('sha256').update('oauth:' + secret).digest();
  const sign = (s) => crypto.createHmac('sha256', key).update(s).digest('base64url');
  const pack = (o) => { const p = b64u(JSON.stringify(o)); return p + '.' + sign(p); };
  function unpack(tok, type) {
    if (typeof tok !== 'string') return null;
    const [p, sig] = tok.split('.');
    if (!p || !sig) return null;
    const a = Buffer.from(sig), b = Buffer.from(sign(p));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
      const o = JSON.parse(Buffer.from(p, 'base64url').toString());
      return o.t === type && (!o.exp || o.exp > Date.now()) ? o : null;
    } catch { return null; }
  }

  const usedCodes = new Map(); // code -> expiry, so a code works once
  const base = (req) => baseUrl || `https://${req.headers.host}`;
  const json = (res, code, body, extra = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra }); res.end(JSON.stringify(body)); };
  const readForm = (req) => new Promise((resolve, reject) => {
    let d = ''; req.on('data', (c) => { d += c; if (d.length > 50_000) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => {
      try {
        if ((req.headers['content-type'] || '').includes('json')) return resolve(JSON.parse(d || '{}'));
        resolve(Object.fromEntries(new URLSearchParams(d)));
      } catch (e) { reject(e); }
    });
  });

  function checkAuthRequest(p) {
    const client = unpack(p.client_id, 'client');
    if (!client) return 'Unknown client';
    if (!client.r.includes(p.redirect_uri)) return 'Redirect address not registered';
    if (p.response_type !== 'code') return 'Unsupported response type';
    if (p.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(p.code_challenge || '')) return 'PKCE (S256) is required';
    return null;
  }

  function page(res, p, error, code = 200) {
    const hidden = ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'state']
      .map((k) => `<input type="hidden" name="${k}" value="${esc(p[k] || '')}">`).join('');
    res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; font-src 'self'" });
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vyre Deploy: connect</title>
<link rel="stylesheet" href="/assets/fonts.css"><link rel="icon" href="/assets/favicon-32.png">
<style>*{box-sizing:border-box}body{margin:0;background:#060606;color:#f4f5f0;font:16px/1.5 Archivo,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;padding:20px}
.c{width:100%;max-width:420px}img{height:33px;margin-bottom:26px}p.e{font-size:11.5px;letter-spacing:.4em;text-transform:uppercase;color:#d3d6cb;margin:0 0 10px}
h1{margin:0 0 12px;font-weight:900;font-stretch:125%;text-transform:uppercase;font-size:30px;line-height:1}h1 em{font-style:normal;color:#cdf714}
.card{background:#0c0c0e;border:1px solid #1d1f1b;border-radius:12px;padding:18px}p{color:#d3d6cb;margin:0 0 14px}
input[type=password]{width:100%;height:46px;padding:0 14px;border:1px solid #2b2e27;border-radius:9px;background:#060606;color:#f4f5f0;font:inherit}
input[type=password]:focus{outline:none;border-color:#cdf714}button{margin-top:12px;width:100%;height:46px;border:0;border-radius:9px;background:#cdf714;color:#0a0a0a;font:800 13px Archivo,sans-serif;letter-spacing:.1em;text-transform:uppercase;cursor:pointer}
.err{color:#ff6b6b;margin:10px 0 0}</style>
<div class="c"><img src="/assets/logo.png" alt="VYRE"><p class="e">Vyre Deploy</p><h1>Allow <em>access</em></h1>
<div class="card"><p>An app is asking to manage your server: list apps, read logs, deploy and delete. Sign in with your dashboard password to allow it.</p>
<form method="post" action="/oauth/authorize">${hidden}<input type="password" name="password" placeholder="Dashboard password" autocomplete="current-password" autofocus required>
${error ? `<p class="err">${esc(error)}</p>` : ''}<button>Allow</button></form></div></div>`);
  }

  function issue(clientId) {
    const now = Date.now();
    return {
      access_token: pack({ t: 'access', c: clientId, exp: now + 8 * 3600e3 }),
      token_type: 'Bearer', expires_in: 8 * 3600,
      refresh_token: pack({ t: 'refresh', c: clientId, exp: now + 30 * 86400e3 }),
    };
  }

  return {
    verifyAccess: (tok) => !!unpack(tok, 'access'),
    resourceMetadataUrl: (req) => `${base(req)}/.well-known/oauth-protected-resource`,

    // Returns true when it handled the request.
    async handle(req, res, url) {
      const path = url.pathname;
      if (path.startsWith('/.well-known/oauth-protected-resource')) {
        json(res, 200, { resource: `${base(req)}/mcp`, authorization_servers: [base(req)], bearer_methods_supported: ['header'] }); return true;
      }
      if (path.startsWith('/.well-known/oauth-authorization-server')) {
        const b = base(req);
        json(res, 200, { issuer: b, authorization_endpoint: `${b}/oauth/authorize`, token_endpoint: `${b}/oauth/token`, registration_endpoint: `${b}/oauth/register`,
          response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] }); return true;
      }
      if (path === '/oauth/register' && req.method === 'POST') {
        let b; try { b = await readForm(req); } catch { json(res, 400, { error: 'invalid_client_metadata' }); return true; }
        const uris = b.redirect_uris;
        if (!Array.isArray(uris) || !uris.length || uris.length > 5 || !uris.every((u) => typeof u === 'string' && allowedRedirect(u, extraRedirects))) {
          json(res, 400, { error: 'invalid_redirect_uri', error_description: 'Only Claude and localhost callbacks are allowed' }); return true;
        }
        json(res, 201, { client_id: pack({ t: 'client', r: uris }), client_id_issued_at: Math.floor(Date.now() / 1000), redirect_uris: uris,
          client_name: String(b.client_name || 'MCP client').slice(0, 80), grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }); return true;
      }
      if (path === '/oauth/authorize') {
        if (req.method === 'GET') {
          const p = Object.fromEntries(url.searchParams); const err = checkAuthRequest(p);
          if (err) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end(err); } else page(res, p);
          return true;
        }
        if (req.method === 'POST') {
          let p; try { p = await readForm(req); } catch { res.writeHead(400); res.end(); return true; }
          const err = checkAuthRequest(p);
          if (err) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end(err); return true; }
          const r = tryPassword(p.password);
          if (r === 'locked') { page(res, p, 'Too many attempts, wait a minute', 429); return true; }
          if (r !== 'ok') { page(res, p, 'Wrong password', 401); return true; }
          const code = pack({ t: 'code', c: p.client_id, u: p.redirect_uri, h: p.code_challenge, n: crypto.randomBytes(8).toString('hex'), exp: Date.now() + 60_000 });
          const to = new URL(p.redirect_uri); to.searchParams.set('code', code); if (p.state) to.searchParams.set('state', p.state);
          res.writeHead(302, { Location: to.toString(), 'Cache-Control': 'no-store' }); res.end(); return true;
        }
      }
      if (path === '/oauth/token' && req.method === 'POST') {
        let p; try { p = await readForm(req); } catch { json(res, 400, { error: 'invalid_request' }); return true; }
        for (const [k, t] of usedCodes) if (t < Date.now()) usedCodes.delete(k);
        if (p.grant_type === 'authorization_code') {
          const c = unpack(p.code, 'code');
          const v = typeof p.code_verifier === 'string' ? p.code_verifier : '';
          const ok = c && !usedCodes.has(p.code) && c.c === p.client_id && c.u === p.redirect_uri && /^[A-Za-z0-9._~-]{43,128}$/.test(v)
            && crypto.createHash('sha256').update(v).digest('base64url') === c.h;
          if (!ok) { json(res, 400, { error: 'invalid_grant' }); return true; }
          usedCodes.set(p.code, c.exp);
          json(res, 200, issue(c.c)); return true;
        }
        if (p.grant_type === 'refresh_token') {
          const r = unpack(p.refresh_token, 'refresh');
          if (!r || (p.client_id && p.client_id !== r.c)) { json(res, 400, { error: 'invalid_grant' }); return true; }
          json(res, 200, issue(r.c)); return true;
        }
        json(res, 400, { error: 'unsupported_grant_type' }); return true;
      }
      return false;
    },
  };
};
