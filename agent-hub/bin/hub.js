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
    pick: { type: 'boolean', short: 'p' },
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
  agent-hub playbook                                Which agent takes which kind of work, and why
  agent-hub route "<request>" [--smart]             Show the play, the pick and the confidence (no API call unless --smart)
  agent-hub ask "<request>"                         Follow the playbook: answer, or recommend when it is a close call
          [--pick]                                       ...never stop to recommend, go with the top option
          [--agent claude|openai|grok|perplexity|muse]   ...or send to one agent
          [--council]                                    ...or ask several and merge
          [--smart]                                      ...let Claude read the playbook and decide
  agent-hub scorecard                               Your thumbs up / down per play and agent
`);
  process.exit(0);
}

const hub = new Hub(await loadRoster(), { whenUnsure: process.env.HUB_WHEN_UNSURE === 'pick' ? 'pick' : 'ask' });
const name = (id) => hub.agent(id).name;

if (cmd === 'serve') {
  const { startServer } = await import('../src/server.js');
  const host = values.host || process.env.HUB_HOST || '127.0.0.1';
  const port = Number(values.port || process.env.HUB_PORT || 4747);
  await startServer(hub, { host, port });
  console.log(`Agent hub on http://${host}:${port}`);
} else if (cmd === 'agents') {
  for (const a of hub.agents) {
    const state = a.provider === 'handoff' ? 'hand-off' : a.callable ? 'ready' : a.apiKey ? `no endpoint (${a.baseURLEnv})` : `no key (${a.keyEnv})`;
    console.log(`${a.id.padEnd(11)} ${a.name.padEnd(11)} ${state.padEnd(28)} ${a.role}`);
  }
} else if (cmd === 'machines') {
  for (const m of await Promise.all(hub.roster.machines.map((m) => checkMachine(m)))) {
    console.log(`${m.id.padEnd(6)} ${m.host.padEnd(16)} ${m.online ? 'online ' : 'offline'}  ${m.agent} · ${m.use}`);
  }
} else if (cmd === 'playbook') {
  for (const p of hub.playbook.plays) {
    const chain = [p.primary, ...(p.backup ?? [])].map(name).join(' → ');
    console.log(`${p.label.padEnd(24)} ${chain}${p.council ? `   council: ${p.council.map(name).join(', ')}` : ''}`);
    console.log(`${''.padEnd(24)} ${p.why}`);
  }
} else if (cmd === 'scorecard') {
  const rows = await hub.scorecard();
  if (!rows.length) console.log('No ratings yet. Use the thumbs on answers in the web console.');
  for (const r of rows) console.log(`${r.play.padEnd(18)} ${(r.agent === 'merged' ? 'council' : r.agent).padEnd(11)} 👍 ${r.up}  👎 ${r.down}`);
} else if (cmd === 'route') {
  printRouting(values.smart ? await hub.smartRoute(prompt) : hub.route(prompt));
} else if (cmd === 'ask') {
  const mode = values.council ? 'council' : values.agent ? 'agent' : values.smart ? 'smart' : 'auto';
  const result = await hub.ask(prompt, { mode, agentId: values.agent, ...(values.pick ? { whenUnsure: 'pick' } : {}) });
  if (result.mode === 'recommend') {
    printRouting(result.routing);
    console.log('\nRun again with one of: --agent <id>, --council, or --pick to go with the first option.');
  } else {
    if (result.routing?.reason) console.log(`→ ${result.routing.reason}`);
    for (const f of result.routing?.flags ?? []) console.log(`! ${f}`);
  }
  for (const a of [...result.answers, ...(result.synthesis ? [result.synthesis] : [])]) {
    console.log(`\n── ${a.name}${a.model ? ` (${a.model})` : ''} ──`);
    console.log(a.error ? `error: ${a.error}` : a.text);
  }
} else {
  console.error(`Unknown command "${cmd}". Try --help.`);
  process.exit(1);
}

function printRouting(r) {
  console.log(`Play: ${r.play.label}  (${r.confidence} confidence${r.by === 'claude' ? ', decided by Claude' : ''})`);
  if (r.terms?.length) console.log(`  matched: ${r.terms.join(', ')}`);
  if (r.decision === 'proceed') console.log(`→ ${r.reason}\n  ${r.play.why}`);
  else {
    console.log('Recommend:');
    r.options.forEach((o, i) => console.log(`  ${i + 1}. ${o.kind === 'council' ? `Council (${o.agents.map(name).join(', ')})` : name(o.agentId)} · ${o.play}: ${o.why}`));
  }
  if (r.matched?.length > 1) console.log(`  other plays: ${r.matched.slice(1).map((m) => `${m.label} ${m.score}`).join(' · ')}`);
  for (const f of r.flags) console.log(`  ! ${f}`);
}
