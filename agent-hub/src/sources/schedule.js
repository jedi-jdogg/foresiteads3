// The scheduler as a source: schedule__create / list / delete.
export async function test(_creds, source) { const l = await source.ctx.scheduler.list(); return `${l.filter((r) => r.enabled).length} active schedule${l.length === 1 ? '' : 's'}`; }
export async function tools(_creds, source) { return source.ctx.scheduler.tools(); }
