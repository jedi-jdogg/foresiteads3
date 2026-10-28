import Anthropic from '@anthropic-ai/sdk';

const clients = new Map();
const client = (apiKey) => {
  if (!clients.has(apiKey)) clients.set(apiKey, new Anthropic({ apiKey }));
  return clients.get(apiKey);
};

// One Claude turn. `fallbacks: "default"` lets the API re-run a safety-declined request on
// Anthropic's recommended fallback model instead of returning an empty refusal.
export async function askClaude(agent, { system, messages, effort = 'medium', outputFormat }) {
  const response = await client(agent.apiKey).beta.messages.create({
    model: agent.model,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort, ...(outputFormat ? { format: outputFormat } : {}) },
    ...(system ? { system } : {}),
    messages,
  });

  if (response.stop_reason === 'refusal') {
    const why = response.stop_details?.explanation ?? response.stop_details?.category ?? 'no reason given';
    throw new Error(`Claude declined this request (${why}).`);
  }
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  return {
    text,
    model: response.model,
    truncated: response.stop_reason === 'max_tokens',
    usage: { input: response.usage.input_tokens, output: response.usage.output_tokens },
  };
}
