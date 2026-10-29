// Persistent memory the agents share: facts about the business, Jonathan's preferences, and a daily note.
// Plain Markdown files under memory/ so they can be read and edited by hand. Facts and preferences go
// into every agent's brief; notes are searchable and the last two days ride along too.
import { readFile, writeFile, appendFile, mkdir, readdir } from 'node:fs/promises';

export const MEMORY_DIR = new URL('../memory/', import.meta.url);
const KINDS = ['fact', 'preference', 'note'];
const BRIEF_CAP = 6000;

export class Memory {
  constructor(dir = MEMORY_DIR) { this.dir = dir; }

  fileFor(kind, day = today()) {
    if (kind === 'fact') return new URL('facts.md', this.dir);
    if (kind === 'preference') return new URL('preferences.md', this.dir);
    if (kind === 'note') return new URL(`notes/${day}.md`, this.dir);
    throw new Error(`kind must be one of ${KINDS.join(', ')}`);
  }

  async read(kind, day) { return readFile(this.fileFor(kind, day), 'utf8').catch(() => ''); }

  async remember(kind, text) {
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!clean) throw new Error('Nothing to remember.');
    if (clean.length > 1000) throw new Error('Keep each memory under 1000 characters.');
    const file = this.fileFor(kind);
    await mkdir(new URL('./', file), { recursive: true });
    const existing = await this.read(kind);
    if (existing.split('\n').some((l) => l.replace(/^- (\d{4}-\d{2}-\d{2} )?/, '') === clean)) return { kind, text: clean, duplicate: true };
    const stamp = kind === 'note' ? new Date().toTimeString().slice(0, 5) : today();
    await appendFile(file, `- ${stamp} ${clean}\n`);
    return { kind, text: clean };
  }

  async forget(text) {
    const needle = String(text ?? '').trim().toLowerCase();
    if (needle.length < 4) throw new Error('Say more of the line to forget.');
    let removed = 0;
    for (const kind of ['fact', 'preference']) {
      const lines = (await this.read(kind)).split('\n');
      const kept = lines.filter((l) => !(l.startsWith('- ') && l.toLowerCase().includes(needle)));
      removed += lines.length - kept.length;
      if (kept.length !== lines.length) await writeFile(this.fileFor(kind), kept.join('\n'));
    }
    return { removed };
  }

  async recall(query, { limit = 20 } = {}) {
    const words = String(query ?? '').toLowerCase().split(/\W+/).filter((w) => w.length > 2);
    const rows = [];
    for (const kind of ['fact', 'preference']) for (const l of (await this.read(kind)).split('\n')) if (l.startsWith('- ')) rows.push({ kind, line: l.slice(2) });
    for (const day of await this.noteDays()) for (const l of (await this.read('note', day)).split('\n')) if (l.startsWith('- ')) rows.push({ kind: 'note', day, line: l.slice(2) });
    const scored = rows.map((r) => ({ ...r, score: words.filter((w) => r.line.toLowerCase().includes(w)).length }));
    const hits = (words.length ? scored.filter((r) => r.score) : scored).sort((a, b) => b.score - a.score).slice(0, limit);
    return hits.map(({ score, ...r }) => r);
  }

  async noteDays() {
    const names = await readdir(new URL('notes/', this.dir)).catch(() => []);
    return names.filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)).map((n) => n.slice(0, 10)).sort().reverse();
  }

  // What goes into every agent's brief.
  async brief() {
    const facts = await this.read('fact'), prefs = await this.read('preference');
    const days = (await this.noteDays()).slice(0, 2);
    const notes = (await Promise.all(days.map(async (d) => `${d}:\n${await this.read('note', d)}`))).join('\n');
    // Each part keeps its newest lines when it has to be cut, and its heading always survives.
    const tail = (t, cap) => (t.length > cap ? '…\n' + t.slice(-cap).replace(/^[^\n]*\n/, '') : t);
    const parts = [];
    if (facts.trim()) parts.push(`Known facts:\n${tail(facts.trim(), BRIEF_CAP / 2)}`);
    if (prefs.trim()) parts.push(`Jonathan's preferences:\n${tail(prefs.trim(), BRIEF_CAP / 4)}`);
    if (notes.trim()) parts.push(`Recent notes:\n${tail(notes.trim(), BRIEF_CAP / 4)}`);
    return parts.join('\n\n');
  }

  async overview() {
    const days = await this.noteDays();
    return { facts: await this.read('fact'), preferences: await this.read('preference'), noteDays: days, todayNotes: await this.read('note') };
  }

  async write(kind, text) {
    if (!['fact', 'preference', 'note'].includes(kind)) throw new Error('Bad kind.');
    const file = this.fileFor(kind);
    await mkdir(new URL('./', file), { recursive: true });
    await writeFile(file, String(text ?? '').replace(/\r\n/g, '\n').replace(/\n*$/, '\n'));
  }

  // Tools for the agents.
  tools() {
    const M = this;
    return [
      { name: 'remember', description: 'Save something for later, shared by every agent. kind "fact" = about the business, customers, accounts (long-lived); "preference" = how Jonathan likes things done; "note" = something from today worth keeping (a decision, a number, a to-do). Save when Jonathan tells you something to remember or states a lasting preference.',
        input_schema: { type: 'object', required: ['kind', 'text'], properties: { kind: { type: 'string', enum: KINDS }, text: { type: 'string', description: 'One sentence.' } } },
        run: ({ kind, text }) => M.remember(kind, text) },
      { name: 'recall', description: 'Search memory (facts, preferences, daily notes) for lines matching the query. Empty query returns the most recent lines.',
        input_schema: { type: 'object', properties: { query: { type: 'string' } } },
        run: ({ query }) => M.recall(query ?? '') },
      { name: 'forget', description: 'Remove saved facts or preferences whose text contains the given words. Use when Jonathan says something is no longer true.',
        input_schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
        run: ({ text }) => M.forget(text) },
    ];
  }
}

// Local calendar day, so an evening note lands in today's file wherever the hub Mac is.
export const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
