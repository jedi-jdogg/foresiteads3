// Memory as a source: the hub's Memory instance exposed as memory__remember / recall / forget.
export async function test(_creds, source) { const o = await source.ctx.memory.overview(); return `${o.facts.split('\n').filter((l) => l.startsWith('- ')).length} facts, ${o.preferences.split('\n').filter((l) => l.startsWith('- ')).length} preferences, ${o.noteDays.length} days of notes`; }
export async function tools(_creds, source) { return source.ctx.memory.tools(); }
