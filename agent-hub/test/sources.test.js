import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { loadSources, resolveSource, publicSource, Sources } from '../src/sources/registry.js';
import { tools as shopifyTools } from '../src/sources/shopify.js';
import { askClaude } from '../src/providers/anthropic.js';
import { askOpenAICompatible } from '../src/providers/openai-compatible.js';

const defs = await loadSources();

test('every source has a module, envs and a valid mentions pattern', () => {
  for (const s of defs) {
    assert.ok(s.module && Array.isArray(s.envs), s.id);
    if (s.mentions) new RegExp(s.mentions, 'i');
  }
});

test('a source is connected only when its required envs are set', () => {
  const shopify = defs.find((s) => s.id === 'shopify');
  assert.equal(resolveSource(shopify, {}).connected, false);
  assert.deepEqual(resolveSource(shopify, { SHOPIFY_STORE: 'x' }).missing, ['SHOPIFY_ADMIN_TOKEN']);
  assert.equal(resolveSource(shopify, { SHOPIFY_STORE: 'x', SHOPIFY_ADMIN_TOKEN: 'y' }).connected, true);
});

test('an OAuth source with client creds but no refresh token needs sign-in, not more fields', () => {
  const google = defs.find((s) => s.id === 'google');
  const r = resolveSource(google, { GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b', GA4_PROPERTY_ID: '1' });
  assert.equal(r.connected, false);
  assert.equal(r.needsAuth, true);
  assert.equal(resolveSource(google, { GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b', GA4_PROPERTY_ID: '1', GOOGLE_REFRESH_TOKEN: 'r' }).connected, true);
});

test('public view carries which fields are set, never the values', () => {
  const p = publicSource(resolveSource(defs.find((s) => s.id === 'klaviyo'), { KLAVIYO_API_KEY: 'pk_secret' }));
  assert.equal(p.creds, undefined);
  assert.deepEqual(p.set, { KLAVIYO_API_KEY: true });
});

test('tools are namespaced by source and all have JSON schemas', async () => {
  const src = new Sources(defs, { SHOPIFY_STORE: 'x', SHOPIFY_ADMIN_TOKEN: 'y', KLAVIYO_API_KEY: 'k' });
  const tools = await src.tools();
  assert.ok(tools.some((t) => t.name === 'shopify__sales_summary'));
  assert.ok(tools.some((t) => t.name === 'klaviyo__flows'));
  for (const t of tools) assert.equal(t.input_schema.type, 'object', t.name);
});

test('mentions pick the sources a request talks about', () => {
  const src = new Sources(defs, { SHOPIFY_STORE: 'x', SHOPIFY_ADMIN_TOKEN: 'y', KLAVIYO_API_KEY: 'k' });
  assert.deepEqual(src.mentioned('How were sales last week?').map((s) => s.id), ['shopify']);
  assert.deepEqual(src.mentioned('Which email campaigns did best?').map((s) => s.id), ['klaviyo']);
  assert.deepEqual(src.mentioned('tell me a joke').map((s) => s.id), []);
});

// A stand-in Shopify Admin API, Anthropic Messages API and Chat Completions API on one port.
function standIn() {
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const json = body ? JSON.parse(body) : {};
    seen.push({ url: req.url, json });
    res.setHeader('content-type', 'application/json');
    if (req.url.includes('/admin/api/')) {
      if (json.query.includes('shop {')) return res.end(JSON.stringify({ data: { shop: { name: "Linda's", myshopifyDomain: 'lindas.myshopify.com', plan: { displayName: 'Plus' } } } }));
      const order = (n, amt) => ({ id: `o${n}`, name: `#${n}`, createdAt: new Date().toISOString(), cancelledAt: null, currentTotalPriceSet: { shopMoney: { amount: amt } }, currentSubtotalPriceSet: { shopMoney: { amount: amt } }, totalDiscountsSet: { shopMoney: { amount: '0' } }, customer: { id: 'c', numberOfOrders: '1' }, channelInformation: { channelDefinition: { channelName: 'Online Store' } }, lineItems: { nodes: [{ title: 'Batting', quantity: 1, sku: 'B', product: { id: 'p1', title: 'Batting', vendor: 'Hobbs', productType: 'Batting' }, originalUnitPriceSet: { shopMoney: { amount: amt } } }] } });
      return res.end(JSON.stringify({ data: { orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [order(1, '100'), order(2, '50')] } } }));
    }
    if (req.url.endsWith('/v1/messages')) {
      const last = json.messages.at(-1);
      if (last.role === 'user' && typeof last.content === 'string') {
        return res.end(JSON.stringify({ id: 'm1', type: 'message', role: 'assistant', model: json.model, stop_reason: 'tool_use', stop_details: null, usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: 'text', text: 'Let me check.' }, { type: 'tool_use', id: 't1', name: 'shopify__sales_summary', input: { days: 7 } }] }));
      }
      const result = JSON.parse(last.content[0].content);
      return res.end(JSON.stringify({ id: 'm2', type: 'message', role: 'assistant', model: json.model, stop_reason: 'end_turn', stop_details: null, usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: 'text', text: `Revenue was $${result.current.revenue} across ${result.current.orders} orders.` }] }));
    }
    if (req.url.endsWith('/responses')) {
      const last = json.input.at(-1);
      if (last.type !== 'function_call_output') {
        return res.end(JSON.stringify({ id: 'r1', model: json.model, status: 'completed', usage: {}, output: [{ type: 'function_call', call_id: 'c1', name: 'shopify__sales_summary', arguments: '{"days":7}' }] }));
      }
      const result = JSON.parse(last.output);
      return res.end(JSON.stringify({ id: 'r2', model: json.model, status: 'completed', usage: {}, output_text: `GPT: ${result.current.orders} orders`, output: [{ type: 'message', content: [{ type: 'output_text', text: `GPT: ${result.current.orders} orders` }] }] }));
    }
    if (req.url.endsWith('/chat/completions')) {
      const last = json.messages.at(-1);
      if (last.role !== 'tool') {
        return res.end(JSON.stringify({ id: 'c1', model: json.model, usage: {}, choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call1', type: 'function', function: { name: 'shopify__sales_summary', arguments: '{"days":7}' } }] } }] }));
      }
      const result = JSON.parse(last.content);
      return res.end(JSON.stringify({ id: 'c2', model: json.model, usage: {}, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: `GPT: ${result.current.orders} orders` } }] }));
    }
    res.statusCode = 404; res.end('{}');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen })));
}

