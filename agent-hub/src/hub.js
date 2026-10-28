import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { route, councilFor } from './router.js';
import { askClaude } from './providers/anthropic.js';
import { askOpenAICompatible } from './providers/openai-compatible.js';

const LOG_DIR = new URL('../logs/', import.meta.url);
const FEEDBACK = new URL('feedback.jsonl', LOG_DIR);

// Shared brief so every agent knows it is one of several and answers in a form that compares well.
const BRIEF = `You are one of several AI agents working for Foresite Ads, a performance-marketing agency for e-commerce brands. \
Jonathan, the owner, uses a hub that routes each request to the agent best suited to it. Answer directly and concretely. \
If part of the request is outside what you can do well or verify, say which part so the hub can send it elsewhere.`;

export class Hub {
  // whenUnsure: 'ask' returns the recommendation without calling anyone; 'pick' goes with the top option.
  constructor(roster, { log = true, whenUnsure = 'ask' } = {}) {
    this.roster = roster;
    this.agents = roster.agents;
    this.playbook = roster.playbook;
    this.log = log;
    this.whenUnsure = whenUnsure;
  }

  agent(id) {
    const a = this.agents.find((x) => x.id === id);
    if (!a) throw new Error(`Unknown agent "${id}". Known: ${this.agents.map((x) => x.id).join(', ')}`);
    return a;
  }

  get lead() { return this.agents[0]; }

  route(prompt) { return route(prompt, this.agents, this.playbook); }

