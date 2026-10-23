// Vercel-compatible runtime for Vyre: serves a built site folder and runs its api/*.js functions.
// Supports what Vercel projects commonly use from vercel.json: cleanUrls, trailingSlash, redirects, rewrites, headers, crons.
// Zero dependencies. The site folder is /site (override with SITE_ROOT); the port is PORT (default 3000).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(process.env.SITE_ROOT || '/site');
const PORT = Number(process.env.PORT) || 3000;
const BODY_LIMIT = 4.5 * 1024 * 1024; // same request limit as Vercel functions

let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8')); } catch {}
const cleanUrls = !!cfg.cleanUrls;
const trailingSlash = cfg.trailingSlash; // true, false or undefined

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.pdf': 'application/pdf', '.map': 'application/json' };

// ---- vercel.json route patterns: "/:name", "/:name(regex)", "/:name*", "/(.*)" ----
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function compile(source) {
  let re = '^', i = 0; const names = [];
  while (i < source.length) {
    const c = source[i];
    if (c === ':') {
      const m = /^:([A-Za-z_][A-Za-z0-9_]*)/.exec(source.slice(i));
      if (m) {
        i += m[0].length;
        let body = '[^/]+';
        if (source[i] === '(') { const e = closing(source, i); body = source.slice(i + 1, e); i = e + 1; }
        if (source[i] === '*') { body = body === '[^/]+' ? '.*' : body; i++; }
        else if (source[i] === '+') { body = body === '[^/]+' ? '.+' : body; i++; }
        else if (source[i] === '?') { re += `(?:/(${body}))?`; names.push(m[1]); i++; continue; }
        re += `(${body})`; names.push(m[1]); continue;
      }
    }
    if (c === '(') { const e = closing(source, i); re += `(${source.slice(i + 1, e)})`; names.push(null); i = e + 1; continue; }
    re += reEsc(c); i++;
  }
  return { re: new RegExp(re + '$'), names };
}
function closing(s, open) { let d = 0; for (let j = open; j < s.length; j++) { if (s[j] === '\\') { j++; continue; } if (s[j] === '(') d++; else if (s[j] === ')' && --d === 0) return j; } return s.length - 1; }
const compiled = new Map();
function match(source, pathname) {
  if (!compiled.has(source)) compiled.set(source, compile(source));
  const { re, names } = compiled.get(source);
  const m = re.exec(pathname) || (pathname.length > 1 && pathname.endsWith('/') ? re.exec(pathname.slice(0, -1)) : null); if (!m) return null;
  const params = { positional: m.slice(1) }; names.forEach((n, k) => { if (n) params[n] = m[k + 1] || ''; });
  return params;
}
function fill(template, params) {
  return template.replace(/\$(\d+)/g, (_, n) => params.positional[Number(n) - 1] || '').replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (all, n) => (n in params ? params[n] : all));
}
function hasOk(rule, req) {
  return (rule.has || []).every((h) => {
    if (h.type === 'host') return h.value === undefined ? true : (req.headers.host || '').split(':')[0] === h.value;
    if (h.type === 'header') return h.value === undefined ? !!req.headers[h.key.toLowerCase()] : req.headers[h.key.toLowerCase()] === h.value;
    return false;
  });
}

// ---- cron: 5 fields, UTC ----
function fieldMatch(spec, value, min, max) {
  return spec.split(',').some((part) => {
    const [range, step] = part.split('/'); const s = step ? Number(step) : 1;
    let lo = min, hi = max;
    if (range !== '*') { const [a, b] = range.split('-'); lo = Number(a); hi = b === undefined ? (step ? max : lo) : Number(b); }
    return value >= lo && value <= hi && (value - lo) % s === 0;
  });
}
function cronDue(expr, d) {
  const f = expr.trim().split(/\s+/); if (f.length !== 5) return false;
  const dow = d.getUTCDay();
  return fieldMatch(f[0], d.getUTCMinutes(), 0, 59) && fieldMatch(f[1], d.getUTCHours(), 0, 23) && fieldMatch(f[2], d.getUTCDate(), 1, 31)
    && fieldMatch(f[3], d.getUTCMonth() + 1, 1, 12) && (fieldMatch(f[4], dow, 0, 6) || (dow === 0 && fieldMatch(f[4], 7, 0, 7)));
}

