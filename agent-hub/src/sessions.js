// Saved conversations. One JSON file per chat under logs/sessions/, with the messages the agents saw and
// the answers they gave. The console lists them in its sidebar; Telegram and the scheduler get their own.
import { readFile, writeFile, readdir, mkdir, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

export const SESSIONS_DIR = new URL('../logs/sessions/', import.meta.url);
const HISTORY_TURNS = 12;      // messages handed to an agent as context
const MAX_MESSAGES = 400;      // kept per chat on disk

export class Sessions {
  constructor(dir = SESSIONS_DIR) { this.dir = dir; this.cache = new Map(); }

  file(id) {
    if (typeof id !== 'string' || !/^[a-z0-9:_-]{1,64}$/i.test(id) || id.includes('__')) throw new Error('Bad session id.');
    return new URL(`${id.replace(/:/g, '__')}.json`, this.dir);
  }

  async list() {
    await mkdir(this.dir, { recursive: true });
    const names = (await readdir(this.dir)).filter((n) => n.endsWith('.json'));
    const out = [];
    for (const n of names) {
      const s = await this.get(n.slice(0, -5).replace(/__/g, ':')).catch(() => null);
      if (s) out.push({ id: s.id, title: s.title, kind: s.kind, createdAt: s.createdAt, updatedAt: s.updatedAt, count: s.messages.length, last: s.messages.at(-1)?.content?.slice?.(0, 120) ?? '' });
    }
    return out.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }

  async get(id) {
    if (this.cache.has(id)) return this.cache.get(id);
    const s = JSON.parse(await readFile(this.file(id), 'utf8'));
    this.cache.set(id, s);
    return s;
  }

  // Returns the chat, creating it when missing. Ids with a prefix (telegram:123, schedule:abc) are channels.
  async ensure(id, { title, kind } = {}) {
    if (id) { try { return await this.get(id); } catch {} }
    const s = { id: id ?? randomBytes(5).toString('hex'), title: title ?? 'New chat', kind: kind ?? (id?.includes(':') ? id.split(':')[0] : 'chat'), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [] };
    await this.save(s);
    return s;
  }

  async save(s) {
    await mkdir(this.dir, { recursive: true });
    s.updatedAt = new Date().toISOString();
    if (s.messages.length > MAX_MESSAGES) s.messages.splice(0, s.messages.length - MAX_MESSAGES);
    this.cache.set(s.id, s);
    await writeFile(this.file(s.id), JSON.stringify(s, null, 1));
    return s;
  }

  async rename(id, title) { const s = await this.get(id); s.title = String(title ?? '').trim().slice(0, 120) || s.title; return this.save(s); }
  async remove(id) { this.cache.delete(id); await unlink(this.file(id)).catch(() => {}); }

  // Append one exchange. The first user message names the chat.
  async append(id, { prompt, result, meta = {} }) {
    const s = await this.ensure(id);
    const first = result?.synthesis ?? result?.answers?.find((a) => !a.error && a.text);
    s.messages.push({ role: 'user', content: prompt, at: new Date().toISOString(), ...meta });
    if (result) s.messages.push({ role: 'assistant', content: first?.text ?? result.answers?.[0]?.error ?? '', agent: result.synthesis ? 'merged' : first?.id ?? result.routing?.pick, at: new Date().toISOString(), result: slim(result) });
    if (s.title === 'New chat' && s.messages.length <= 2) s.title = titleFor(prompt);
    return this.save(s);
  }

  // What an agent gets as context: the last turns, assistant text prefixed with who said it.
  async history(id) {
    if (!id) return [];
    const s = await this.get(id).catch(() => null);
    if (!s) return [];
    return s.messages.slice(-HISTORY_TURNS).map((m) => ({ role: m.role, content: m.role === 'assistant' && m.agent ? `[${m.agent}] ${String(m.content).slice(0, 2500)}` : String(m.content).slice(0, 4000) }));
  }

  async search(q) {
    const needle = q.toLowerCase();
    const all = await this.list();
    const hits = [];
    for (const row of all) {
      const s = await this.get(row.id);
      if (row.title.toLowerCase().includes(needle) || s.messages.some((m) => String(m.content).toLowerCase().includes(needle))) hits.push(row);
    }
    return hits;
  }
}

export function titleFor(prompt) {
  const t = prompt.replace(/\s+/g, ' ').trim();
  return t.length > 56 ? t.slice(0, 53).replace(/\s\S*$/, '') + '…' : t || 'New chat';
}

// Keep what the console needs to redraw a turn, not the whole tool payloads.
function slim(result) {
  const trim = (a) => a && ({ id: a.id, name: a.name, model: a.model, ms: a.ms, error: a.error, text: a.text, images: a.images, truncated: a.truncated, used: (a.used ?? []).map(({ name, ok, ms, prefetched }) => ({ name, ok, ms, prefetched })) });
  return { mode: result.mode, routing: result.routing && { play: result.routing.play, pick: result.routing.pick, council: result.routing.council, reason: result.routing.reason, by: result.routing.by, flags: result.routing.flags }, answers: (result.answers ?? []).map(trim), synthesis: trim(result.synthesis) };
}
