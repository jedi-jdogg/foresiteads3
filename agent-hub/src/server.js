import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
import { publicAgent, saveEnv } from './registry.js';
import { randomBytes } from 'node:crypto';

const oauthStates = new Map();

const PAGE = new URL('../public/index.html', import.meta.url);

// The page carries a snapshot of the roster and playbook so it can also run as a stand-alone preview.
export function snapshotFor(hub) {
  return { agents: hub.agents.map(publicAgent), machines: hub.roster.machines, connectors: hub.roster.connectors, playbook: hub.playbook };
}
export async function renderPage(hub) {
  const html = await readFile(PAGE, 'utf8');
  const json = JSON.stringify(snapshotFor(hub)).replace(/</g, '\\u003c');
  return html.replace(/\/\*__SNAPSHOT__\*\/.*?\/\*__END__\*\//s, `/*__SNAPSHOT__*/${json}/*__END__*/`);
}
const MAX_BODY = 1_000_000;

export function startServer(hub, { host = '127.0.0.1', port = 4747 } = {}) {
  const server = createServer(async (req, res) => {
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    try {
      const url = new URL(req.url, 'http://hub');
      if (req.method === 'GET' && url.pathname === '/') return send(200, await renderPage(hub), 'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/api/roster') {
        return send(200, { agents: hub.agents.map(publicAgent), connectors: hub.roster.connectors, whenUnsure: hub.whenUnsure });
      }
      if (req.method === 'GET' && url.pathname === '/api/machines') return send(200, await hub.machines.overview());
      if (req.method === 'POST' && url.pathname === '/api/machines/register') return send(200, await hub.machines.register(await readJson(req)));
      if (req.method === 'POST' && url.pathname === '/api/machines/remove') { await hub.machines.remove((await readJson(req)).id); return send(200, { ok: true }); }
      if (req.method === 'POST' && url.pathname === '/api/machines/status') return send(200, await hub.machines.status((await readJson(req)).id));
      if (req.method === 'POST' && url.pathname === '/api/machines/run') {
        const { id, action, args } = await readJson(req);
        return send(200, await hub.machines.runAction(id, action, args ?? {}));
      }
      if (req.method === 'GET' && url.pathname === '/api/machines/jobs') return send(200, hub.machines.recentJobs());
      if (req.method === 'GET' && url.pathname === '/api/machines/job') return send(200, hub.machines.job(url.searchParams.get('id')));
      if (req.method === 'GET' && url.pathname === '/api/machines/actions') return send(200, await hub.machines.actions());
      if (req.method === 'GET' && url.pathname === '/api/machines/setup') {
        const pubkey = await hub.machines.ensureKey();
        const ts = await hub.machines.tailscale();
        const script = await hub.machines.setupScript({ hubHost: ts.self?.host, pubkey, hubUser: process.env.USER });
        return send(200, script, 'text/plain; charset=utf-8');
      }
      if (req.method === 'POST' && url.pathname === '/api/route') {
        const { prompt, smart } = await readJson(req);
        return send(200, smart ? await hub.smartRoute(prompt) : hub.route(prompt));
      }
      if (req.method === 'POST' && url.pathname === '/api/ask') {
        const { prompt, mode, agentId, agents, history, whenUnsure } = await readJson(req);
        if (!prompt?.trim()) return send(400, { error: 'Empty prompt.' });
        return send(200, await hub.ask(prompt, { mode, agentId, agents, history, whenUnsure }));
      }
      if (req.method === 'GET' && url.pathname === '/api/playbook') return send(200, hub.playbook);
      if (req.method === 'GET' && url.pathname === '/api/version') return send(200, await version());
      if (req.method === 'GET' && url.pathname === '/api/scorecard') return send(200, await hub.scorecard());
      if (req.method === 'GET' && url.pathname === '/api/log') return send(200, await hub.recent());
      if (req.method === 'POST' && url.pathname === '/api/connect') {
        const { agentId, apiKey, baseURL, model, effort } = await readJson(req);
        const result = await hub.connect(agentId, { apiKey, baseURL, model, effort });
        return send(200, { ...result, agent: publicAgent(hub.agent(agentId)) });
      }
      if (req.method === 'POST' && url.pathname === '/api/test') {
        const { agentId } = await readJson(req);
        return send(200, await hub.test(agentId));
      }
      if (req.method === 'GET' && url.pathname === '/api/models') return send(200, await hub.listModels(url.searchParams.get('agent')));
      if (req.method === 'GET' && url.pathname === '/api/sources') return send(200, hub.publicSources());
      if (req.method === 'POST' && url.pathname === '/api/sources/connect') {
        const { id, values } = await readJson(req);
        const result = await hub.connectSource(id, values);
        return send(200, { ...result, source: hub.publicSources().find((s) => s.id === id) });
      }
      if (req.method === 'POST' && url.pathname === '/api/sources/test') {
        const { id } = await readJson(req);
        return send(200, await hub.sources.test(id));
      }
      // Google OAuth: start sends the browser to Google; callback stores the refresh token and returns to Connect.
      if (req.method === 'GET' && url.pathname === '/api/oauth/google/start') {
        const src = hub.sources.get('google');
        if (!src.creds.GOOGLE_CLIENT_ID || !src.creds.GOOGLE_CLIENT_SECRET) return send(400, { error: 'Save the Google client ID and secret first.' });
        const { authUrl } = await import('./sources/google.js');
        const state = randomBytes(16).toString('hex');
        oauthStates.set(state, Date.now());
        res.writeHead(302, { location: authUrl(src.creds, redirectUri(req, port), state) });
        return res.end();
      }
      if (req.method === 'GET' && url.pathname === '/api/oauth/google/callback') {
        const state = url.searchParams.get('state');
        if (!state || !oauthStates.has(state)) return send(400, { error: 'Sign-in did not start from this hub. Try Connect again.' });
        oauthStates.delete(state);
        if (url.searchParams.get('error')) return send(400, { error: `Google refused: ${url.searchParams.get('error')}` });
        const src = hub.sources.get('google');
        const { exchangeCode } = await import('./sources/google.js');
        const refresh = await exchangeCode(src.creds, url.searchParams.get('code'), redirectUri(req, port));
        await saveEnv({ GOOGLE_REFRESH_TOKEN: refresh });
        hub.sources.refresh();
        res.writeHead(302, { location: '/#connect' });
        return res.end();
      }
      if (req.method === 'POST' && url.pathname === '/api/feedback') {
        await hub.feedback(await readJson(req));
        return send(200, { ok: true });
      }
      send(404, { error: 'Not found' });
    } catch (err) {
      send(500, { error: err.message });
    }
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

function redirectUri(req, port) {
  return `http://${req.headers.host ?? `localhost:${port}`}/api/oauth/google/callback`;
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY) throw new Error('Request too large.');
  }
  return raw ? JSON.parse(raw) : {};
}

// Which build is running, and whether GitHub has a newer one. Never pulls: the launcher does that on restart.
async function version() {
  const git = (...args) => run('git', ['-C', new URL('..', import.meta.url).pathname, ...args]).then((r) => r.stdout.trim()).catch(() => '');
  const local = await git('rev-parse', '--short', 'HEAD');
  const date = await git('log', '-1', '--format=%cs');
  await git('fetch', '--quiet');
  const behind = Number(await git('rev-list', '--count', 'HEAD..@{u}')) || 0;
  return { local, date, behind };
}
