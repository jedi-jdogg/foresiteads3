// Generic MCP client (Streamable HTTP, JSON-RPC). Any vendor that publishes an MCP server
// (Foresite, Vibe, Klaviyo, Triple Whale…) plugs in with a URL and a token; its tools become hub tools.

async function rpc(url, token, method, params, session) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(session ? { 'mcp-session-id': session } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  if (!res.ok) throw new Error(`MCP ${method}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const sid = res.headers.get('mcp-session-id') ?? session;
  const text = await res.text();
  // Streamable HTTP may answer as SSE (by content type); take the last JSON data line.
  const payload = /text\/event-stream/i.test(res.headers.get('content-type') ?? '')
    ? (text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean).pop() ?? '{}')
    : text;
  const json = JSON.parse(payload);
  if (json.error) throw new Error(`MCP ${method}: ${json.error.message}`);
  return { result: json.result, session: sid };
}

const sessions = new Map();
async function connect(creds, source) {
  const url = creds[source.envs[0].key], token = creds[source.envs[1]?.key];
  const k = `${url}|${token}`;
  if (sessions.has(k)) return sessions.get(k);
  const { session } = await rpc(url, token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'foresite-agent-hub', version: '1.0' } });
  await rpc(url, token, 'notifications/initialized', {}, session).catch(() => {});
  const conn = { url, token, session };
  sessions.set(k, conn);
  return conn;
}

export async function test(creds, source) {
  const c = await connect(creds, source);
  const { result } = await rpc(c.url, c.token, 'tools/list', {}, c.session);
  return `${source.name}: ${result.tools?.length ?? 0} tools available`;
}

export async function tools(creds, source) {
  const c = await connect(creds, source);
  const { result } = await rpc(c.url, c.token, 'tools/list', {}, c.session);
  return (result.tools ?? []).map((t) => ({
    name: t.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 56),
    description: t.description ?? t.name,
    input_schema: t.inputSchema ?? { type: 'object', properties: {} },
    async run(args) {
      const { result: r } = await rpc(c.url, c.token, 'tools/call', { name: t.name, arguments: args }, c.session);
      if (r.isError) throw new Error(r.content?.map((x) => x.text).join('\n') ?? 'tool error');
      const text = (r.content ?? []).filter((x) => x.type === 'text').map((x) => x.text).join('\n');
      try { return JSON.parse(text); } catch { return text; }
    },
  }));
}
