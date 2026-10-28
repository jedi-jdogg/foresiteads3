// The Macs, exposed to agents as tools. Backed by src/machines.js; the hub passes its Machines instance in.
export async function test(_creds, source) {
  const list = await source.machines.list();
  return `${list.length} Mac${list.length === 1 ? '' : 's'} registered`;
}

export async function tools(_creds, source) {
  const M = source.machines;
  const actions = await M.actions();
  const actionList = actions.map((a) => `${a.id}: ${a.description}${a.args ? ' args ' + JSON.stringify(a.args) : ''}`).join('\n');
  return [
    {
      name: 'list',
      description: 'The Macs registered as workers: id, name, note (what it is for / has signed in), whether it is online on Tailscale, and how many jobs it is running.',
      input_schema: { type: 'object', properties: {} },
      async run() { const o = await M.overview(); return o.machines.map(({ id, name, note, online, running }) => ({ id, name, note, online, running })); },
    },
    {
      name: 'run',
      description: `Run an allowlisted action on a Mac. Short actions return output; long ones (script, claude) return a job id to check with machines__job. Actions:\n${actionList}`,
      input_schema: { type: 'object', required: ['machine', 'action'], properties: {
        machine: { type: 'string', description: 'Machine id from machines__list' },
        action: { type: 'string', enum: actions.map((a) => a.id) },
        args: { type: 'object', description: 'Arguments for the action, e.g. {"url":"https://…"}, {"name":"report.sh"}, {"prompt":"…"}' },
      } },
      async run({ machine, action, args }) { return M.runAction(machine, action, args ?? {}); },
    },
    {
      name: 'job',
      description: 'Status and output of a background job started with machines__run.',
      input_schema: { type: 'object', required: ['job'], properties: { job: { type: 'string' } } },
      async run({ job }) { return M.job(job); },
    },
  ];
}
