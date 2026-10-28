import { appendFile, mkdir } from 'node:fs/promises';
import { route, councilFor } from './router.js';
import { askClaude } from './providers/anthropic.js';
import { askOpenAICompatible } from './providers/openai-compatible.js';

const LOG_DIR = new URL('../logs/', import.meta.url);

// Shared brief so every agent knows it is one of several and answers in a form that compares well.
const BRIEF = `You are one of several AI agents working for Foresite Ads, a performance-marketing agency for e-commerce brands. \
Jonathan, the owner, uses a hub that routes each request to the agent best suited to it. Answer directly and concretely. \
If part of the request is outside what you can do well or verify, say which part so the hub can send it elsewhere.`;

export class Hub {
  constructor(roster, { log = true } = {}) {
    this.roster = roster;
    this.agents = roster.agents;
    this.log = log;
  }

  agent(id) {
    const a = this.agents.find((x) => x.id === id);
    if (!a) throw new Error(`Unknown agent "${id}". Known: ${this.agents.map((x) => x.id).join(', ')}`);
    return a;
  }

  get lead() { return this.agents[0]; }

  route(prompt) { return route(prompt, this.agents); }

  // Ask Claude to pick, using the roster descriptions. Falls back to the rule-based router.
  async smartRoute(prompt) {
    const rules = this.route(prompt);
    if (!this.lead.callable) return { ...rules, by: 'rules' };
    // Only offer agents the hub can actually reach, so Claude cannot pick one without a key.
    const usable = this.agents.filter((a) => a.callable || a.provider === 'handoff');
    const ids = usable.map((a) => a.id);
    const roster = usable.map((a) => `- ${a.id}: ${a.role} Skills: ${a.skills.join(', ')}. ${a.notes ?? ''}`).join('\n');
    const { text } = await askClaude(this.lead, {
      effort: 'low',
      system: 'You route requests to the right AI agent. Pick a hand-off agent only when the work must happen in that product.',
      messages: [{ role: 'user', content: `Agents:\n${roster}\n\nRequest:\n${prompt}` }],
      outputFormat: {
        type: 'json_schema',
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['pick', 'reason', 'alsoAsk'],
          properties: {
            pick: { type: 'string', enum: ids },
            reason: { type: 'string' },
            alsoAsk: { type: 'array', items: { type: 'string', enum: ids } },
          },
        },
      },
    });
    const choice = JSON.parse(text);
    // Keep the connector / Mac hand-off notes; the rules' "no key" note no longer applies.
    const flags = rules.flags.filter((f) => !f.includes('no API key'));
    return { ...rules, pick: choice.pick, reason: choice.reason, alsoAsk: choice.alsoAsk, flags, by: 'claude' };
  }

  async call(agent, prompt, history = []) {
    if (agent.provider === 'handoff') {
      return { text: `This one belongs in ${agent.name} (${agent.url}), which the hub does not chat with. ${agent.handoff ?? ''}`.trim(), handoff: true };
    }
    if (!agent.callable) throw new Error(`${agent.name} has no API key (${agent.keyEnv}).`);
    const req = { system: BRIEF, messages: [...history, { role: 'user', content: prompt }] };
    const started = Date.now();
    const out = agent.provider === 'anthropic' ? await askClaude(agent, req) : await askOpenAICompatible(agent, req);
    return { ...out, ms: Date.now() - started };
  }

  // mode: 'auto' (route), 'smart' (Claude routes), 'agent' (named), 'council' (several, then Claude merges)
  async ask(prompt, { mode = 'auto', agentId, history = [], councilSize = 3 } = {}) {
    let result;
    if (mode === 'council') {
      result = await this.council(prompt, { size: councilSize });
    } else {
      const routing = mode === 'agent' ? { pick: agentId, reason: 'chosen by you', flags: [] }
        : mode === 'smart' ? await this.smartRoute(prompt)
        : this.route(prompt);
      const agent = this.agent(routing.pick);
      result = { mode, routing, answers: [await this.settle(agent, prompt, history)] };
    }
    await this.record(prompt, result);
    return result;
  }

  async council(prompt, { size = 3 } = {}) {
    const routing = this.route(prompt);
    const ids = councilFor(prompt, this.agents, size);
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
}
