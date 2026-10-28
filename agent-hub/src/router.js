// Rule-based routing: read the request for task signals, score each agent on how well its skills fit,
// and explain the pick. Cheap, instant and predictable; `smartRoute` in hub.js asks Claude instead.

export const SIGNALS = [
  { skill: 'research', label: 'needs current web sources', re: /\b(research|sources?|cite|citations?|look ?up|latest|news|today|this week|current|competitors?|market size|statistics|stats|who is|what happened)\b/i },
  { skill: 'fact-check', label: 'fact check', re: /\b(fact[- ]?check|verify|is it true|confirm whether)\b/i },
  { skill: 'social', label: 'social / X conversation', re: /\b(twitter|tweets?|x\.com|on x\b|viral|trending|sentiment|reddit|tiktok|influencers?|hashtags?)\b/i },
  { skill: 'meta-ads', label: 'Facebook / Instagram', re: /\b(facebook|instagram|meta ads?|reels?|whatsapp|threads app|fb ads?|ig)\b/i },
  { skill: 'images', label: 'image work', re: /\b(images?|logo|picture|illustrat\w*|photo\w*|graphic|thumbnail|mock-?up|render)\b/i },
  { skill: 'code', label: 'code', re: /\b(code|bug|script|api|deploy|function|repo|sql|javascript|python|html|css|webhook|error)\b/i },
  { skill: 'writing', label: 'writing', re: /\b(write|draft|email|blog|copy|rewrite|edit|proposal|summari[sz]e|outline|headline|newsletter)\b/i },
  { skill: 'analysis', label: 'analysis', re: /\b(analy[sz]\w*|data|spreadsheet|numbers|forecast|roas|metrics|kpis?|report|budget|pricing|margin)\b/i },
  { skill: 'strategy', label: 'strategy / decision', re: /\b(plan|strategy|strategic|decide|should (we|i)|pros and cons|trade-?offs?|prioriti[sz]e|roadmap|recommend)\b/i },
  { skill: 'brainstorm', label: 'brainstorm', re: /\b(brainstorm|ideas?|names?|taglines?|angles?|hooks?|concepts?)\b/i },
  { skill: 'long-documents', label: 'long document', re: /\b(contract|pdf|document|transcript|long|whole (file|doc))\b/i },
  { skill: 'connectors', label: 'your connected apps', re: /\b(shopify|klaviyo|gmail|inbox|slack|google drive|drive|calendar|calendly|bill\.com|thoughtmetric|vibe|konvert|replit|foresite|github)\b/i },
  { skill: 'machines', label: 'one of the Macs', re: /\b(macs?|machine|computer|desktop|laptop|install|on (my|the) (mac|computer)|run (it|this) on)\b/i },
];

// Primary skills count double: the first skill listed on an agent is what it is best at.
const PRIMARY_BONUS = 1;

export function detectSignals(prompt) {
  return SIGNALS.filter((s) => s.re.test(prompt));
}

export function route(prompt, agents) {
  const signals = detectSignals(prompt);
  const ranked = agents
    .map((agent, order) => {
      const matched = signals.filter((s) => agent.skills.includes(s.skill));
      const score = matched.reduce((sum, s) => sum + 1 + (agent.skills[0] === s.skill ? PRIMARY_BONUS : 0), 0);
      return { agent, order, score, matched: matched.map((s) => s.label) };
    })
    .sort((a, b) => b.score - a.score || a.order - b.order);

  // Nothing matched: the lead agent (first in the roster) takes it.
  const lead = agents[0];
  const top = ranked[0].score > 0 ? ranked[0] : ranked.find((r) => r.agent === lead);
  const firstCallable = ranked.find((r) => r.agent.callable && (r.score > 0 || r.agent === lead));
  const pick = top.agent.callable || top.agent.provider === 'handoff' ? top : firstCallable ?? top;

  const flags = [];
  if (signals.some((s) => s.skill === 'connectors')) {
    flags.push('Touches your connected apps. Those connectors live in Claude Code / claude.ai, not in this API call: run it there for live data.');
  }
  if (signals.some((s) => s.skill === 'machines')) {
    flags.push('Needs hands on a Mac. Send it to the Mac running Claude Code (Remote Control) rather than an API chat.');
  }
  const notSetUp = (a) => `isn't set up (add ${a.apiKey || !a.keyEnv ? a.baseURLEnv : a.keyEnv} to .env)`;
  if (pick !== top) {
    flags.push(`${top.agent.name} fits best but ${notSetUp(top.agent)}; using ${pick.agent.name} instead.`);
  } else if (!pick.agent.callable && pick.agent.provider !== 'handoff') {
    flags.push(`${pick.agent.name} fits best but ${notSetUp(pick.agent)}, and no other suitable agent is set up either.`);
  }

  return {
    signals: signals.map((s) => s.label),
    pick: pick.agent.id,
    reason: pick.matched.length
      ? `${pick.agent.name}: ${pick.matched.join(', ')}`
      : signals.length ? `${pick.agent.name}: standing in for ${top.agent.name}`
      : `${pick.agent.name}: no specialist signal, so the lead agent takes it`,
    ranked: ranked.map((r) => ({ id: r.agent.id, score: r.score, matched: r.matched, callable: r.agent.callable })),
    flags,
  };
}

// For council mode: the best-scoring callable agents, always including the lead for balance.
export function councilFor(prompt, agents, size = 3) {
  const { ranked } = route(prompt, agents);
  const ids = ranked.filter((r) => r.callable).map((r) => r.id);
  const lead = agents[0]?.id;
  const picked = ids.slice(0, size);
  if (lead && ids.includes(lead) && !picked.includes(lead)) picked[picked.length - 1] = lead;
  return picked;
}
