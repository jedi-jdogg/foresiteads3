import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Events, preview } from '../src/events.js';
import { Sessions, titleFor } from '../src/sessions.js';
import { Memory } from '../src/memory.js';
import { Skills, parseFrontMatter } from '../src/skills.js';
import { parseCron, matches, nextRun, fromEnglish } from '../src/cron.js';
import { Scheduler } from '../src/scheduler.js';
import { chunk, Telegram } from '../src/channels/telegram.js';
import { flatten } from '../src/hub.js';

const tmp = async (name) => pathToFileURL(await mkdtemp(join(tmpdir(), name)) + '/');

test('events buffer, replay to late subscribers, and clean up after done', async () => {
  const ev = new Events({ ttlMs: 10 });
  ev.emit('r1', 'progress', { line: 'a' });
  ev.emit('r1', 'token', { agent: 'claude', text: 'Hel' });
  const seen = [];
  const off = ev.subscribe('r1', (e) => seen.push(e.type));
  ev.emit('r1', 'tool_start', { name: 'shopify__sales_summary', input: {} });
  assert.deepEqual(seen, ['progress', 'token', 'tool_start']);
  assert.deepEqual(ev.progressOf('r1').map((p) => p.line), ['a']);
  off();
  ev.emit('r1', 'done');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ev.history('r1').length, 0);
  assert.match(preview({ a: 'x'.repeat(2000) }, 100), /more chars\)$/);
});

test('sessions persist, title themselves, and hand agents a bounded history', async () => {
  const S = new Sessions(await tmp('hub-sessions-'));
  const s = await S.ensure(null);
  assert.equal(s.title, 'New chat');
  await S.append(s.id, { prompt: 'How did Linda\'s do last week on Shopify compared with the week before?', result: { mode: 'auto', routing: { pick: 'claude', play: { id: 'analysis' } }, answers: [{ id: 'claude', name: 'Claude', text: 'Up 12%.', used: [{ name: 'shopify__sales_summary', ok: true, ms: 300, input: { big: 'x'.repeat(5000) } }] }] } });
  const again = await S.get(s.id);
  assert.equal(again.title, titleFor('How did Linda\'s do last week on Shopify compared with the week before?'));
  assert.ok(again.title.endsWith('…'));
  assert.equal(again.messages.length, 2);
  assert.equal(again.messages[1].result.answers[0].used[0].input, undefined);   // tool payloads are not stored
  const h = await S.history(s.id);
  assert.deepEqual(h.map((m) => m.role), ['user', 'assistant']);
  assert.match(h[1].content, /^\[claude\] Up 12%/);
  const tg = await S.ensure('telegram:123');
  assert.equal(tg.kind, 'telegram');
  assert.equal((await S.list()).length, 2);
  assert.equal((await S.search('12%')).length, 1);
  await S.rename(s.id, 'Weekly check');
  assert.equal((await S.get(s.id)).title, 'Weekly check');
  await S.remove(s.id);
  assert.equal((await S.list()).length, 1);
  await assert.rejects(S.get('../etc/passwd'), /Bad session id/);
  await assert.rejects(S.get(null), /Bad session id/);
  await assert.rejects(S.get('my__chat'), /Bad session id/);
  // A council turn is stored under the merged answer, not the first individual one.
  const c = await S.ensure(null);
  await S.append(c.id, { prompt: 'q', result: { mode: 'council', routing: {}, answers: [{ id: 'grok', name: 'Grok', text: 'GROK SAYS' }], synthesis: { id: 'merged', name: 'Merged answer', text: 'MERGED' } } });
  assert.equal((await S.get(c.id)).messages[1].content, 'MERGED');
});

