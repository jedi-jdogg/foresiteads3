import OpenAI from 'openai';

const clients = new Map();
const client = (agent) => {
  const k = `${agent.baseURL ?? 'openai'}|${agent.apiKey}`;
  if (!clients.has(k)) clients.set(k, new OpenAI({ apiKey: agent.apiKey, ...(agent.baseURL ? { baseURL: agent.baseURL } : {}) }));
  return clients.get(k);
};

// OpenAI, xAI (Grok), Perplexity and Meta's Llama API all accept the Chat Completions shape.
export async function askOpenAICompatible(agent, { system, messages }) {
  const response = await client(agent).chat.completions.create({
    model: agent.model,
    messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages],
  });
  const choice = response.choices[0];
  let text = choice?.message?.content?.trim() ?? '';
  // Perplexity returns its sources alongside the answer; keep them visible.
  const sources = response.citations ?? response.search_results?.map((r) => r.url);
  if (sources?.length) text += '\n\nSources:\n' + sources.map((u, i) => `[${i + 1}] ${u}`).join('\n');
  return {
    text,
    model: response.model,
    truncated: choice?.finish_reason === 'length',
    usage: { input: response.usage?.prompt_tokens, output: response.usage?.completion_tokens },
  };
}
