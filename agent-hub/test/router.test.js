import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { route, councilFor, detectSignals } from '../src/router.js';
import { resolveAgent, publicAgent } from '../src/registry.js';

const roster = JSON.parse(await readFile(new URL('../agents.json', import.meta.url), 'utf8'));
const allKeys = Object.fromEntries(roster.agents.map((a) => [a.keyEnv, 'test-key']));
const agents = (env = allKeys) => roster.agents.map((a) => resolveAgent(a, env));

test('research questions go to Perplexity', () => {
  assert.equal(route('Research the latest market size for long-arm quilting machines and cite sources', agents()).pick, 'perplexity');
});

test('X / Twitter sentiment goes to Grok', () => {
  assert.equal(route('What is the sentiment on Twitter about our new launch, is it trending?', agents()).pick, 'grok');
});

test('Instagram and Reels work goes to Meta', () => {
  assert.equal(route('Give me five Instagram Reels hooks for a fabric sale', agents()).pick, 'meta');
});

test('image work goes to OpenAI', () => {
  assert.equal(route('Make a logo image for the spring campaign', agents()).pick, 'openai');
});

test('video work is handed off to Muse.ai', () => {
  const r = route('Find the clip in the webinar recording video where we talk about pricing', agents());
  assert.equal(r.pick, 'museai');
});

test('strategy and writing go to Claude', () => {
  assert.equal(route('Draft a strategy memo: should we prioritize email or CTV next quarter?', agents()).pick, 'claude');
});

test('no signal falls back to the lead agent', () => {
  const r = route('hello there', agents());
  assert.equal(r.pick, 'claude');
  assert.deepEqual(r.signals, []);
});

test('connector and machine requests are flagged', () => {
  const r = route('Pull last week Shopify orders and run it on the Mac', agents());
  assert.equal(r.pick, 'claude');
  assert.equal(r.flags.length, 2);
});

test('best agent without a key falls through to a configured one and says so', () => {
  const env = { ...allKeys, PERPLEXITY_API_KEY: '' };
  const r = route('Research the latest news on Shopify fees and cite sources', agents(env));
  assert.notEqual(r.pick, 'perplexity');
  assert.ok(r.flags.some((f) => f.includes('Perplexity')));
});

test('council always includes the lead and only callable agents', () => {
  const ids = councilFor('Brainstorm viral Instagram ideas trending on X', agents(), 3);
  assert.equal(ids.length, 3);
  assert.ok(ids.includes('claude'));
  assert.ok(!ids.includes('museai'));
});

test('signals are word-bounded', () => {
  assert.deepEqual(detectSignals('big signal').map((s) => s.skill), []);
});

test('public view never carries the key', () => {
  const a = publicAgent(agents()[0]);
  assert.equal(a.apiKey, undefined);
  assert.equal(a.configured, true);
});

test('model and base URL can be overridden from the environment', () => {
  const meta = resolveAgent(roster.agents.find((a) => a.id === 'meta'), { META_MODEL: 'muse-1', META_BASE_URL: 'https://example.test/v1' });
  assert.equal(meta.model, 'muse-1');
  assert.equal(meta.baseURL, 'https://example.test/v1');
  assert.equal(meta.callable, false);
});