test('Claude and an OpenAI-compatible agent can both call a Shopify tool and answer from the result', async (t) => {
  const { server, port, seen } = await standIn();
  t.after(() => server.close());
  // Point the Shopify module at the stand-in by overriding fetch for *.myshopify.com.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => realFetch(String(url).replace(/^https:\/\/[^/]+\.myshopify\.com/, `http://127.0.0.1:${port}`), opts);
  t.after(() => { globalThis.fetch = realFetch; });

  const src = new Sources(defs, { SHOPIFY_STORE: 'lindas', SHOPIFY_ADMIN_TOKEN: 'tok' });
  const tools = await src.tools();
  const exec = (name, input) => src.call(name, input);

  const claude = { id: 'claude', provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'k', tools: true };
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  const a = await askClaude(claude, { system: 'x', messages: [{ role: 'user', content: 'How were sales this week?' }], tools, exec });
  assert.equal(a.text, 'Revenue was $150 across 2 orders.');
  assert.equal(a.used[0].name, 'shopify__sales_summary');
  assert.equal(a.used[0].ok, true);
  const toolRequest = seen.find((s) => s.url.endsWith('/v1/messages'));
  assert.ok(toolRequest.json.tools.some((x) => x.name === 'shopify__sales_summary'));

  // Grok-style host: Chat Completions with tool calls.
  const gpt = { id: 'grok', provider: 'openai-compatible', model: 'grok-4.6', apiKey: 'k', baseURL: `http://127.0.0.1:${port}/v1`, tools: true };
  const b = await askOpenAICompatible(gpt, { system: 'x', messages: [{ role: 'user', content: 'How were sales this week?' }], tools, exec });
  assert.equal(b.text, 'GPT: 2 orders');
  assert.equal(b.used.length, 1);
  // OpenAI itself: the Responses API, with reasoning effort and function tools in the new shape.
  const oai = { id: 'openai', provider: 'openai-compatible', model: 'gpt-6-astra', apiKey: 'k', baseURL: `http://127.0.0.1:${port}/api.openai.com/v1`, tools: true, effort: 'medium' };
  seen.length = 0;
  const c = await askOpenAICompatible(oai, { system: 'brief', messages: [{ role: 'user', content: 'Sales?' }], tools, exec });
  assert.equal(c.text, 'GPT: 2 orders');
  assert.equal(c.used[0].name, 'shopify__sales_summary');
  const first = seen.find((x) => x.url.endsWith('/responses')).json;
  assert.equal(first.instructions, 'brief');
  assert.deepEqual(first.reasoning, { effort: 'medium' });
  assert.equal(first.tools[0].type, 'function');
  assert.equal(first.tools[0].name, 'shopify__sales_summary');
  assert.equal(first.tools[0].parameters.type, 'object');

  // An agent without tool support gets no tools in its request.
  const pplx = { ...gpt, id: 'perplexity', tools: false };
  seen.length = 0;
  await askOpenAICompatible(pplx, { system: 'x', messages: [{ role: 'user', content: 'hi' }], tools, exec }).catch(() => {});
  assert.equal(seen[0].json.tools, undefined);

  // Shopify test() reads the shop.
  const info = await src.test('shopify');
  assert.equal(info.ok, true);
  assert.match(info.summary, /Linda's/);
});

test('shopify tools expose the expected set', async () => {
  const names = (await shopifyTools({ SHOPIFY_STORE: 'x', SHOPIFY_ADMIN_TOKEN: 'y' })).map((t) => t.name);
  assert.deepEqual(names, ['sales_summary', 'top_products', 'search_products', 'recent_orders', 'low_stock']);
});

test('Perplexity Agent API: preset request, output_text and search_results sources', async (t) => {
  const { askPerplexity } = await import('../src/providers/perplexity.js');
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    seen.push({ url: req.url, auth: req.headers.authorization, json: JSON.parse(body) });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'r1', status: 'completed', model: 'perplexity/sonar', usage: { input_tokens: 5, output_tokens: 7 },
      output: [
        { type: 'search_results', results: [{ url: 'https://example.com/a', title: 'A' }, { url: 'https://example.com/b' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'CPMs rose 12% in Q4.', annotations: [] }] },
      ] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const agent = { id: 'perplexity', provider: 'perplexity', apiKey: 'pplx-k', model: 'preset:fast', baseURL: `http://127.0.0.1:${server.address().port}/v1` };
  const out = await askPerplexity(agent, { system: 'brief', messages: [{ role: 'user', content: 'Are Meta CPMs up?' }] });
  assert.equal(seen[0].url, '/v1/agent');
  assert.equal(seen[0].auth, 'Bearer pplx-k');
  assert.equal(seen[0].json.preset, 'fast');
  assert.equal(seen[0].json.tools, undefined);
  assert.equal(seen[0].json.instructions, 'brief');
  assert.deepEqual(seen[0].json.input, [{ role: 'user', content: 'Are Meta CPMs up?' }]);
  assert.match(out.text, /^CPMs rose 12% in Q4\./);
  assert.match(out.text, /\[1\] https:\/\/example.com\/a\n\[2\] https:\/\/example.com\/b$/);

  // A model slug adds the web_search tool.
  await askPerplexity({ ...agent, model: 'perplexity/sonar' }, { messages: [{ role: 'user', content: 'x' }] });
  assert.equal(seen[1].json.model, 'perplexity/sonar');
  assert.deepEqual(seen[1].json.tools, [{ type: 'web_search' }]);
});

test('the image play on ChatGPT makes a picture through the image API', async (t) => {
  const { makeImage } = await import('../src/providers/openai-compatible.js');
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    seen.push({ url: req.url, json: JSON.parse(body) });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ created: 1, data: [{ b64_json: Buffer.from('png-bytes').toString('base64'), revised_prompt: 'a batting roll on a quilt' }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const agent = { id: 'openai', apiKey: 'k', baseURL: `http://127.0.0.1:${server.address().port}/v1` };
  const img = await makeImage(agent, { prompt: 'A batting roll on a quilt, product shot' });
  assert.equal(seen[0].url, '/v1/images/generations');
  assert.equal(seen[0].json.model, 'gpt-image-1');
  assert.equal(Buffer.from(img.b64, 'base64').toString(), 'png-bytes');
  assert.equal(img.revisedPrompt, 'a batting roll on a quilt');
});
