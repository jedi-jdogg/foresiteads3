import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';

export const ROSTER_PATH = new URL('../agents.json', import.meta.url);

export async function loadRoster(path = ROSTER_PATH, env = process.env) {
  const roster = JSON.parse(await readFile(path, 'utf8'));
  roster.agents = roster.agents.map((a) => resolveAgent(a, env));
  return roster;
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
