import OpenAI from 'openai';

const clients = new Map();
const client = (agent) => {
  const k = `${agent.baseURL ?? 'openai'}|${agent.apiKey}`;
  if (!clients.has(k)) clients.set(k, new OpenAI({ apiKey: agent.apiKey, ...(agent.baseURL ? { baseURL: agent.baseURL } : {}) }));
  return clients.get(k);
};

const MAX_ROUNDS = 8;
const isOpenAI = (agent) => agent.api === 'responses' || !agent.baseURL || /api\.openai\.com/.test(agent.baseURL);

// OpenAI itself goes through the Responses API (its current models require it when reasoning and tools are
// both on). xAI (Grok), Meta and other OpenAI-compatible hosts use Chat Completions. Tools are passed only
// for agents that support function calling (agent.tools === true); the hub runs each call through `exec`.
export async function askOpenAICompatible(agent, req) {
  return isOpenAI(agent) ? askResponses(agent, req) : askChat(agent, req);
}

async function askResponses(agent, { system, messages, tools = [], exec, onToken }) {
  const useTools = agent.tools && tools.length && exec;
  const input = messages.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }));
  const used = [];
  let usage = { input: 0, output: 0 };
  for (let round = 0; round <= MAX_ROUNDS; round++) {
    const params = {
      model: agent.model,
      ...(system ? { instructions: system } : {}),
      input,
      ...(agent.effort ? { reasoning: { effort: agent.effort } } : {}),
      ...(useTools ? { tools: tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.input_schema })) } : {}),
    };
    let response;
    if (onToken) {
      response = null;
      for await (const ev of await client(agent).responses.create({ ...params, stream: true })) {
        if (ev.type === 'response.output_text.delta') onToken(ev.delta);
        else if (ev.type === 'response.completed' || ev.type === 'response.incomplete') response = ev.response;
        else if (ev.type === 'response.failed') throw new Error(ev.response?.error?.message ?? 'The provider reported a failure.');
        else if (ev.type === 'error') throw new Error(ev.message ?? 'Stream error.');
      }
      if (!response) throw new Error('The stream ended without a final response.');
    } else {
      response = await client(agent).responses.create(params);
    }
    usage = { input: usage.input + (response.usage?.input_tokens ?? 0), output: usage.output + (response.usage?.output_tokens ?? 0) };
    const calls = (response.output ?? []).filter((o) => o.type === 'function_call');
    if (!useTools || !calls.length || round === MAX_ROUNDS) {
      // output_text is an SDK convenience that streamed responses do not carry; read the message items.
      const text = (response.output_text ?? (response.output ?? []).filter((o) => o.type === 'message').flatMap((o) => o.content ?? []).filter((c) => c.type === 'output_text').map((c) => c.text).join('')).trim();
      return { text, model: response.model, truncated: response.status === 'incomplete', usage, used };
    }
    // Carry the model's output items forward, then answer each call with a function_call_output.
    input.push(...response.output);
    for (const call of calls) {
      let args = {};
      try { args = JSON.parse(call.arguments || '{}'); } catch {}
      const r = await exec(call.name, args);
      used.push({ name: call.name, input: args, ok: r.ok, ms: r.ms });
      input.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(r.ok ? r.result : { error: r.error }).slice(0, 60000) });
    }
  }
}

async function askChat(agent, { system, messages, tools = [], exec, onToken }) {
  const convo = [...(system ? [{ role: 'system', content: system }] : []), ...messages];
  const useTools = agent.tools && tools.length && exec;
  const used = [];
  let usage = { input: 0, output: 0 };
  for (let round = 0; round <= MAX_ROUNDS; round++) {
    const params = {
      model: agent.model,
      messages: convo,
      ...(useTools ? { tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })) } : {}),
    };
    // Chat Completions streams text well; tool-call deltas are stitched back into one message below.
    const response = onToken ? await streamChat(client(agent), params, onToken) : await client(agent).chat.completions.create(params);
    usage = { input: usage.input + (response.usage?.prompt_tokens ?? 0), output: usage.output + (response.usage?.completion_tokens ?? 0) };
    const choice = response.choices[0];
    const calls = choice?.message?.tool_calls ?? [];
    if (!useTools || !calls.length || round === MAX_ROUNDS) {
      let text = choice?.message?.content?.trim() ?? '';
      const sources = response.citations ?? response.search_results?.map((r) => r.url);
      if (sources?.length) text += '\n\nSources:\n' + sources.map((u, i) => `[${i + 1}] ${u}`).join('\n');
      return { text, model: response.model, truncated: choice?.finish_reason === 'length', usage, used };
    }
    convo.push(choice.message);
    for (const call of calls) {
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch {}
      const r = await exec(call.function.name, args);
      used.push({ name: call.function.name, input: args, ok: r.ok, ms: r.ms });
      convo.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(r.ok ? r.result : { error: r.error }).slice(0, 60000) });
    }
  }
}