// ---- helpers ----
function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, ...extra }); res.end(body);
}
function applyHeaders(req, res, pathname) {
  for (const rule of cfg.headers || []) {
    if (match(rule.source, pathname)) for (const h of rule.headers || []) res.setHeader(h.key, h.value);
  }
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0, big = false;
    req.on('data', (c) => { n += c.length; if (n > BODY_LIMIT) big = true; else if (!big) chunks.push(c); }); // keep reading but discard, so the client gets a clean 413
    req.on('end', () => (big ? reject(Object.assign(new Error('Payload too large'), { status: 413 })) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}
function parseBody(req, buf) {
  if (!buf.length) return undefined;
  const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type === 'application/json') { try { return JSON.parse(buf.toString('utf8')); } catch { throw Object.assign(new Error('Invalid JSON body'), { status: 400 }); } }
  if (type === 'application/x-www-form-urlencoded') return Object.fromEntries(new URLSearchParams(buf.toString('utf8')));
  if (type.startsWith('text/')) return buf.toString('utf8');
  return buf;
}
function decorate(res) {
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { if (!res.hasHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(o)); return res; };
  res.send = (b) => {
    if (b !== null && typeof b === 'object' && !Buffer.isBuffer(b)) return res.json(b);
    if (!res.hasHeader('Content-Type')) res.setHeader('Content-Type', Buffer.isBuffer(b) ? 'application/octet-stream' : 'text/html; charset=utf-8');
    res.end(b); return res;
  };
  res.redirect = (a, b) => { const [code, url] = typeof a === 'number' ? [a, b] : [307, a]; res.statusCode = code; res.setHeader('Location', url); res.end(); return res; };
}

// ---- api functions ----
const modules = new Map();
function findApiFile(rel) { // rel like "lead" or "x/y"; supports [param] folders/files
  const parts = rel.split('/').filter(Boolean), params = {};
  if (!parts.length || parts.some((p) => p.startsWith('_') || p.startsWith('.'))) return null;
  let dir = path.join(ROOT, 'api');
  for (let k = 0; k < parts.length; k++) {
    const last = k === parts.length - 1, p = parts[k];
    const entries = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : [];
    const has = (name) => entries.find((e) => e.name === name);
    if (last) {
      if (has(p + '.js')) return { file: path.join(dir, p + '.js'), params };
      if (has(p)?.isDirectory() && fs.existsSync(path.join(dir, p, 'index.js'))) return { file: path.join(dir, p, 'index.js'), params };
      const dyn = entries.find((e) => e.isFile() && /^\[[^\]]+\]\.js$/.test(e.name));
      if (dyn) { params[dyn.name.slice(1, -4)] = p; return { file: path.join(dir, dyn.name), params }; }
      return null;
    }
    if (has(p)?.isDirectory()) { dir = path.join(dir, p); continue; }
    const dd = entries.find((e) => e.isDirectory() && /^\[[^\]]+\]$/.test(e.name));
    if (!dd) return null;
    params[dd.name.slice(1, -1)] = p; dir = path.join(dir, dd.name);
  }
  return null;
}
async function runApi(req, res, url) {
  const found = findApiFile(decodeURIComponent(url.pathname).replace(/^\/api\//, '').replace(/\/$/, ''));
  if (!found) return false;
  let mod = modules.get(found.file);
  if (!mod) { mod = await import(pathToFileURL(found.file).href); modules.set(found.file, mod); }
  const handler = typeof mod.default === 'function' ? mod.default : (typeof mod === 'function' ? mod : null);
  if (!handler) return false;
  const query = { ...found.params };
  for (const [k, v] of url.searchParams) query[k] = k in query ? [].concat(query[k], v) : v;
  req.query = query;
  req.cookies = Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim()).filter(Boolean).map((c) => { const e = c.indexOf('='); return [c.slice(0, e), decodeURIComponent(c.slice(e + 1))]; }));
  try { req.body = parseBody(req, await readBody(req)); } catch (e) { send(res, e.status || 400, JSON.stringify({ error: e.message }), 'application/json'); return true; }
  decorate(res);
  try { await handler(req, res); } catch (e) {
    console.error('api error', url.pathname, e);
    if (!res.headersSent) send(res, 500, JSON.stringify({ error: 'Internal Server Error' }), 'application/json'); else res.end();
  }
  return true;
}