  // Claude reads the playbook and the request and decides. Same output shape as the rule router.
  async smartRoute(prompt) {
    const rules = this.route(prompt);
    if (!this.lead.callable) return { ...rules, by: 'rules' };
    // Only offer agents the hub can actually reach, so Claude cannot pick one without a key.
    const usable = this.agents.filter((a) => a.callable || a.provider === 'handoff');
    const ids = usable.map((a) => a.id);
    const playIds = this.playbook.plays.map((p) => p.id);
    const agentsText = usable.map((a) => `- ${a.id}: ${a.role} ${a.notes ?? ''}`).join('\n');
    const playsText = this.playbook.plays.map((p) => `- ${p.id} (${p.label}): first choice ${p.primary}, backups ${(p.backup ?? []).join(', ') || 'none'}${p.council ? `, council ${p.council.join(', ')}` : ''}. ${p.why}`).join('\n');
    const { text } = await askClaude(this.lead, {
      effort: 'low',
      system: `You route requests to the right AI agent, following the playbook. Choose the play that fits the request, \
then that play's first choice if it is available, else its first available backup. Say "low" confidence when the request \
fits two plays with different agents about equally. Suggest a council only when independent views would change the answer.`,
      messages: [{ role: 'user', content: `Available agents:\n${agentsText}\n\nPlaybook:\n${playsText}\n\nRequest:\n${prompt}` }],
      outputFormat: {
        type: 'json_schema',
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['play', 'pick', 'confidence', 'reason', 'suggestCouncil'],
          properties: {
            play: { type: 'string', enum: playIds },
            pick: { type: 'string', enum: ids },
            confidence: { type: 'string', enum: ['high', 'low'] },
            reason: { type: 'string' },
            suggestCouncil: { type: 'boolean' },
          },
        },
      },
    });
    const choice = JSON.parse(text);
    const play = this.playbook.plays.find((p) => p.id === choice.play);
    const options = [{ kind: 'agent', agentId: choice.pick, play: play.label, why: choice.reason }];
    const council = (play.council ?? []).filter((id) => this.agents.find((a) => a.id === id)?.callable);
    if (choice.suggestCouncil && council.length >= 2) {
      options.push({ kind: 'council', agents: council, play: play.label, why: `Ask ${council.join(', ')} and have Claude merge the answers.` });
    }
    // Keep the playbook notes (connectors, Macs); the rules' "not set up" note may no longer apply.
    const flags = rules.flags.filter((f) => !f.includes("isn't set up"));
    return {
      ...rules,
      play: { id: play.id, label: play.label, why: play.why },
      pick: choice.pick,
      reason: `${play.label} → ${this.agent(choice.pick).name}: ${choice.reason}`,
      confidence: choice.confidence,
      decision: choice.confidence === 'high' && options.length === 1 ? 'proceed' : 'recommend',
      options,
      flags,
      by: 'claude',
    };
  }

  async call(agent, prompt, history = []) {
    if (agent.provider === 'handoff') {
      return { text: `This one belongs in ${agent.name} (${agent.url}), which the hub does not chat with. ${agent.handoff ?? ''}`.trim(), handoff: true };
    }
    if (!agent.callable) throw new Error(`${agent.name} isn't set up (${agent.apiKey ? agent.baseURLEnv : agent.keyEnv} missing from .env).`);
    const req = { system: BRIEF, messages: [...history, { role: 'user', content: prompt }] };
    const started = Date.now();
    const out = agent.provider === 'anthropic' ? await askClaude(agent, req) : await askOpenAICompatible(agent, req);
    return { ...out, ms: Date.now() - started };
  }

  // mode: 'auto' (playbook), 'smart' (Claude reads the playbook), 'agent' (named), 'council' (several, merged).
  // In auto and smart, a close call or a council-worthy play comes back as a recommendation when whenUnsure is 'ask'.
  async ask(prompt, { mode = 'auto', agentId, agents, history = [], councilSize = 3, whenUnsure = this.whenUnsure } = {}) {
    let result;
    if (mode === 'council') {
      result = await this.council(prompt, { size: councilSize, agents });
    } else if (mode === 'agent') {
      const routing = { ...this.route(prompt), pick: agentId, reason: `${this.agent(agentId).name}: chosen by you`, decision: 'proceed', flags: [] };
      result = { mode, routing, answers: [await this.settle(this.agent(agentId), prompt, history)] };
    } else {
      const routing = mode === 'smart' ? await this.smartRoute(prompt) : this.route(prompt);
      if (routing.decision === 'recommend' && whenUnsure === 'ask') {
        result = { mode: 'recommend', routing, answers: [] };
      } else {
        result = { mode, routing, answers: [await this.settle(this.agent(routing.pick), prompt, history)] };
      }
    }
    await this.record(prompt, result);
    return result;
  }

  async council(prompt, { size = 3, agents } = {}) {
    const routing = this.route(prompt);
    const ids = agents?.length ? agents.filter((id) => this.agent(id).callable) : councilFor(prompt, this.agents, this.playbook, size);
    if (!ids.length) throw new Error('No agents have API keys yet. Add at least one to .env.');
    const answers = await Promise.all(ids.map((id) => this.settle(this.agent(id), prompt)));
    const ok = answers.filter((a) => !a.error);

    let synthesis;
    if (this.lead.callable && ok.length > 1) {
      const panel = ok.map((a) => `### ${a.name}\n${a.text}`).join('\n\n');
      synthesis = await this.settle(this.lead, `Several agents answered the request below. Merge them into one answer for Jonathan. \
Say where they agree, flag where they disagree and which view you would trust and why, keep any cited sources, \
and end with the recommended next step.\n\nRequest:\n${prompt}\n\nAnswers:\n${panel}`);
      synthesis.name = 'Merged answer';
      synthesis.id = 'merged';
    }
    return { mode: 'council', routing: { ...routing, council: ids }, answers, synthesis };
  }

  // Never let one agent's failure sink the whole request.
  async settle(agent, prompt, history) {
    try {
      return { id: agent.id, name: agent.name, ...(await this.call(agent, prompt, history)) };
    } catch (err) {
      return { id: agent.id, name: agent.name, error: err.message };
    }
  }

  async record(prompt, result) {
    if (!this.log) return;
    await mkdir(LOG_DIR, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const line = JSON.stringify({ at: new Date().toISOString(), prompt, ...result });
    await appendFile(new URL(`${day}.jsonl`, LOG_DIR), line + '\n');
  }

  // A thumbs up or down on one answer, filed under the play it was routed by.
  async feedback({ prompt, play, agentId, rating, note }) {
    if (!['up', 'down'].includes(rating)) throw new Error('rating must be "up" or "down"');
    await mkdir(LOG_DIR, { recursive: true });
    await appendFile(FEEDBACK, JSON.stringify({ at: new Date().toISOString(), prompt, play, agentId, rating, note }) + '\n');
  }

  // Ratings per play and agent, to check the playbook against what actually worked.
  async scorecard() {
    let raw = '';
    try { raw = await readFile(FEEDBACK, 'utf8'); } catch { return []; }
    const tally = new Map();
    for (const line of raw.split('\n').filter(Boolean)) {
      const f = JSON.parse(line);
      const k = `${f.play ?? 'unknown'}|${f.agentId}`;
      const t = tally.get(k) ?? { play: f.play ?? 'unknown', agent: f.agentId, up: 0, down: 0 };
      t[f.rating]++;
      tally.set(k, t);
    }
    return [...tally.values()].sort((a, b) => a.play.localeCompare(b.play) || (b.up - b.down) - (a.up - a.down));
  }
}
