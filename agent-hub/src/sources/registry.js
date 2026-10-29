import { readFile } from 'node:fs/promises';

export const SOURCES_PATH = new URL('../../sources.json', import.meta.url);

// Each module exports `tools(creds)` → [{ name, description, input_schema, run(args) }] and `test(creds)`.
const MODULES = {
  shopify: () => import('./shopify.js'),
  klaviyo: () => import('./klaviyo.js'),
  triplewhale: () => import('./triplewhale.js'),
  meta: () => import('./meta.js'),
  google: () => import('./google.js'),
  vistasocial: () => import('./vistasocial.js'),
  mcp: () => import('./mcp.js'),
  machines: () => import('./machines.js'),
  memory: () => import('./memory.js'),
  skills: () => import('./skills.js'),
  schedule: () => import('./schedule.js'),
  browser: () => import('./browser.js'),
  composio: () => import('./composio.js'),
};
// Local abilities that are always on once the hub has the piece they need.
const LOCAL_READY = { machines: (ctx) => Boolean(ctx.machines), memory: (ctx) => Boolean(ctx.memory), skills: (ctx) => Boolean(ctx.skills), schedule: (ctx) => Boolean(ctx.scheduler), browser: (ctx) => Boolean(ctx.browser) };

export async function loadSources(path = SOURCES_PATH) {
  return JSON.parse(await readFile(path, 'utf8')).sources;
}

// Fill in credentials from the environment. A source is connected when every required env is set.
export function resolveSource(source, env = process.env) {
  if (source.auth === 'local') return { ...source, creds: {}, missing: [], connected: Boolean(source.localReady), needsAuth: false };
  const creds = Object.fromEntries(source.envs.map((e) => [e.key, env[e.key] || undefined]));
  const missing = source.envs.filter((e) => !e.optional && !e.managed && !creds[e.key]).map((e) => e.key);
  // OAuth sources also need the token the consent flow stores.
  const needsAuth = source.auth === 'oauth' && !source.envs.filter((e) => e.managed).every((e) => creds[e.key]);
  return { ...source, creds, missing, connected: missing.length === 0 && !needsAuth, needsAuth: missing.length === 0 && needsAuth };
}

// Never send credentials to the browser; say which fields are set.
export function publicSource({ creds, machines, ctx, ...rest }) {
  return { ...rest, set: Object.fromEntries(Object.entries(creds).map(([k, v]) => [k, Boolean(v)])) };
}

export class Sources {
  constructor(defs, env = process.env, ctx = {}) {
    this.defs = defs;
    this.env = env;
    this.ctx = ctx;
    this.machines = ctx.machines;
    this.refresh();
  }

  refresh() {
    this.list = this.defs.map((d) => resolveSource(d.auth === 'local' ? { ...d, localReady: Boolean(LOCAL_READY[d.module]?.(this.ctx)) } : d, this.env));
    for (const s of this.list) if (s.auth === 'local') { s.machines = this.machines; s.ctx = this.ctx; }
    this.cache = new Map();
  }

  get(id) {
    const s = this.list.find((x) => x.id === id);
    if (!s) throw new Error(`Unknown source "${id}"`);
    return s;
  }

  async module(source) {
    const load = MODULES[source.module];
    if (!load) throw new Error(`Source "${source.id}" names unknown module "${source.module}"`);
    return load();
  }

  // All tools of all connected sources, namespaced so agents see shopify__sales_summary etc.
  // Remote sources (MCP, Composio) list their tools over the network, so each source's list is kept for
  // two minutes (or until refresh()); local ones are always re-read because their state is cheap.
  async tools() {
    const out = [];
    const seen = new Set();
    for (const s of this.list.filter((x) => x.connected)) {
      if (s.module === 'machines' && this.machines && !(await this.machines.list()).length) continue;
      try {
        let list;
        const hit = this.cache.get(s.id);
        if (hit && Date.now() - hit.at < 120000 && s.auth !== 'local') list = hit.list;
        else { const mod = await this.module(s); list = await mod.tools(s.creds, s); this.cache.set(s.id, { at: Date.now(), list }); }
        for (const t of list) {
          let name = `${s.id}__${t.name}`.slice(0, 64);
          while (seen.has(name)) name = name.slice(0, 62) + '_' + (seen.size % 10);
          seen.add(name);
          out.push({ ...t, name, source: s.id, short: t.name });
        }
      } catch (err) {
        this.cache.delete(s.id);
        out.push({ name: `${s.id}__unavailable`, source: s.id, short: 'unavailable', description: `Source failed to load: ${err.message}`, input_schema: { type: 'object', properties: {} }, run: async () => ({ error: err.message }) });
      }
    }
    return out;
  }

  async call(name, args = {}) {
    const tool = (await this.tools()).find((t) => t.name === name);
    if (!tool) throw new Error(`No such tool: ${name}`);
    const started = Date.now();
    try {
      const result = await tool.run(args ?? {});
      return { name, source: tool.source, ok: true, ms: Date.now() - started, result };
    } catch (err) {
      return { name, source: tool.source, ok: false, ms: Date.now() - started, error: err.message };
    }
  }

  // Which connected sources a request mentions, with the summaries worth fetching before asking an agent that cannot call tools.
  mentioned(prompt) {
    return this.list.filter((s) => s.connected && s.mentions && new RegExp(s.mentions, 'i').test(prompt));
  }

  async prefetch(prompt) {
    const out = [];
    for (const s of this.mentioned(prompt)) {
      for (const short of s.prefetch ?? []) out.push(await this.call(`${s.id}__${short}`, {}));
    }
    return out;
  }

  async test(id) {
    const s = this.get(id);
    if (!s.connected) return { id, ok: false, error: s.needsAuth ? 'Needs sign-in: use the Connect button.' : `Missing ${s.missing.join(', ')}.` };
    const started = Date.now();
    try {
      const mod = await this.module(s);
      const summary = await mod.test(s.creds, s);
      return { id, ok: true, ms: Date.now() - started, summary };
    } catch (err) {
      return { id, ok: false, ms: Date.now() - started, error: friendly(err) };
    }
  }
}

export function friendly(err) {
  const m = err.message ?? String(err);
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|aborted/i.test(m)) return 'Could not reach the service. Check the URL / store name and your internet connection.';
  if (/^401|^403|invalid.*(key|token)|unauthori[sz]ed|forbidden/i.test(m)) return `The key was rejected (${m.slice(0, 120)}). Check it was copied in full and has read access.`;
  if (/^404/.test(m)) return `Not found (${m.slice(0, 120)}). Check the ID or store name.`;
  if (/^429/.test(m)) return 'Rate limited by the service. Try again in a minute.';
  return m.length > 240 ? m.slice(0, 237) + '…' : m;
}

// Shared helpers for the modules.
export async function getJson(url, { headers = {}, method = 'GET', body, timeoutMs = 20000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 500) }; }
    if (!res.ok) {
      const msg = json?.error?.message ?? json?.errors?.[0]?.detail ?? json?.message ?? json?.raw ?? res.statusText;
      const err = new Error(`${res.status}: ${String(msg).slice(0, 300)}`); err.status = res.status; throw err;
    }
    return json;
  } finally { clearTimeout(t); }
}

export const daysAgo = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
export const today = () => new Date().toISOString().slice(0, 10);
export const num = (v) => Math.round(Number(v) * 100) / 100;