test('memory keeps facts, preferences and notes, dedupes, recalls and forgets', async () => {
  const M = new Memory(await tmp('hub-memory-'));
  await M.remember('fact', "Linda's main store is lindas.com on Shopify");
  const dup = await M.remember('fact', "Linda's main store is lindas.com on Shopify");
  assert.equal(dup.duplicate, true);
  await M.remember('preference', 'Keep answers short and lead with the number');
  await M.remember('note', 'Decided to pause the CTV test until November');
  const brief = await M.brief();
  assert.match(brief, /Known facts:[\s\S]*lindas\.com/);
  assert.match(brief, /preferences:[\s\S]*lead with the number/);
  assert.match(brief, /Recent notes:[\s\S]*CTV test/);
  const hits = await M.recall('ctv pause');
  assert.equal(hits[0].kind, 'note');
  assert.equal((await M.forget('lindas.com')).removed, 1);
  assert.equal((await M.recall('lindas')).length, 0);
  await assert.rejects(M.remember('fact', ''), /Nothing to remember/);
  assert.deepEqual(M.tools().map((t) => t.name), ['remember', 'recall', 'forget']);
});

test('skills load from SKILL.md folders and /name prefixes invoke them', async () => {
  const dir = await tmp('hub-skills-');
  await mkdir(new URL('weekly-report/', dir));
  await writeFile(new URL('weekly-report/SKILL.md', dir), '---\nname: Weekly report\ndescription: The Monday numbers email for a client.\n---\n# Steps\n1. Pull Shopify sales.\n');
  const S = new Skills(dir);
  const list = await S.list();
  assert.equal(list[0].id, 'weekly-report');
  assert.equal(list[0].description, 'The Monday numbers email for a client.');
  const d = await S.detect("/weekly-report for Linda's");
  assert.equal(d.skill.name, 'Weekly report');
  assert.equal(d.prompt, "for Linda's");
  assert.equal((await S.detect('/nope hello')).skill, undefined);
  assert.match(await S.brief(), /weekly-report: The Monday/);
  assert.deepEqual(parseFrontMatter('no front matter\nbody').meta, {});
  await S.save('ad-copy', '---\nname: Ad copy\ndescription: Hooks.\n---\nWrite 10.');
  assert.equal((await S.list()).length, 2);
  await S.remove('ad-copy');
  await assert.rejects(S.get('ad-copy'), /No skill named/);
});

test('cron fields, plain English and next-run work in local time', () => {
  assert.deepEqual([...parseCron('*/15 9-10 * * mon-fri')[0]], [0, 15, 30, 45]);
  assert.equal(matches('30 8 * * 1-5', new Date(2026, 10, 2, 8, 30)), true);    // a Monday
  assert.equal(matches('30 8 * * 1-5', new Date(2026, 10, 1, 8, 30)), false);   // a Sunday
  assert.equal(fromEnglish('every weekday at 8am'), '0 8 * * 1-5');
  assert.equal(fromEnglish('every day at 7:15pm'), '15 19 * * *');
  assert.equal(fromEnglish('every monday 9am'), '0 9 * * 1');
  assert.equal(fromEnglish('every 3 hours'), '0 */3 * * *');
  assert.equal(fromEnglish('monthly on the 1st at 8am'), '0 8 1 * *');
  assert.throws(() => fromEnglish('whenever'), /5 fields/);
  assert.throws(() => parseCron('*/0 * * * *'), /Bad step/);
  assert.throws(() => fromEnglish('every 0 minutes'), /out of range/);
  assert.throws(() => parseCron('0 9-3 * * *'), /Reversed/);
  const rare = Date.now(); assert.equal(nextRun('0 9 31 2 *', new Date(2026, 0, 1)), null); assert.ok(Date.now() - rare < 300, 'never-matching cron resolves fast');
  const n = nextRun('0 9 * * *', new Date(2026, 0, 1, 9, 5));
  assert.equal(n.getDate(), 2); assert.equal(n.getHours(), 9);
});

