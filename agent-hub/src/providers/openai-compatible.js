import OpenAI from 'openai';

const clients = new Map();
const client = (agent) => {
  const k = `${agent.baseURL ?? 'openai'}|${agent.apiKey}`;
  if (!clients.has(k)) clients.set(k, new OpenAI({ apiKey: agent.apiKey, ...(agent.baseURL ? { baseURL: agent.baseURL } : {}) }));
  return clients.get(k);
};

const MAX_ROUNDS = 8;
const isOpenAI = (agent) => !agent.baseURL || /api\.openai\.com/.test(agent.baseURL);

// OpenAI itself goes through the Responses API (its current models require it when reasoning and tools are
// both on). xAI (Grok), Meta and other OpenAI-compatible hosts use Chat Completions. Tools are passed only
// for agents that support function calling (agent.tools === true); the hub runs each call through `exec`.
export async function askOpenAICompatible(agent, req) {
  return isOpenAI(agent) ? askResponses(agent, req) : askChat(agent, req);
}

async function askResponses(agent, { system, messages, tools = [], exec }) {
  const useTools = agent.tools && tools.length && exec;
  const input = messages.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }));
  const used = [];
  let usage = { input: 0, output: 0 };
  for (let round = 0; round <= MAX_ROUNDS; round++) {
    const response = await client(agent).responses.create({
      model: agent.model,
      ...(system ? { instructions: system } : {}),
      input,
      ...(agent.effort ? { reasoning: { effort: agent.effort } } : {}),
      ...(useTools ? { tools: tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.input_schema })) } : {}),
    });
    usage = { input: usage.input + (response.usage?.input_tokens ?? 0), output: usage.output + (response.usage?.output_tokens ?? 0) };
    const calls = (response.output ?? []).filter((o) => o.type === 'function_call');
    if (!useTools || !calls.length || round === MAX_ROUNDS) {
      const text = (response.output_text ?? '').trim();
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

async function askChat(agent, { system, messages, tools = [], exec }) {
  const convo = [...(system ? [{ role: 'system', content: system }] : []), ...messages];
  const useTools = agent.tools && tools.length && exec;
  const used = [];
  let usage = { input: 0, output: 0 };
  for (let round = 0; round <= MAX_ROUNDS; round++) {
    const response = await client(agent).chat.completions.create({
      model: agent.model,
      messages: convo,
      ...(useTools ? { tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })) } : {}),
    });
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

// A picture from OpenAI's image model. Returns PNG bytes (base64) plus the prompt the model actually used.
export async function makeImage(agent, { prompt, size = '1024x1024', model = 'gpt-image-1' }) {
  const r = await client(agent).images.generate({ model, prompt, size, n: 1 });
  const d = r.data?.[0];
  if (!d?.b64_json) throw new Error('No image came back.');
  return { b64: d.b64_json, revisedPrompt: d.revised_prompt, model };
}
