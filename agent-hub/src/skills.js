// Skills: folders under skills/<name>/SKILL.md, the same shape Claude Code and Open Claude Cowork use.
// Front matter gives the name and a one-line description; the body is the playbook the agent follows.
// Agents see the list in their brief and load one with skills__load; "/name …" in a prompt loads it up front.
import { readFile, readdir, writeFile, mkdir, rm } from 'node:fs/promises';

export const SKILLS_DIR = new URL('../skills/', import.meta.url);

export class Skills {
  constructor(dir = SKILLS_DIR) { this.dir = dir; }

  async list() {
    const names = await readdir(this.dir, { withFileTypes: true }).catch(() => []);
    const out = [];
    for (const d of names) {
      if (!d.isDirectory() || d.name.startsWith('.')) continue;
      const raw = await readFile(new URL(`${d.name}/SKILL.md`, this.dir), 'utf8').catch(() => null);
      if (raw === null) continue;
      const { meta, body } = parseFrontMatter(raw);
      out.push({ id: d.name, name: meta.name ?? d.name, description: meta.description ?? firstLine(body), agent: meta.agent, words: body.split(/\s+/).length });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)) throw new Error('Bad skill name.');
    const raw = await readFile(new URL(`${id}/SKILL.md`, this.dir), 'utf8').catch(() => { throw new Error(`No skill named "${id}". Skills live in agent-hub/skills/<name>/SKILL.md.`); });
    const { meta, body } = parseFrontMatter(raw);
    return { id, name: meta.name ?? id, description: meta.description ?? firstLine(body), agent: meta.agent, body, raw };
  }

  async save(id, raw) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)) throw new Error('Skill names use letters, digits, - and _.');
    if (typeof raw !== 'string' || !raw.trim()) throw new Error('The skill file is empty.');
    await mkdir(new URL(`${id}/`, this.dir), { recursive: true });
    await writeFile(new URL(`${id}/SKILL.md`, this.dir), String(raw).replace(/\r\n/g, '\n'));
    return this.get(id);
  }
  async remove(id) { await this.get(id); await rm(new URL(`${id}/`, this.dir), { recursive: true, force: true }); }

  // "/weekly-report for Linda's" → { skill, prompt: "for Linda's" }. Anything else passes through.
  async detect(prompt) {
    const m = /^\/([a-z0-9][a-z0-9_-]*)\b\s*([\s\S]*)$/i.exec(prompt.trim());
    if (!m) return { prompt };
    try { const skill = await this.get(m[1]); return { skill, prompt: m[2].trim() || `Run the ${skill.name} skill.` }; } catch { return { prompt }; }
  }

  async brief() {
    const list = await this.list();
    if (!list.length) return '';
    return `Skills available (load one with skills__load when the request matches its description, then follow it):\n${list.map((s) => `- ${s.id}: ${s.description}`).join('\n')}`;
  }

  tools() {
    const S = this;
    return [
      { name: 'list', description: 'The skills installed in the hub: id and what each is for.', input_schema: { type: 'object', properties: {} }, run: () => S.list() },
      { name: 'load', description: 'Read a skill\'s full instructions by id, then follow them for the current request.', input_schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }, run: async ({ id }) => (await S.get(id)).body },
    ];
  }
}

export function parseFrontMatter(raw) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!m) return { meta: {}, body: raw.trim() };
  const meta = {};
  for (const line of m[1].split('\n')) { const i = line.indexOf(':'); if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, ''); }
  return { meta, body: m[2].trim() };
}
const firstLine = (body) => (body.split('\n').find((l) => l.trim() && !l.startsWith('#')) ?? '').trim().slice(0, 160);