test('the scheduler fires due entries once, disables one-offs and notifies', async () => {
  const path = new URL('schedules.json', await tmp('hub-sched-'));
  let now = new Date(2026, 10, 2, 7, 59);
  const ran = [], notes = [];
  const S = new Scheduler({ path, now: () => now, awaitRuns: true, run: async (e) => { ran.push(e.id); return { text: `done ${e.title}` }; }, notify: async (e, text) => notes.push(text) });
  const daily = await S.create({ title: 'Morning numbers', prompt: 'Summarise yesterday', when: 'every weekday at 8am' });
  const once = await S.create({ prompt: 'Nudge me', when: 'in 1 minutes' });
  assert.equal(daily.cron, '0 8 * * 1-5');
  assert.ok(once.at);
  await assert.rejects(S.create({ prompt: 'x', when: '2020-01-01T00:00' }), /already passed/);
  assert.deepEqual(await S.tick(), []);
  now = new Date(2026, 10, 2, 8, 0);
  assert.deepEqual((await S.tick()).sort(), [daily.id, once.id].sort());
  assert.deepEqual(await S.tick(), []);                       // same minute never fires twice
  const list = await S.list();
  assert.equal(list.find((r) => r.id === once.id).enabled, false);
  assert.equal(list.find((r) => r.id === daily.id).runs, 1);
  assert.equal(notes.length, 2);
  await S.remove(once.id);
  assert.equal((await S.list()).length, 1);
  // A change made while a run is in progress is not overwritten when the run finishes.
  let release; const slow = new Scheduler({ path, now: () => now, awaitRuns: false, run: () => new Promise((r) => { release = () => r({ text: 'late' }); }) });
  now = new Date(2026, 10, 3, 8, 0);
  await slow.tick();
  const added = await slow.create({ prompt: 'added mid-run', when: 'every day at 6am' });
  await slow.toggle(daily.id, false);
  release(); await new Promise((r) => setTimeout(r, 30));
  const after = await slow.list();
  assert.ok(after.some((r) => r.id === added.id));
  assert.equal(after.find((r) => r.id === daily.id).enabled, false);
  assert.equal(after.find((r) => r.id === daily.id).lastResult, 'late');
});

test('telegram splits long messages, ignores strangers and answers allowed chats', async () => {
  const long = 'para one\n\n' + 'x'.repeat(5000) + '\n\nlast';
  const parts = chunk(long, 4096);
  assert.ok(parts.length >= 2 && parts.every((p) => p.length <= 4096));
  assert.equal(parts.join('').replace(/\s/g, '').length, long.replace(/\s/g, '').length);
  const calls = [];
  const fetchImpl = async (url, opts) => { const method = url.split('/').pop(); const body = JSON.parse(opts.body); calls.push({ method, body }); return { json: async () => ({ ok: true, result: method === 'getMe' ? { username: 'hubbot' } : {} }) }; };
  const T = new Telegram({ token: 't', allowed: '42, 43', fetchImpl, ask: async (chat, text) => ({ text: `echo ${text}`, images: [] }) });
  await T.handle({ chat: { id: 99 }, text: 'hi' });
  assert.match(calls.at(-1).body.text, /Your chat id is 99/);
  await T.handle({ chat: { id: 42 }, text: 'hello' });
  assert.equal(calls.at(-1).body.text, 'echo hello');
  assert.match(await T.test(), /@hubbot/);
});

test('flatten gives channels one plain answer', () => {
  assert.equal(flatten({ mode: 'auto', answers: [{ id: 'claude', name: 'Claude', text: 'Yes.' }] }).text, 'Yes.\n\n— Claude');
  assert.equal(flatten({ mode: 'council', answers: [], synthesis: { text: 'Merged.' } }).text, 'Merged.');
  assert.match(flatten({ mode: 'recommend', routing: { options: [{ kind: 'agent', agentId: 'grok', why: 'X knows' }] } }).text, /• grok: X knows/);
});

test('a streamed Responses API answer still yields the full text', async () => {
  const { createServer } = await import('node:http');
  const { askOpenAICompatible } = await import('../src/providers/openai-compatible.js');
  const srv = createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    assert.equal(body.stream, true);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const d of ['Hello', ' world']) res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: d })}\n\n`);
    const response = { id: 'r1', model: 'gpt-6-astra', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello world' }] }], usage: { input_tokens: 3, output_tokens: 2 } };
    res.write(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`);
    res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const tokens = [];
    const out = await askOpenAICompatible({ apiKey: 'k', api: 'responses', baseURL: `http://127.0.0.1:${srv.address().port}/v1`, model: 'gpt-6-astra', tools: false }, { system: 's', messages: [{ role: 'user', content: 'hi' }], onToken: (t) => tokens.push(t) });
    assert.equal(out.text, 'Hello world');
    assert.equal(tokens.join(''), out.text);
    assert.equal(out.model, 'gpt-6-astra');
  } finally { srv.close(); }
});
