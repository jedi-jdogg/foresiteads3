import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { route, councilFor, detectSignals } from '../src/router.js';
import { resolveAgent, publicAgent } from '../src/registry.js';

const roster = JSON.parse(await readFile(new URL('../agents.json', import.meta.url), 'utf8'));
const allKeys = { ...Object.fromEntries(roster.agents.map((a) => [a.keyEnv, 'test-key'])), MUSE_BASE_URL: 'https://muse.test/v1' };
const agents = (env = allKeys) => roster.agents.map((a) => resolveAgent(a, env));

test('research questions go to Perplexity', () => {
  assert.equal(route('Research the latest market size for long-arm quilting machines and cite sources', agents()).pick, 'perplexity');
});

test('X / Twitter sentiment goes to Grok', () => {
  assert.equal(route('What is the sentiment on Twitter about our new launch, is it trending?', agents()).pick, 'grok');
});

test('Instagram and Reels work goes to Muse', () => {
  assert.equal(route('Give me five Instagram Reels hooks for a fabric sale', agents()).pick, 'muse');
});

test('image work goes to OpenAI', () => {
  assert.equal(route('Make a logo image for the spring campaign', agents()).pick, 'openai');
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
  assert.ok(r.flags.some((f) => f.includes('Perplexity') && f.includes('PERPLEXITY_API_KEY')));
});

test('council always includes the lead and only callable agents', () => {
  const ids = councilFor('Brainstorm viral Instagram ideas trending on X', agents(), 3);
  assert.equal(ids.length, 3);
  assert.ok(ids.includes('claude'));
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
  const muse = resolveAgent(roster.agents.find((a) => a.id === 'muse'), { MUSE_MODEL: 'muse-wonder', MUSE_BASE_URL: 'https://example.test/v1' });
  assert.equal(muse.model, 'muse-wonder');
  assert.equal(muse.baseURL, 'https://example.test/v1');
  assert.equal(muse.callable, false);
});

test('Muse is not callable with a key but no endpoint, and the flag names the endpoint', () => {
  const env = { ...allKeys, MUSE_BASE_URL: '' };
  assert.equal(agents(env).find((a) => a.id === 'muse').callable, false);
  const r = route('Instagram reels hooks', agents(env));
  assert.notEqual(r.pick, 'muse');
  assert.ok(r.flags.some((f) => f.includes('MUSE_BASE_URL')));
});
