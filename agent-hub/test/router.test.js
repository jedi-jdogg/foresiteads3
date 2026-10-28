import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { route, councilFor, matchPlays } from '../src/router.js';
import { resolveAgent, publicAgent, checkPlaybook } from '../src/registry.js';

const roster = JSON.parse(await readFile(new URL('../agents.json', import.meta.url), 'utf8'));
const playbook = JSON.parse(await readFile(new URL('../playbook.json', import.meta.url), 'utf8'));
const allKeys = { ...Object.fromEntries(roster.agents.map((a) => [a.keyEnv, 'test-key'])), MUSE_BASE_URL: 'https://muse.test/v1' };
const agents = (env = allKeys) => roster.agents.map((a) => resolveAgent(a, env));
const go = (prompt, env) => route(prompt, agents(env), playbook);

test('playbook is valid against the roster', () => {
  assert.doesNotThrow(() => checkPlaybook(playbook, agents()));
});

test('research questions go to Perplexity without asking', () => {
  const r = go('Research the latest market size for long-arm quilting machines and cite sources');
  assert.equal(r.play.id, 'live-research');
  assert.equal(r.pick, 'perplexity');
  assert.equal(r.decision, 'proceed');
});

test('X / Twitter sentiment goes to Grok', () => {
  assert.equal(go('What is the sentiment on Twitter about our new launch, is it trending?').pick, 'grok');
});

test('Instagram and Reels work goes to Muse', () => {
  assert.equal(go('Write Instagram Reels captions for the fabric sale').pick, 'muse');
});

test('image work goes to ChatGPT', () => {
  assert.equal(go('Make a logo image for the spring campaign').pick, 'openai');
});

test('plain writing goes straight to Claude', () => {
  const r = go('Draft an email to the team about the new SOP');
  assert.equal(r.pick, 'claude');
  assert.equal(r.decision, 'proceed');
});

test('no signal falls back to the general play and Claude', () => {
  const r = go('hello there');
  assert.equal(r.play.id, 'general');
  assert.equal(r.pick, 'claude');
  assert.equal(r.decision, 'proceed');
});

test('a close call between plays with different agents is a recommendation with both options', () => {
  const r = go('Instagram trends this week');
  assert.equal(r.confidence, 'low');
  assert.equal(r.decision, 'recommend');
  const ids = r.options.filter((o) => o.kind === 'agent').map((o) => o.agentId);
  assert.ok(ids.includes('perplexity') && ids.includes('muse'));
});

test('council-worthy plays recommend a council', () => {
  const r = go('Should we prioritize email or CTV next quarter? Give me pros and cons.');
  assert.equal(r.play.id, 'strategy');
  assert.equal(r.decision, 'recommend');
  assert.ok(r.options.some((o) => o.kind === 'council'));
});

test('connected-app and Mac notes show even when another play wins', () => {
  const r = go('Pull last week Shopify orders, analyze ROAS and margin, and run it on the Mac');
  assert.equal(r.pick, 'claude');
  assert.equal(r.flags.length, 2);
});

test('first choice not set up falls to its backup and says which key is missing', () => {
  const r = go('Research the latest news on Shopify fees and cite sources', { ...allKeys, PERPLEXITY_API_KEY: '' });
  assert.equal(r.pick, 'grok');
  assert.ok(r.flags.some((f) => f.includes('PERPLEXITY_API_KEY')));
});

test('Muse with a key but no endpoint is skipped, and the flag names the endpoint', () => {
  const env = { ...allKeys, MUSE_BASE_URL: '' };
  assert.equal(agents(env).find((a) => a.id === 'muse').callable, false);
  const r = go('Write Instagram Reels captions', env);
  assert.notEqual(r.pick, 'muse');
  assert.ok(r.flags.some((f) => f.includes('MUSE_BASE_URL')));
});

test('council uses the play council and only agents that are set up', () => {
  const ids = councilFor('Brainstorm hooks and angles', agents({ ...allKeys, XAI_API_KEY: '' }), playbook, 3);
  assert.deepEqual(ids, ['claude', 'muse', 'openai']);
});

test('more matching terms beat fewer', () => {
  const [top] = matchPlays('latest news and stats on competitors, plan', playbook);
  assert.equal(top.play.id, 'live-research');
});

test('signals are word-bounded', () => {
  assert.deepEqual(matchPlays('big figure', playbook).map((m) => m.play.id), []);
});

test('a play naming an unknown agent is rejected', () => {
  const bad = { plays: [{ id: 'x', signals: 'x', primary: 'nobody' }, { id: 'g', signals: null, primary: 'claude' }] };
  assert.throws(() => checkPlaybook(bad, agents()), /unknown agent "nobody"/);
});

test('public view never carries the key', () => {
  const a = publicAgent(agents()[0]);
  assert.equal(a.apiKey, undefined);
  assert.equal(a.configured, true);
});

test('model and base URL can be overridden from the environment', () => {
  const muse = resolveAgent(roster.agents.find((a) => a.id === 'muse'), { MUSE_MODEL: 'muse-wonder', MUSE_BASE_URL: 'https://example.test/v1' });
  assert.equal(muse.model, 'muse-wonder');
  assert.equal(muse.baseURL, 'https://example.test/v1');
  assert.equal(muse.callable, false);
});
