import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadRoster } from '../src/registry.js';
import { Hub } from '../src/hub.js';
import { startServer } from '../src/server.js';
import { Sessions } from '../src/sessions.js';
import { Memory } from '../src/memory.js';

// A stand-in OpenAI-compatible host (Chat Completions, streaming) so the whole path runs without a key.
const fake = createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  const body = JSON.parse(raw);
  const last = body.messages.at(-1).content;
  const sys = body.messages.find((m) => m.role === 'system')?.content ?? '';
  const reply = `Echo: ${last} | history=${body.messages.filter((m) => m.role !== 'system').length} | memory=${/lindas\.com/.test(sys)}`;
  if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ model: 'fake-1', choices: [{ message: { role: 'assistant', content: reply }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 7 } })); }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const piece of reply.match(/.{1,9}/g)) res.write(`data: ${JSON.stringify({ model: 'fake-1', choices: [{ delta: { content: piece } }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 7 } })}\n\n`);
  res.end('data: [DONE]\n\n');
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const fakeUrl = `http://127.0.0.1:${fake.address().port}/v1`;

const env = { MUSE_API_KEY: 'test', MUSE_BASE_URL: fakeUrl };
const hub = new Hub(await loadRoster(undefined, env), { log: false });
hub.sessions = new Sessions(pathToFileURL(await mkdtemp(join(tmpdir(), 'hub-srv-sessions-')) + '/'));
hub.memory = new Memory(pathToFileURL(await mkdtemp(join(tmpdir(), 'hub-srv-memory-')) + '/'));
await hub.memory.remember('fact', "Linda's store is lindas.com");
const server = await startServer(hub, { host: '127.0.0.1', port: 0 });
const base = `http://127.0.0.1:${server.address().port}`;
after(() => { server.close(); fake.close(); hub.scheduler.stop(); });

const post = async (path, body) => { const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return r.json(); };

test('a direct ask streams tokens over /api/events, saves the chat, and feeds memory to the agent', async () => {
  const reqId = 'test-req-1';
  const events = [];
  const es = fetch(`${base}/api/events?id=${reqId}`).then(async (r) => {
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
    while (true) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); for (const line of buf.split('\n')) if (line.startsWith('data:')) { const ev = JSON.parse(line.slice(5)); if (!events.includes(ev)) events.push(ev); } buf = buf.split('\n').filter((l) => !l.startsWith('data:')).join('\n'); }
  });
  const session = await post('/api/sessions/new', {});
  const r = await post('/api/ask', { prompt: 'hello there', mode: 'agent', agentId: 'muse', reqId, sessionId: session.id });
  await es;
  assert.equal(r.sessionId, session.id);
  assert.match(r.answers[0].text, /^Echo: hello there \| history=1 \| memory=true/);
  const types = events.map((e) => e.type);
  assert.ok(types.includes('progress') && types.includes('token') && types.includes('answer'));
  assert.equal(types.at(-1), 'done');
  assert.equal(events.filter((e) => e.type === 'token').map((e) => e.text).join(''), r.answers[0].text);
  // Second turn in the same chat carries the first one as history.
  const r2 = await post("/api/ask", { prompt: "again", mode: "agent", agentId: "muse", sessionId: session.id });
  assert.match(r2.answers[0].text, /history=3/);
  const list = await (await fetch(`${base}/api/sessions`)).json();
  assert.equal(list[0].title, 'hello there');
  assert.equal(list[0].count, 4);
  const got = await (await fetch(`${base}/api/sessions/get?id=${session.id}`)).json();
  assert.equal(got.messages[1].result.answers[0].model, 'fake-1');
});

test('skills, memory and schedules have working API routes', async () => {
  const skills = await (await fetch(`${base}/api/skills`)).json();
  assert.ok(skills.some((k) => k.id === 'weekly-report'));
  const one = await (await fetch(`${base}/api/skills/get?id=weekly-report`)).json();
  assert.match(one.raw, /^---\nname: Weekly client report/);
  const mem = await (await fetch(`${base}/api/memory`)).json();
  assert.match(mem.facts, /lindas\.com/);
  const sched = await post('/api/schedules/create', { title: 't', prompt: 'p', when: 'every day at 6am' });
  assert.equal(sched.cron, '0 6 * * *');
  await post('/api/schedules/delete', { id: sched.id });
  const bad = await post('/api/schedules/create', { prompt: 'p', when: 'sometime' });
  assert.match(bad.error, /5 fields/);
  const tg = await (await fetch(`${base}/api/telegram`)).json();
  assert.equal(tg.connected, false);
  const srcs = await (await fetch(`${base}/api/sources`)).json();
  assert.ok(srcs.find((s) => s.id === 'memory').connected);
  assert.equal(srcs.find((s) => s.id === 'browser').connected, false);   // not started: start() checks for Playwright
});
