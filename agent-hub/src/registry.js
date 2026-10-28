import { readFile, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';

export const ROSTER_PATH = new URL('../agents.json', import.meta.url);
export const ENV_PATH = new URL('../.env', import.meta.url);

// Set or replace KEY=value lines in .env (created from scratch if missing) and in process.env.
// Values are written as given; the hub only ever reads them back as environment variables.
export async function saveEnv(updates, path = ENV_PATH, env = process.env) {
  let text = '';
  try { text = await readFile(path, 'utf8'); } catch {}
  const lines = text.replace(/\n+$/, '').split('\n').filter((l, i, arr) => !(i === 0 && l === '' && arr.length === 1));
  for (const [key, value] of Object.entries(updates)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`Refusing to write "${key}" to .env`);
    const clean = String(value ?? '').replace(/[\r\n]/g, '').trim();
    const i = lines.findIndex((l) => l.startsWith(`${key}=`) || l.startsWith(`# ${key}=`));
    if (i >= 0) lines[i] = `${key}=${clean}`; else lines.push(`${key}=${clean}`);
    if (clean) env[key] = clean; else delete env[key];
  }
  await writeFile(path, lines.join('\n').replace(/\n*$/, '\n'));
}
export const PLAYBOOK_PATH = new URL('../playbook.json', import.meta.url);

export async function loadRoster(path = ROSTER_PATH, env = process.env, playbookPath = PLAYBOOK_PATH) {
  const roster = JSON.parse(await readFile(path, 'utf8'));
  roster.agents = roster.agents.map((a) => resolveAgent(a, env));
  roster.playbook = JSON.parse(await readFile(playbookPath, 'utf8'));
  checkPlaybook(roster.playbook, roster.agents);
  const { loadSources } = await import('./sources/registry.js');
  roster.sources = await loadSources();
  return roster;
}

// Catch typos in playbook.json at start-up rather than mid-request.
export function checkPlaybook(playbook, agents) {
  const ids = new Set(agents.map((a) => a.id));
  for (const play of playbook.plays) {
    for (const id of [play.primary, ...(play.backup ?? []), ...(play.council ?? [])]) {
      if (!ids.has(id)) throw new Error(`playbook.json: play "${play.id}" names unknown agent "${id}"`);
    }
    if (play.signals) new RegExp(play.signals, 'gi');
  }
  if (!playbook.plays.some((p) => !p.signals)) throw new Error('playbook.json needs a fallback play with "signals": null');
}

// Fill in model, base URL and key from the environment; an agent without a key is listed but not callable.
export function resolveAgent(agent, env = process.env) {
  const key = agent.keyEnv ? env[agent.keyEnv] : undefined;
  const baseURL = (agent.baseURLEnv && env[agent.baseURLEnv]) || agent.baseURL;
  return {
    ...agent,
    model: (agent.modelEnv && env[agent.modelEnv]) || agent.model,
    baseURL,
    apiKey: key || undefined,
    callable: agent.provider !== 'handoff' && Boolean(key) && (!agent.requiresBaseURL || Boolean(baseURL)),
  };
}

// What the browser and CLI may see: never the key.
export function publicAgent({ apiKey, ...rest }) {
  return { ...rest, configured: Boolean(apiKey), missing: rest.callable ? null : apiKey ? rest.baseURLEnv : rest.keyEnv };
}

// TCP check on the SSH port. Says whether a Mac is reachable, nothing more.
export function checkMachine(machine, { port = 22, timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    const socket = connect({ host: machine.host, port });
    const done = (online) => { socket.destroy(); resolve({ ...machine, online }); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}
