import Anthropic from '@anthropic-ai/sdk';

const clients = new Map();
const client = (apiKey) => {
  if (!clients.has(apiKey)) clients.set(apiKey, new Anthropic({ apiKey }));
  return clients.get(apiKey);
};

const MAX_ROUNDS = 8;

// One Claude turn, with an optional tool loop: when `tools` are given, Claude may call them and the hub
// runs each through `exec(name, input)`, feeding results back until Claude answers in text.
// `fallbacks: "default"` lets the API re-run a safety-declined request on Anthropic's recommended
// fallback model instead of returning an empty refusal.
export async function askClaude(agent, { system, messages, effort = 'medium', outputFormat, tools = [], exec }) {
  const c = client(agent.apiKey);
  const convo = [...messages];
  const used = [];
  let usage = { input: 0, output: 0 };
  for (let round = 0; round <= MAX_ROUNDS; round++) {
    const response = await c.beta.messages.create({
      model: agent.model,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort, ...(outputFormat ? { format: outputFormat } : {}) },
      ...(system ? { system } : {}),
      ...(tools.length ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })) } : {}),
      messages: convo,
    });
    usage = { input: usage.input + response.usage.input_tokens, output: usage.output + response.usage.output_tokens };

    if (response.stop_reason === 'refusal') {
      const why = response.stop_details?.explanation ?? response.stop_details?.category ?? 'no reason given';
      throw new Error(`Claude declined this request (${why}).`);
    }
    const calls = response.content.filter((b) => b.type === 'tool_use');
    if (response.stop_reason !== 'tool_use' || !calls.length || !exec || round === MAX_ROUNDS) {
      const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      return { text, model: response.model, truncated: response.stop_reason === 'max_tokens', usage, used };
    }
    // Pass the whole assistant turn back unchanged (thinking blocks included), then every result in one user turn.
    convo.push({ role: 'assistant', content: response.content });
    const results = await Promise.all(calls.map(async (call) => {
      const r = await exec(call.name, call.input ?? {});
      used.push({ name: call.name, input: call.input, ok: r.ok, ms: r.ms });
      return { type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(r.ok ? r.result : { error: r.error }).slice(0, 60000), ...(r.ok ? {} : { is_error: true }) };
    }));
    convo.push({ role: 'user', content: results });
  }
}
