import OpenAI from 'openai';

const clients = new Map();
const client = (agent) => {
  const k = `${agent.baseURL ?? 'openai'}|${agent.apiKey}`;
  if (!clients.has(k)) clients.set(k, new OpenAI({ apiKey: agent.apiKey, ...(agent.baseURL ? { baseURL: agent.baseURL } : {}) }));
  return clients.get(k);
};

const MAX_ROUNDS = 8;

// OpenAI, xAI (Grok), Perplexity and Meta's API all accept the Chat Completions shape. Tools are passed
// only for agents that support function calling (agent.tools === true); the loop mirrors the Claude one.
export async function askOpenAICompatible(agent, { system, messages, tools = [], exec }) {
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
      // Perplexity returns its sources alongside the answer; keep them visible.
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
