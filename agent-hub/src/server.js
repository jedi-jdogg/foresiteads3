import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
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
        await hub.machines.overview().catch(() => {});
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
        return send(200, smart ? await hub.smartRoute(prompt) : await hub.routeFresh(prompt));
      }
      if (req.method === 'POST' && url.pathname === '/api/ask') {
        const { prompt, mode, agentId, agents, history, whenUnsure, reqId } = await readJson(req);
        if (!prompt?.trim()) return send(400, { error: 'Empty prompt.' });
        return send(200, await hub.ask(prompt, { mode, agentId, agents, history, whenUnsure, reqId }));
      }
      if (req.method === 'GET' && url.pathname === '/api/progress') return send(200, hub.progressOf(url.searchParams.get('id')));
      if (req.method === 'GET' && /^\/images\/[a-z0-9]+\.png$/.test(url.pathname)) {
        const png = await readFile(new URL(`../logs${url.pathname}`, import.meta.url));
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'private, max-age=86400' }); return res.end(png);
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
      if (req.method === 'POST' && url.pathname === '/api/transcribe') {
        const agent = hub.agents.find((a) => a.id === 'openai');
        if (!agent?.callable) { req.resume(); return send(400, { error: 'Voice input uses your OpenAI key. Connect ChatGPT in the Connect tab first.' }); }
        const LIMIT = 24 * 1024 * 1024;
        if (Number(req.headers['content-length'] ?? 0) > LIMIT) { req.resume(); return send(413, { error: 'Recording too long.' }); }
        const chunks = []; let size = 0, tooBig = false;
        for await (const c of req) { if (tooBig) continue; chunks.push(c); size += c.length; if (size > LIMIT) { tooBig = true; chunks.length = 0; } }
        if (tooBig) return send(413, { error: 'Recording too long.' });
        const { transcribe } = await import('./providers/openai-compatible.js');
        const type = req.headers['content-type'] || 'audio/webm';
        const ext = /mp4|m4a/.test(type) ? 'm4a' : /wav/.test(type) ? 'wav' : /ogg/.test(type) ? 'ogg' : /mpeg|mp3/.test(type) ? 'mp3' : /flac/.test(type) ? 'flac' : 'webm';
        return send(200, await transcribe(agent, { bytes: Buffer.concat(chunks), filename: `speech.${ext}`, type }));
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
  const ready = new Promise((resolve) => server.listen(port, host, () => resolve(server)));
  // A second, tiny listener on the Tailscale address serves only the worker setup script, so a new Mac can
  // fetch it with one line (curl … | bash). Nothing else is reachable from the network.
  ready.then(() => hub.machines.tailscale().then((ts) => {
    const ip = ts.self?.ip;
    if (!ip) return;
    hub.machines.port = port;
    const worker = createServer(async (req, res) => {
      // A worker announcing itself at the end of its setup script.
      if (req.method === 'POST' && req.url === '/register') {
        try {
          const body = await readJson(req);
          const peerIp = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
          const peer = (await hub.machines.tailscale()).peers.find((p) => p.ip === peerIp);
          const entry = await hub.machines.register({ host: peer?.host ?? body.host, user: body.user, name: body.name, note: body.note, registeredBy: 'worker' });
          res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, id: entry.id }));
        } catch (err) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: err.message })); }
      }
      if (req.method === 'GET' && (req.url === '/worker' || req.url === '/worker.sh')) {
        try {
          const pubkey = await hub.machines.ensureKey();
          const script = await hub.machines.setupScript({ hubHost: ts.self?.host, pubkey, hubUser: process.env.USER, bare: true });
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); return res.end(script);
        } catch (err) { res.writeHead(500); return res.end(`# ${err.message}\n`); }
      }
      res.writeHead(404); res.end('Agent Hub: only /worker and /register are served on this address.\n');
    });
    worker.on('error', () => {});
    worker.listen(port, ip);
    hub.machines.workerUrl = `http://${(ts.self?.host ?? ip).replace(/\.$/, '')}:${port}/worker`;
  }).catch(() => {}));
  return ready;
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
  const git = (...args) => run('git', ['-C', fileURLToPath(new URL('..', import.meta.url)), ...args]).then((r) => r.stdout.trim()).catch(() => '');
  let local = await git('rev-parse', '--short', 'HEAD');
  const date = await git('log', '-1', '--format=%cs');
  if (!local) local = (await readFile(new URL('../BUILD', import.meta.url), 'utf8').catch(() => '')).trim();   // downloaded copy
  await git('fetch', '--quiet');
  const behind = Number(await git('rev-list', '--count', 'HEAD..@{u}')) || 0;
  return { local, date, behind };
}
