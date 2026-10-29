// Skills as a source: skills__list / skills__load.
export async function test(_creds, source) { const l = await source.ctx.skills.list(); return `${l.length} skill${l.length === 1 ? '' : 's'} installed`; }
export async function tools(_creds, source) { return source.ctx.skills.tools(); }
