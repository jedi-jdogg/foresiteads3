// Live events for a request in flight: progress lines, streamed tokens, tool calls with their inputs and
// outputs, and the final answer. The console subscribes over Server-Sent Events; the CLI and tests read the
// buffered history. Buffers are dropped a minute after "done".
export class Events {
  constructor({ keep = 400, ttlMs = 60000 } = {}) {
    this.buffers = new Map();
    this.subs = new Map();
    this.keep = keep;
    this.ttlMs = ttlMs;
  }

  emit(reqId, type, data = {}) {
    if (!reqId) return;
    const ev = { at: Date.now(), type, ...data };
    const buf = this.buffers.get(reqId) ?? [];
    buf.push(ev);
    if (buf.length > this.keep) buf.splice(0, buf.length - this.keep);
    this.buffers.set(reqId, buf);
    for (const fn of this.subs.get(reqId) ?? []) { try { fn(ev); } catch {} }
    if (type === 'done') setTimeout(() => { this.buffers.delete(reqId); this.subs.delete(reqId); }, this.ttlMs).unref?.();
  }

  history(reqId) { return this.buffers.get(reqId) ?? []; }

  // Calls fn for every past event, then each new one. Returns an unsubscribe function.
  subscribe(reqId, fn) {
    for (const ev of this.history(reqId)) fn(ev);
    const set = this.subs.get(reqId) ?? new Set();
    set.add(fn);
    this.subs.set(reqId, set);
    return () => set.delete(fn);
  }

  // Progress lines only, for anything that still polls.
  progressOf(reqId) { return this.history(reqId).filter((e) => e.type === 'progress').map((e) => ({ at: e.at, line: e.line })); }
}

// Shorten a tool result for the activity panel without losing its shape.
export function preview(value, max = 1500) {
  const s = typeof value === 'string' ? value : JSON.stringify(value, null, 1) ?? '';
  return s.length > max ? s.slice(0, max) + `… (${s.length - max} more chars)` : s;
}
