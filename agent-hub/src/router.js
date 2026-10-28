// Playbook routing: match the request against each play in playbook.json, take the strongest play,
// and give it to that play's first agent that is set up. When the call is close, or the play says a
// council would help, the router recommends instead of proceeding. `smartRoute` in hub.js asks Claude.

const compiled = new WeakMap();
const regexFor = (play) => {
  if (!play.signals) return null;
  if (!compiled.has(play)) compiled.set(play, new RegExp(play.signals, 'gi'));
  return compiled.get(play);
};

// Score = number of distinct matching terms, so "latest news on competitors" outweighs a lone "plan".
export function matchPlays(prompt, playbook) {
  return playbook.plays
    .map((play, order) => {
      const re = regexFor(play);
      const terms = re ? [...new Set([...prompt.matchAll(re)].map((m) => m[0].toLowerCase()))] : [];
      return { play, order, score: terms.length, terms };
    })
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order);
}

const usable = (a) => a && (a.callable || a.provider === 'handoff');

// The play's first agent that is set up; the primary (not set up) if none is.
function resolve(play, byId) {
  const chain = [play.primary, ...(play.backup ?? [])].map((id) => byId.get(id)).filter(Boolean);
  return chain.find(usable) ?? byId.get(play.primary);
}

function notSetUp(a) {
  return `isn't set up (add ${a.apiKey || !a.keyEnv ? a.baseURLEnv : a.keyEnv} to .env)`;
}

export function route(prompt, agents, playbook) {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const matches = matchPlays(prompt, playbook);
  const general = playbook.plays.find((p) => !p.signals) ?? playbook.plays.at(-1);
  const top = matches[0] ?? { play: general, score: 0, terms: [] };
  const agent = resolve(top.play, byId);
  const primary = byId.get(top.play.primary);

  // A close call: another play scores as high but would send it to a different agent.
  const rival = matches.slice(1).find((m) => m.score >= top.score && resolve(m.play, byId)?.id !== agent.id);
  const confidence = rival ? 'low' : 'high';
  const council = (top.play.council ?? []).filter((id) => usable(byId.get(id)));

  const options = [{ kind: 'agent', agentId: agent.id, play: top.play.label, why: top.play.why }];
  if (rival) {
    const alt = resolve(rival.play, byId);
    options.push({ kind: 'agent', agentId: alt.id, play: rival.play.label, why: rival.play.why });
  }
  if (council.length >= 2) {
    options.push({ kind: 'council', agents: council, play: top.play.label, why: `Ask ${council.map((id) => byId.get(id).name).join(', ')} and have Claude merge the answers.` });
  }

  const flags = matches.map((m) => m.play.note).filter(Boolean);
  if (agent !== primary) flags.push(`${primary.name} fits best but ${notSetUp(primary)}; using ${agent.name} instead.`);
  else if (!usable(agent)) flags.push(`${agent.name} fits best but ${notSetUp(agent)}, and none of its backups are set up either.`);

  return {
    play: { id: top.play.id, label: top.play.label, why: top.play.why },
    terms: top.terms,
    pick: agent.id,
    reason: `${top.play.label} → ${agent.name}${agent !== primary ? ` (standing in for ${primary.name})` : ''}`,
    confidence,
    decision: confidence === 'high' && options.length === 1 ? 'proceed' : 'recommend',
    options,
    matched: matches.map((m) => ({ play: m.play.id, label: m.play.label, score: m.score, terms: m.terms, agent: resolve(m.play, byId).id })),
    flags,
  };
}

// Council members: the play's own council if it has one, otherwise the best agent from each matching
// play. Always includes the lead (first agent in the roster) so Claude's view is in the mix.
export function councilFor(prompt, agents, playbook, size = 3) {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const r = route(prompt, agents, playbook);
  const fromPlays = r.matched.map((m) => m.agent);
  const play = playbook.plays.find((p) => p.id === r.play.id);
  const candidates = [...(play.council ?? []), r.pick, ...fromPlays, ...agents.map((a) => a.id)];
  const ids = [...new Set(candidates)].filter((id) => byId.get(id)?.callable);
  const picked = ids.slice(0, size);
  const lead = agents[0]?.id;
  if (lead && ids.includes(lead) && !picked.includes(lead)) picked[picked.length - 1] = lead;
  return picked;
}