// Collect a streamed Chat Completion into the same shape a non-streamed one has.
async function streamChat(c, params, onToken) {
  const withUsage = /api\.openai\.com|api\.x\.ai/.test(c.baseURL ?? '');
  const stream = await c.chat.completions.create({ ...params, stream: true, ...(withUsage ? { stream_options: { include_usage: true } } : {}) });
  const msg = { role: 'assistant', content: '', tool_calls: [] };
  let finish = null, model = params.model, usage, extra = {};
  for await (const chunk of stream) {
    if (chunk.usage) usage = chunk.usage;
    if (chunk.model) model = chunk.model;
    if (chunk.citations) extra.citations = chunk.citations;
    const ch = chunk.choices?.[0];
    if (!ch) continue;
    if (ch.finish_reason) finish = ch.finish_reason;
    const d = ch.delta ?? {};
    if (d.content) { msg.content += d.content; onToken(d.content); }
    for (const tc of d.tool_calls ?? []) {
      const slot = (msg.tool_calls[tc.index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.function.name += tc.function.name;
      if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
    }
  }
  if (!msg.tool_calls.length) delete msg.tool_calls;
  return { model, usage, ...extra, choices: [{ message: msg, finish_reason: finish }] };
}

// The image models this account can use, newest first, asked of OpenAI rather than remembered.
export async function imageModels(agent) {
  const page = await client(agent).models.list();
  return page.data.filter((m) => /^gpt-image/.test(m.id) && !/edit/.test(m.id)).sort((x, y) => (y.created ?? 0) - (x.created ?? 0)).map((m) => m.id);
}

// A picture from OpenAI's image model. Tries the preferred model, then whatever image models the account
// lists, newest first, so a renamed model never leaves the hub unable to make a picture.
export async function makeImage(agent, { prompt, size = '1024x1024', model }) {
  const tried = [];
  const candidates = [...(model ? [model] : []), ...(await imageModels(agent).catch(() => [])), 'gpt-image-2', 'gpt-image-1.5', 'gpt-image-1'];
  let lastErr;
  for (const m of [...new Set(candidates)]) {
    try {
      const r = await client(agent).images.generate({ model: m, prompt, size, n: 1 });
      const d = r.data?.[0];
      if (!d?.b64_json) throw new Error('No image came back.');
      return { b64: d.b64_json, revisedPrompt: d.revised_prompt, model: m, tried };
    } catch (err) {
      lastErr = err;
      tried.push(m);
      const missing = err.status === 404 || /does not exist|not found|unsupported model|invalid model/i.test(err.message ?? '');
      if (!missing) throw err;
    }
  }
  throw new Error(`No image model worked (tried ${tried.join(', ')}): ${lastErr?.message ?? 'unknown error'}`);
}

// Speech to text through OpenAI. A fixed preference list is checked against what the account lists (cached
// for ten minutes), so a renamed model falls through to the next one instead of failing the voice turn.
const TRANSCRIBE_PREFER = ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1'];
const listedCache = new WeakMap();
async function transcribeModels(c) {
  const hit = listedCache.get(c);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.ids;
  const ids = await c.models.list().then((p) => p.data.map((m) => m.id)).catch(() => []);
  listedCache.set(c, { at: Date.now(), ids });
  return ids;
}
export async function transcribe(agent, { bytes, filename = 'speech.webm', type, language }) {
  const c = client(agent);
  const listed = await transcribeModels(c);
  const env = process.env.OPENAI_TRANSCRIBE_MODEL;
  const candidates = [...new Set([...(env ? [env] : []), ...TRANSCRIBE_PREFER.filter((m) => !listed.length || listed.includes(m)), ...TRANSCRIBE_PREFER])];
  const file = await OpenAI.toFile(bytes, filename, type ? { type } : undefined);
  let lastErr;
  for (const model of candidates) {
    try {
      const r = await c.audio.transcriptions.create({ model, file, ...(language ? { language } : {}) });
      return { text: (r.text ?? '').trim(), model };
    } catch (err) {
      lastErr = err;
      const modelProblem = err.status === 404 || err.status === 403 || /does not exist|not found|invalid model|model/i.test(err.message ?? '');
      if (err.status === 401 || !modelProblem) throw err;
    }
  }
  throw new Error(`No transcription model worked: ${lastErr?.message ?? 'unknown error'}`);
}
