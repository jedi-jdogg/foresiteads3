// Composio: 500+ apps (Gmail, Slack, Notion, HubSpot, Google Sheets, GitHub…) through one key.
// A Tool Router session gives an MCP endpoint whose tools search Composio's catalogue, connect accounts
// (it returns a link to click) and run actions. The hub keeps the session id in .env so it is reused.
import { getJson } from './registry.js';
import { saveEnv } from '../registry.js';

const API = 'https://backend.composio.dev/api/v3.1';
const connections = new Map();

async function session(creds) {
  const key = creds.COMPOSIO_API_KEY, user = creds.COMPOSIO_USER_ID || 'jonathan';
  const k = `${key}|${user}`;
  if (connections.has(k)) return connections.get(k);
  let s = null;
  if (creds.COMPOSIO_SESSION_ID) {
    s = await getJson(`${API}/tool_router/session/${encodeURIComponent(creds.COMPOSIO_SESSION_ID)}`, { headers: { 'x-api-key': key } }).catch(() => null);
  }
  if (!s?.mcp?.url) {
    s = await getJson(`${API}/tool_router/session`, { method: 'POST', headers: { 'x-api-key': key }, body: { user_id: user } });
    if (!s?.mcp?.url) throw new Error(`Composio answered without an MCP endpoint: ${JSON.stringify(s).slice(0, 200)}`);
    if (s.session_id) await saveEnv({ COMPOSIO_SESSION_ID: s.session_id }).catch(() => {});
  }
  const headers = { ...(s.mcp.headers ?? {}) };
  if (!Object.keys(headers).some((h) => h.toLowerCase() === 'x-api-key' || h.toLowerCase() === 'authorization')) headers['x-api-key'] = key;
  const conn = { url: s.mcp.url, headers, sessionId: s.session_id };
  connections.set(k, conn);
  return conn;
}

async function rpc(conn, method, params, retried = false) {
  const res = await fetch(conn.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...conn.headers, ...(conn.mcpSession ? { 'mcp-session-id': conn.mcpSession } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  // An expired MCP session comes back 404: start a fresh one (initialize again) and retry once.
  if (res.status === 404 && conn.mcpSession && !retried) { conn.mcpSession = null; conn.initialized = false; await init(conn); return rpc(conn, method, params, true); }
  if (!res.ok) throw new Error(`Composio MCP ${method}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  conn.mcpSession = res.headers.get('mcp-session-id') ?? conn.mcpSession;
  const text = await res.text();
  if (res.status === 202 || !text.trim()) return {};
  const payload = sseBody(res, text);
  const json = JSON.parse(payload);
  if (json.error) throw new Error(`Composio: ${json.error.message}`);
  return json.result ?? {};
}

// Streamable HTTP answers as SSE or plain JSON; decide by the content type, never by the body text.
export function sseBody(res, text) {
  if (!/text\/event-stream/i.test(res.headers.get('content-type') ?? '')) return text;
  return text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean).pop() ?? '{}';
}

async function init(conn) {
  conn.initialized = true;   // set first so the initialize call itself is not retried into a loop
  await rpc(conn, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'foresite-agent-hub', version: '2.0' } });
  await rpc(conn, 'notifications/initialized', {}).catch(() => {});
}
async function ready(creds) {
  const conn = await session(creds);
  if (!conn.initialized) await init(conn);
  return conn;
}

export async function test(creds) {
  const conn = await ready(creds);
  const r = await rpc(conn, 'tools/list', {});
  const names = (r.tools ?? []).map((t) => t.name);
  return `Composio session ready: ${names.length} router tools (${names.slice(0, 4).join(', ')}${names.length > 4 ? '…' : ''}). Connect apps at app.composio.dev or ask an agent to connect one.`;
}

export async function tools(creds) {
  const conn = await ready(creds);
  const r = await rpc(conn, 'tools/list', {});
  return (r.tools ?? []).map((t) => ({
    name: t.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60),
    description: (t.description ?? t.name).slice(0, 1000),
    input_schema: t.inputSchema ?? { type: 'object', properties: {} },
    async run(args) {
      const out = await rpc(conn, 'tools/call', { name: t.name, arguments: args ?? {} });
      if (out.isError) throw new Error((out.content ?? []).map((c) => c.text).join('\n') || 'Composio tool error');
      const text = (out.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      try { return JSON.parse(text); } catch { return text; }
    },
  }));
}
