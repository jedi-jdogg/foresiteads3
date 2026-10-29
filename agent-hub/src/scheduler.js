// Reminders and recurring jobs. Each entry is a prompt the hub runs through the playbook at a time
// (one-off, ISO) or on a cron line. Results land in the "Scheduled" chat and go out on every notifier
// (Telegram, when connected). The registry is schedules.json, gitignored like machines.json.
import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { parseCron, matches, nextRun, fromEnglish } from './cron.js';

export const SCHEDULES_PATH = new URL('../schedules.json', import.meta.url);

export class Scheduler {
  constructor({ run, notify = async () => {}, path = SCHEDULES_PATH, now = () => new Date(), awaitRuns = false } = {}) {
    this.awaitRuns = awaitRuns;   // tests wait for runs inline; the hub lets them go in the background
    this.run = run;          // async (entry) => { text, ... }
    this.notify = notify;    // async (entry, text) => {}
    this.path = path;
    this.now = now;
    this.timer = null;
    this.lastMinute = null;
    this.lock = Promise.resolve();   // serialises every read-modify-write of schedules.json
    this.inFlight = new Set();
  }

  // Run fn with exclusive access to the file.
  locked(fn) { const p = this.lock.then(fn, fn); this.lock = p.catch(() => {}); return p; }

  async list() {
    let rows = [];
    try { rows = JSON.parse(await readFile(this.path, 'utf8')); } catch {}
    return rows.map((r) => ({ ...r, next: this.nextFor(r)?.toISOString() ?? null }));
  }
  async save(rows) { await writeFile(this.path, JSON.stringify(rows.map(({ next, ...r }) => r), null, 2) + '\n'); }

  nextFor(r) {
    if (!r.enabled) return null;
    if (r.at) return new Date(r.at) > this.now() ? new Date(r.at) : null;
    return r.cron ? nextRun(r.cron, this.now()) : null;
  }

  // when: a cron line, plain English ("every weekday at 8am"), or an ISO time / "in 20 minutes" for one-offs.
  async create({ title, prompt, when, agentId, mode }) {
    if (!prompt?.trim()) throw new Error('A schedule needs the prompt to run.');
    if (!when?.trim()) throw new Error('Say when: a cron line, "every day at 8am", an ISO time, or "in 20 minutes".');
    const entry = { id: randomBytes(4).toString('hex'), title: (title ?? prompt).trim().slice(0, 80), prompt: prompt.trim(), enabled: true, createdAt: new Date().toISOString(), runs: 0, ...(agentId ? { agentId } : {}), ...(mode ? { mode } : {}) };
    const w = when.trim();
    let m;
    if ((m = /^in (\d+) (minutes?|hours?|days?)$/i.exec(w))) {
      const ms = Number(m[1]) * (m[2].startsWith('m') ? 60e3 : m[2].startsWith('h') ? 3600e3 : 86400e3);
      entry.at = new Date(this.now().getTime() + ms).toISOString();
    } else if (/^\d{4}-\d{2}-\d{2}/.test(w)) {
      const d = new Date(w);
      if (Number.isNaN(d.getTime())) throw new Error(`Could not read the time "${w}".`);
      if (d <= this.now()) throw new Error('That time has already passed.');
      entry.at = d.toISOString();
    } else {
      entry.cron = fromEnglish(w);
      parseCron(entry.cron);
    }
    await this.locked(async () => { const rows = await this.list(); rows.push(entry); await this.save(rows); });
    return { ...entry, next: this.nextFor(entry)?.toISOString() ?? null };
  }

  async remove(id) { await this.locked(async () => this.save((await this.list()).filter((r) => r.id !== id))); return { ok: true }; }
  async toggle(id, enabled) { return this.locked(async () => { const rows = await this.list(); const r = rows.find((x) => x.id === id); if (!r) throw new Error('No such schedule.'); r.enabled = enabled; await this.save(rows); return r; }); }
  // Change one entry by id against the current file, so nothing written meanwhile is lost.
  async patch(id, changes) { return this.locked(async () => { const rows = await this.list(); const r = rows.find((x) => x.id === id); if (r) { Object.assign(r, changes); await this.save(rows); } return r; }); }

  // Called once a minute. Fires what is due; one-offs disable themselves after running. A run that
  // outlasts the minute is not started again until it finishes.
  async tick(date = this.now()) {
    const minute = date.toISOString().slice(0, 16);
    if (minute === this.lastMinute) return [];
    this.lastMinute = minute;
    const rows = await this.list();
    const fired = [];
    for (const r of rows) {
      if (!r.enabled || this.inFlight.has(r.id)) continue;
      const due = r.at ? new Date(r.at) <= date : r.cron ? matches(r.cron, date) : false;
      if (!due) continue;
      this.inFlight.add(r.id);
      fired.push(r.id);
      await this.patch(r.id, { runs: (r.runs ?? 0) + 1, lastRunAt: date.toISOString(), ...(r.at ? { enabled: false } : {}) });
      const job = (async () => {
        try {
          const out = await this.run(r);
          await this.patch(r.id, { lastResult: (out?.text ?? '').slice(0, 2000), lastError: null });
          await this.notify(r, out?.text ?? '', out);
        } catch (err) { await this.patch(r.id, { lastError: err.message }); }
        finally { this.inFlight.delete(r.id); }
      })();
      if (this.awaitRuns) await job;
    }
    return fired;
  }

  start() { if (this.timer) return; this.tick().catch(() => {}); this.timer = setInterval(() => this.tick().catch(() => {}), 20000); this.timer.unref?.(); }
  stop() { clearInterval(this.timer); this.timer = null; }

  tools() {
    const S = this;
    return [
      { name: 'create', description: 'Schedule a prompt to run later or on a repeat, with the result sent to Jonathan (Scheduled chat and Telegram). when: a cron line ("0 8 * * 1-5"), plain English ("every day at 8am", "every monday 7am", "every 2 hours", "weekdays at 9:30"), an ISO time for once, or "in 20 minutes". Use the hub Mac\'s local time.',
        input_schema: { type: 'object', required: ['prompt', 'when'], properties: { title: { type: 'string' }, prompt: { type: 'string', description: 'What the hub should ask its agents when it fires.' }, when: { type: 'string' } } },
        run: (a) => S.create(a) },
      { name: 'list', description: 'Every schedule with its next run time and last result.', input_schema: { type: 'object', properties: {} }, run: () => S.list() },
      { name: 'delete', description: 'Remove a schedule by id.', input_schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }, run: ({ id }) => S.remove(id) },
    ];
  }
}
