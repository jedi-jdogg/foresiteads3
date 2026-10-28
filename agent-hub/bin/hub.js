#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { loadRoster, checkMachine } from '../src/registry.js';
import { Hub } from '../src/hub.js';

// Pick up keys from agent-hub/.env when present, without overriding variables already set.
const envFile = new URL('../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    agent: { type: 'string', short: 'a' },
    council: { type: 'boolean', short: 'c' },
    smart: { type: 'boolean', short: 's' },
    port: { type: 'string' },
    host: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

const [cmd, ...rest] = positionals;
const prompt = rest.join(' ');
if (values.help || !cmd) {
  console.log(`Foresite agent hub

  agent-hub serve [--port 4747 --host 127.0.0.1]   Open the web console
  agent-hub agents                                  Roster, and which agents have keys
  agent-hub machines                                Which Macs answer on SSH
  agent-hub route "<request>" [--smart]             Show who would get it and why (no API call unless --smart)
  agent-hub ask "<request>"                         Route and answer
          [--agent claude|openai|grok|perplexity|meta]   ...or send to one agent
          [--council]                                    ...or ask several and merge
          [--smart]                                      ...let Claude do the routing
`);
  process.exit(0);
}

const hub = new Hub(await loadRoster());

if (cmd === 'serve') {
  const { startServer } = await import('../src/server.js');
  const host = values.host ?? process.env.HUB_HOST ?? '127.0.0.1';
  const port = Number(values.port ?? process.env.HUB_PORT ?? 4747);
  await startServer(hub, { host, port });
  console.log(`Agent hub on http://${host}:${port}`);
} else if (cmd === 'agents') {
  for (const a of hub.agents) {
    const state = a.provider === 'handoff' ? 'hand-off' : a.callable ? 'ready' : `no key (${a.keyEnv})`;
    console.log(`${a.id.padEnd(11)} ${a.name.padEnd(11)} ${state.padEnd(28)} ${a.role}`);
  }
} else if (cmd === 'machines') {
  for (const m of await Promise.all(hub.roster.machines.map((m) => checkMachine(m)))) {
    console.log(`${m.id.padEnd(6)} ${m.host.padEnd(16)} ${m.online ? 'online ' : 'offline'}  ${m.agent} · ${m.use}`);
  }
} else if (cmd === 'route') {
  const r = values.smart ? await hub.smartRoute(prompt) : hub.route(prompt);
  console.log(`→ ${r.pick}  (${r.reason})`);
  if (r.signals.length) console.log(`  signals: ${r.signals.join(', ')}`);
  console.log(`  ranking: ${r.ranked.map((x) => `${x.id} ${x.score}${x.callable ? '' : '*'}`).join(' · ')}   (* = no key)`);
  for (const f of r.flags) console.log(`  ! ${f}`);
} else if (cmd === 'ask') {
  const mode = values.council ? 'council' : values.agent ? 'agent' : values.smart ? 'smart' : 'auto';
  const result = await hub.ask(prompt, { mode, agentId: values.agent });
  if (result.routing?.reason) console.log(`→ ${result.routing.reason}`);
  for (const f of result.routing?.flags ?? []) console.log(`! ${f}`);
  for (const a of [...result.answers, ...(result.synthesis ? [result.synthesis] : [])]) {
    console.log(`\n── ${a.name}${a.model ? ` (${a.model})` : ''} ──`);
    console.log(a.error ? `error: ${a.error}` : a.text);
  }
} else {
  console.error(`Unknown command "${cmd}". Try --help.`);
  process.exit(1);
}