// ---- static files ----
const BLOCKED = /(^|\/)(\.|node_modules(\/|$)|package(-lock)?\.json$|vercel\.json$)/;
function isFile(f) { try { return fs.statSync(f).isFile(); } catch { return false; } }
function resolveStatic(pathname) {
  let rel; try { rel = decodeURIComponent(pathname); } catch { return null; }
  if (rel.includes('\0') || BLOCKED.test(rel) || rel.startsWith('/api/') || rel === '/api') return null;
  const base = path.normalize(path.join(ROOT, rel));
  if (base !== ROOT && !base.startsWith(ROOT + path.sep)) return null;
  const tries = rel.endsWith('/') ? [path.join(base, 'index.html'), base.replace(/[\\/]$/, '') + '.html'] : [base, base + '.html', path.join(base, 'index.html')];
  return tries.find(isFile) || null;
}
function serveFile(req, res, file, status = 200) {
  const st = fs.statSync(file), etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  if (status === 200 && req.headers['if-none-match'] === etag) { res.writeHead(304); return res.end(); }
  res.writeHead(status, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, ETag: etag, ...(res.getHeader('Cache-Control') ? {} : { 'Cache-Control': 'public, max-age=0, must-revalidate' }) });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  let pathname = url.pathname;
  applyHeaders(req, res, pathname);

  for (const r of cfg.redirects || []) {
    const p = hasOk(r, req) && match(r.source, pathname); if (!p) continue;
    let dest = fill(r.destination, p);
    if (url.search && !dest.includes('?')) dest += url.search;
    return send(res, r.statusCode || (r.permanent ? 308 : 307), '', 'text/plain', { Location: dest });
  }
  if (pathname.startsWith('/api/') || pathname === '/api') { if (await runApi(req, res, url)) return; return send(res, 404, JSON.stringify({ error: 'Not found' }), 'application/json'); }

  const hasExt = path.extname(pathname) !== '';
  if (trailingSlash === true && !pathname.endsWith('/') && !hasExt) return send(res, 308, '', 'text/plain', { Location: pathname + '/' + url.search });
  if (trailingSlash === false && pathname.length > 1 && pathname.endsWith('/')) return send(res, 308, '', 'text/plain', { Location: pathname.slice(0, -1) + url.search });
  if (cleanUrls && pathname.endsWith('.html') && resolveStatic(pathname)) {
    const clean = pathname.replace(/(\/index)?\.html$/, '') || '/';
    return send(res, 308, '', 'text/plain', { Location: (trailingSlash === true && clean !== '/' ? clean + '/' : clean) + url.search });
  }

  let file = resolveStatic(pathname);
  if (!file) for (const r of cfg.rewrites || []) {
    const p = hasOk(r, req) && match(r.source, pathname); if (!p) continue;
    const dest = fill(r.destination, p).split('?')[0];
    if (dest.startsWith('/api/')) { url.pathname = dest; if (await runApi(req, res, url)) return; }
    file = resolveStatic(dest); if (file) break;
  }
  if (file) return serveFile(req, res, file);
  const nf = path.join(ROOT, '404.html');
  if (isFile(nf)) return serveFile(req, res, nf, 404);
  send(res, 404, 'Not found');
}

module.exports = { cronDue, match, fill };
if (require.main !== module) return;

const server = http.createServer((req, res) => { handle(req, res).catch((e) => { console.error(e); if (!res.headersSent) send(res, 500, 'Server error'); else res.end(); }); });
server.listen(PORT, () => console.log(`vercel-compat runtime: ${ROOT} on :${PORT}`));

// crons (UTC), called through the server itself so they behave like real requests
const crons = (cfg.crons || []).filter((c) => c && typeof c.path === 'string' && c.path.startsWith('/'));
if (crons.length) {
  let last = -1;
  setInterval(() => {
    const now = new Date(), minute = Math.floor(now.getTime() / 60000);
    if (minute === last) return; last = minute;
    for (const c of crons) if (cronDue(c.schedule, now)) {
      const headers = { 'user-agent': 'vercel-cron/1.0' }; if (process.env.CRON_SECRET) headers.authorization = `Bearer ${process.env.CRON_SECRET}`;
      http.get({ host: '127.0.0.1', port: PORT, path: c.path, headers }, (r) => { r.resume(); console.log('cron', c.path, r.statusCode); }).on('error', (e) => console.error('cron failed', c.path, e.message));
    }
  }, 15000);
}
