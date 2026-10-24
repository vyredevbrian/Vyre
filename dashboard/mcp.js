// Minimal MCP server (Streamable HTTP, stateless, JSON responses) exposing Vyre to AI clients.
const crypto = require('crypto');

const tools = [
  { name: 'system_status', description: 'Server memory, swap, disk and load.', inputSchema: { type: 'object', properties: {} }, run: (c) => c.sysInfo() },
  { name: 'list_apps', description: 'List deployed apps with domain, branch, port and container status.', inputSchema: { type: 'object', properties: {} }, run: (c) => c.listApps() },
  { name: 'billing_overview', description: 'Read-only: customer accounts and balances, credit sold and owed, payment watcher status and any payments that matched no invoice.', inputSchema: { type: 'object', properties: {} }, run: (c) => c.adminOverview() },
  {
    name: 'deploy_app', description: 'Build and deploy a git repo (https URL) to a domain. Runs in the background; poll get_deploy_log. Redeploying an existing name replaces it.',
    inputSchema: { type: 'object', required: ['repo', 'name', 'domain'], properties: { repo: { type: 'string' }, name: { type: 'string' }, domain: { type: 'string' }, port: { type: 'number' }, branch: { type: 'string' }, root: { type: 'string', description: 'Folder inside the repo to serve, e.g. dist/spring' } } },
    run: async (c, a) => {
      const d = c.deployArgs(a); if (d.error) throw new Error(d.error);
      if (!c.startJob(d.name, d.args)) throw new Error('Already deploying');
      return { started: d.name };
    },
  },
  {
    name: 'redeploy_app', description: 'Pull the latest code for an existing app and redeploy. Runs in the background.',
    inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
    run: async (c, a) => { app(c, a.name); if (!c.startJob(a.name, ['redeploy', a.name])) throw new Error('Already deploying'); return { started: a.name }; },
  },
  {
    name: 'get_deploy_log', description: 'Output of the most recent deploy for an app, and whether it is still running.',
    inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
    run: async (c, a) => { app(c, a.name); const j = c.deployLogs.get(a.name); return { running: !!(j && j.running), ok: j ? j.ok : null, text: j ? j.text : '' }; },
  },
  {
    name: 'get_app_logs', description: 'Last 300 lines of runtime logs from an app container.',
    inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
    run: async (c, a) => { app(c, a.name); return (await c.run('docker', ['logs', '--tail', '300', `vyre-${a.name}`])).out; },
  },
  {
    name: 'list_env_keys', description: 'Names (never values) of env vars set for an app.',
    inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
    run: async (c, a) => { app(c, a.name); return c.readEnvKeys(a.name); },
  },
  {
    name: 'set_env', description: 'Set env vars for an app. vars is one KEY=VALUE per line. Takes effect after redeploy_app.',
    inputSchema: { type: 'object', required: ['name', 'vars'], properties: { name: { type: 'string' }, vars: { type: 'string' } } },
    run: async (c, a) => { app(c, a.name); const e = await c.setEnv(a.name, a.vars); if (e) throw new Error(e); return { saved: true }; },
  },
  {
    name: 'delete_app', description: 'DESTRUCTIVE: remove an app, its container and source. Requires confirm equal to the app name.',
    inputSchema: { type: 'object', required: ['name', 'confirm'], properties: { name: { type: 'string' }, confirm: { type: 'string' } } },
    run: async (c, a) => {
      app(c, a.name); if (a.confirm !== a.name) throw new Error('confirm must equal the app name');
      const r = await c.run('bash', [c.VYRE, 'rm', a.name]); c.deployLogs.delete(a.name); if (!r.ok) throw new Error('Delete failed'); return { deleted: a.name };
    },
  },
];

function app(c, name) {
  if (typeof name !== 'string' || !c.NAME_RE.test(name) || !c.meta(name)) throw new Error('Unknown app');
}

module.exports = (core, token, oauth) => {
  const eq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  const reply = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
  const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
  const err = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  async function rpc(msg) {
    const { id, method, params = {} } = msg;
    if (id === undefined) return null; // notification
    if (method === 'initialize') return ok(id, { protocolVersion: params.protocolVersion || '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'vyre', version: '0.1.0' } });
    if (method === 'ping') return ok(id, {});
    if (method === 'tools/list') return ok(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    if (method === 'tools/call') {
      const t = tools.find((x) => x.name === params.name);
      if (!t) return err(id, -32602, 'Unknown tool');
      try {
        const out = await t.run(core, params.arguments || {});
        return ok(id, { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }] });
      } catch (e) { return ok(id, { isError: true, content: [{ type: 'text', text: e.message }] }); }
    }
    return err(id, -32601, 'Method not found');
  }

  return {
    async handle(req, res, readBody) {
      if (!token) return reply(res, 404, { error: 'MCP disabled' });
      const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
      if (!m || !(eq(m[1], token) || (oauth && oauth.verifyAccess(m[1])))) {
        const hdr = oauth ? { 'WWW-Authenticate': `Bearer resource_metadata="${oauth.resourceMetadataUrl(req)}"` } : {};
        res.writeHead(401, { 'Content-Type': 'application/json', ...hdr }); return res.end(JSON.stringify({ error: 'Unauthorized' }));
      }
      if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); return res.end(); }
      let body; try { body = await readBody(req); } catch { return reply(res, 400, err(null, -32700, 'Parse error')); }
      const batch = Array.isArray(body);
      const results = (await Promise.all((batch ? body : [body]).map(rpc))).filter(Boolean);
      if (!results.length) { res.writeHead(202); return res.end(); }
      reply(res, 200, batch ? results : results[0]);
    },
  };
};
