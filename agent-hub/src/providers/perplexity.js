// Perplexity Agent API (replaced the Sonar chat-completions endpoint in September 2026).
// POST https://api.perplexity.ai/v1/agent with either a preset ("fast", "low", "medium", "high", "xhigh")
// or a model slug such as "perplexity/sonar" plus a web_search tool. Text comes back in output_text or
// output[].content[], and sources in an output[] item of type search_results.

const DEFAULT_BASE = 'https://api.perplexity.ai/v1';

export async function askPerplexity(agent, { system, messages }) {
  const base = (agent.baseURL ?? DEFAULT_BASE).replace(/\/$/, '');
  const body = {
    input: messages.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) })),
    ...(system ? { instructions: system } : {}),
  };
  // "preset:fast" selects a preset (which bundles web search); any other value is a model slug needing the tool.
  if (agent.model.startsWith('preset:')) body.preset = agent.model.slice(7);
  else { body.model = agent.model; body.tools = [{ type: 'web_search' }]; }

  const res = await fetch(`${base}/agent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', Authorization: `Bearer ${agent.apiKey}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = {}; }
  if (!res.ok) {
    const err = new Error(`${res.status}: ${json.error?.message ?? json.detail ?? text.slice(0, 200)}`);
    err.status = res.status; throw err;
  }
  if (json.status === 'failed' || json.status === 'cancelled') {
    throw new Error(`Perplexity run ${json.status}: ${json.error?.message ?? 'no detail'}`);
  }

  let answer = json.output_text ?? '';
  const sources = [];
  for (const item of json.output ?? []) {
    if (!answer && item.type === 'message') answer = (item.content ?? []).filter((c) => c.type === 'output_text').map((c) => c.text).join('\n');
    if (item.type === 'search_results') for (const r of item.results ?? []) if (r.url) sources.push(r.url);
    if (item.type === 'message') for (const c of item.content ?? []) for (const a of c.annotations ?? []) if (a.url) sources.push(a.url);
  }
  answer = answer.trim();
  const unique = [...new Set(sources)];
  if (unique.length) answer += '\n\nSources:\n' + unique.map((u, i) => `[${i + 1}] ${u}`).join('\n');
  return {
    text: answer,
    model: json.model ?? body.preset ?? body.model,
    truncated: json.incomplete_details?.reason === 'max_output_tokens',
    usage: { input: json.usage?.input_tokens, output: json.usage?.output_tokens },
    used: [],
  };
}
