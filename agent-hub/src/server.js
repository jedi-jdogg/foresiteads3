import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
import { publicAgent, checkMachine } from './registry.js';

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
        return send(200, { agents: hub.agents.map(publicAgent), machines: hub.roster.machines, connectors: hub.roster.connectors, whenUnsure: hub.whenUnsure });
      }
      if (req.method === 'GET' && url.pathname === '/api/machines') {
        return send(200, await Promise.all((hub.roster.machines ?? []).map((m) => checkMachine(m))));
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
        const { agentId, apiKey, baseURL, model } = await readJson(req);
        const result = await hub.connect(agentId, { apiKey, baseURL, model });
        return send(200, { ...result, agent: publicAgent(hub.agent(agentId)) });
      }
      if (req.method === 'POST' && url.pathname === '/api/test') {
        const { agentId } = await readJson(req);
        return send(200, await hub.test(agentId));
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
