import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { route, councilFor } from './router.js';
import { resolveAgent, saveEnv } from './registry.js';
import { Sources, loadSources, publicSource } from './sources/registry.js';
import { Machines } from './machines.js';
import { askClaude } from './providers/anthropic.js';
import { askOpenAICompatible } from './providers/openai-compatible.js';
import { askPerplexity } from './providers/perplexity.js';

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
    this.machines = new Machines();
    this.sources = new Sources(roster.sources ?? [], process.env, { machines: this.machines });
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

  // Save an agent's key (and endpoint) to .env, re-resolve it, and prove the connection with one tiny call.
  async connect(agentId, { apiKey, baseURL, model, effort } = {}) {
    const agent = this.agent(agentId);
    const updates = {};
    if (apiKey !== undefined) updates[agent.keyEnv] = apiKey;
    if (baseURL !== undefined && agent.baseURLEnv) updates[agent.baseURLEnv] = baseURL;
    if (model !== undefined && agent.modelEnv) updates[agent.modelEnv] = model;
    if (effort !== undefined && agent.effortEnv) updates[agent.effortEnv] = effort;
    await saveEnv(updates);
    const fresh = resolveAgent(this.roster.agents.find((a) => a.id === agentId) ?? agent);
    Object.assign(agent, fresh);
    return this.test(agentId);
  }

  // One tiny call. If the provider refuses the model (403/404/400 naming it) the alternates in agents.json are
  // tried in turn; the first that answers is saved as the agent's model so later calls use it.
  async test(agentId) {
    const agent = this.agent(agentId);
    if (!agent.callable) return { id: agentId, ok: false, error: `Missing ${agent.apiKey ? agent.baseURLEnv : agent.keyEnv}.` };
    const started = Date.now();
    const req = { system: 'Reply with the single word OK.', messages: [{ role: 'user', content: 'Connection test.' }] };
    const attempt = (model) => provider(agent.provider)({ ...agent, model }, { ...req, effort: 'low' });
    const tried = [];
    let lastErr;
    for (const model of [agent.model, ...(agent.altModels ?? []).filter((m) => m !== agent.model)]) {
      try {
        const out = await attempt(model);
        agent.verified = true;
        let note = '';
        if (model !== agent.model) {
          if (agent.modelEnv) await saveEnv({ [agent.modelEnv]: model });
          note = ` ${agent.model} was refused, so the hub switched to ${model}.`;
          agent.model = model;
        }
        return { id: agentId, ok: true, model: out.model ?? model, ms: Date.now() - started, note };
      } catch (err) {
        lastErr = err;
        tried.push(model);
        const status = err.status ?? err.statusCode;
        const modelProblem = status === 403 || status === 404 || (status === 400 && /model/i.test(err.message ?? ''));
        if (!modelProblem) break;
      }
    }
    const st = lastErr?.status ?? lastErr?.statusCode;
    agent.verified = st === 429 || st === 402 || /credit|billing|quota/i.test(lastErr?.message ?? '') ? 'billing' : false;
    const msg = friendlyError(lastErr);
    return { id: agentId, ok: false, error: tried.length > 1 ? `${msg} Tried models: ${tried.join(', ')}.` : msg };
  }

  async call(agent, prompt, history = []) {
    if (agent.provider === 'handoff') {
      return { text: `This one belongs in ${agent.name} (${agent.url}), which the hub does not chat with. ${agent.handoff ?? ''}`.trim(), handoff: true };
    }
    if (!agent.callable) throw new Error(`${agent.name} isn't set up (${agent.apiKey ? agent.baseURLEnv : agent.keyEnv} missing from .env).`);
    const started = Date.now();
    const tools = await this.sources.tools();
    const exec = (name, input) => this.sources.call(name, input);
    let system = BRIEF;
    let prefetched = [];
    if (tools.length && agent.tools) {
      system += ` You can read live business data with the tools provided. Use them whenever the question is about the store, \
marketing performance or customers rather than guessing; say which source each figure came from and the date window.`;
    } else if (tools.length) {
      // This agent cannot call tools: fetch the summaries the request seems to need and hand them over as context.
      prefetched = await this.sources.prefetch(prompt);
      if (prefetched.length) {
        const pack = prefetched.map((p) => `### ${p.name} (${p.ok ? 'ok' : 'failed'})\n${JSON.stringify(p.ok ? p.result : { error: p.error }).slice(0, 12000)}`).join('\n\n');
        system += `\n\nLive data pulled for this request (cite the source and window when you use it):\n${pack}`;
      }
    }
    const req = { system, messages: [...history, { role: 'user', content: prompt }], tools: agent.tools ? tools : [], exec };
    const out = await provider(agent.provider)(agent, { ...req, effort: agent.effort ?? 'medium' });
    const used = [...(out.used ?? []), ...prefetched.map((p) => ({ name: p.name, prefetched: true, ok: p.ok, ms: p.ms }))];
    return { ...out, used, ms: Date.now() - started };
  }

  // Models the provider says this account can use, newest first. Perplexity's Agent API uses presets instead.
  async listModels(agentId) {
    const agent = this.agent(agentId);
    if (!agent.callable) return { id: agentId, models: agent.modelChoices ?? [], live: false };
    try {
      let models;
      if (agent.provider === 'perplexity') models = agent.modelChoices ?? [];
      else if (agent.provider === 'anthropic') {
        const { default: Anthropic } = await import('@anthropic-ai/sdk');
        const page = await new Anthropic({ apiKey: agent.apiKey }).models.list({ limit: 100 });
        models = page.data.sort((x, y) => new Date(y.created_at) - new Date(x.created_at)).map((m) => m.id);
      } else {
        const { default: OpenAI } = await import('openai');
        const page = await new OpenAI({ apiKey: agent.apiKey, ...(agent.baseURL ? { baseURL: agent.baseURL } : {}) }).models.list();
        models = page.data.sort((x, y) => (y.created ?? 0) - (x.created ?? 0)).map((m) => m.id);
        if (agent.id === 'openai') models = models.filter((m) => /^(gpt|o\d)/.test(m) && !/(audio|realtime|transcribe|tts|image|embedding|search|moderation|codex|instruct|\d{4}-\d{2}-\d{2})/.test(m));
      }
      return { id: agentId, models, live: true };
    } catch (err) {
      return { id: agentId, models: agent.modelChoices ?? [], live: false, error: friendlyError(err) };
    }
  }

  // Data sources: connect (save creds + test), test, list.
  async connectSource(id, values = {}) {
    const src = this.sources.get(id);
    const allowed = new Set(src.envs.map((e) => e.key));
    const updates = Object.fromEntries(Object.entries(values).filter(([k, v]) => allowed.has(k) && v !== undefined));
    await saveEnv(updates);
    this.sources.refresh();
    return this.sources.test(id);
  }
  publicSources() { return this.sources.list.map(publicSource); }

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

  // Today's exchanges, newest first, trimmed to what the log view shows.
  async recent(limit = 50) {
    const day = new Date().toISOString().slice(0, 10);
    let raw = '';
    try { raw = await readFile(new URL(`${day}.jsonl`, LOG_DIR), 'utf8'); } catch { return []; }
    return raw.split('\n').filter(Boolean).slice(-limit).reverse().map((line) => {
      const e = JSON.parse(line);
      return { at: e.at, prompt: e.prompt, mode: e.mode, routing: { play: e.routing?.play, pick: e.routing?.pick }, answers: (e.answers ?? []).map((a) => a.id), synthesis: Boolean(e.synthesis) };
    });
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

function provider(name) {
  if (name === 'anthropic') return askClaude;
  if (name === 'perplexity') return askPerplexity;
  return askOpenAICompatible;
}

// Turn provider errors into a line that says what to do.
function friendlyError(err) {
  const status = err.status ?? err.statusCode;
  const msg = err.message ?? String(err);
  const tail = status ? ` (HTTP ${status}: ${msg.replace(/^\d+\s*/, '').slice(0, 140)})` : ` (${msg.slice(0, 140)})`;
  if (status === 401 || /invalid.*key|authentication|unauthorized/i.test(msg)) return `The key was rejected. It must be an API key from the provider's developer console, copied in full${tail}`;
  if (status === 403) return `The key works but this account is not allowed to use that model. Check the plan or the model name${tail}`;
  if (status === 404 && /model/i.test(msg)) return `Model not found. Set a model your account lists in .env${tail}`;
  if (status === 429 || status === 402 || /quota|billing|insufficient|credit/i.test(msg)) return `The provider refused for billing or rate-limit reasons. Add credit or a payment method on their console${tail}`;
  if (status === 400) return `The provider rejected the request${tail}`;
  if (/ENOTFOUND|ECONNREFUSED|fetch failed|getaddrinfo/i.test(msg)) return 'Could not reach the endpoint. Check the base URL and your connection.';
  return msg.length > 200 ? msg.slice(0, 197) + '…' : msg;
}
