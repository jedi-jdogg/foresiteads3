# Foresite Agent Hub

One console over every AI agent Foresite uses. You type what you need; the hub sends it to the agent
whose strengths fit, shows why, and can ask several agents at once and merge their answers.

```
                ┌──────────────────────────────── you ────────────────────────────────┐
                │      web console (localhost:4747)   ·   agent-hub CLI               │
                └───────────────────────────────┬─────────────────────────────────────┘
                                                │  route: rules, or Claude decides
        ┌──────────────┬──────────────┬─────────┼────────┬──────────────┬──────────────┐
     Claude        Perplexity      ChatGPT      Grok        MetaMuse        Muse.ai
     lead,         web research    images,      X / social  Facebook /      video library
     strategy,     with sources    2nd opinion  sentiment   Instagram       (hand-off)
     writing,
     code, merges
        │
        └── in Claude Code / claude.ai: your MCP connectors (Shopify, Klaviyo, Gmail, Slack,
            Drive, Calendar, Calendly, Bill.com, ThoughtMetric, Vibe, Konvert, Replit,
            Foresite, GitHub) and Remote Control into the five Macs
```

## How it organises the agents

Each agent has one job it is best at, listed in [`agents.json`](agents.json):

| Agent | Role | Gets sent |
|---|---|---|
| **Claude** (lead) | Conductor. Judgment, strategy, writing, code, long documents. Merges council answers. | Anything with no clear specialist; anything touching your connected apps or the Macs |
| **Perplexity** | Researcher | "latest", "research", "sources", competitors, market numbers, fact checks |
| **ChatGPT** | Generalist and image maker | Images, logos, mock-ups; second opinion on analysis and copy |
| **Grok** | Social listener | X/Twitter, trending, sentiment, viral angles |
| **MetaMuse** | Meta specialist | Facebook, Instagram, Reels creative and audiences |
| **Muse.ai** | Video library (not a chat model) | Video, clips, transcripts: the hub tells you to do it in Muse.ai |

To change who gets what, edit an agent's `skills` in `agents.json`. The first skill listed counts
double. The signals that detect each skill are the regular expressions at the top of
[`src/router.js`](src/router.js).

## Four ways to ask

| Mode | What happens | Cost |
|---|---|---|
| **Auto** | Rules pick one agent. The console shows the pick and reason as you type. | One call |
| **Smart** | Claude reads the request and the roster and picks. | Two calls |
| **Council** | Up to three configured agents answer in parallel (the best fits, always including Claude), then Claude merges them, flags disagreements and gives a next step. | Four calls |
| **Direct** | Click an agent and talk to it alone, with follow-up memory. | One call per turn |

Every exchange is logged to `logs/YYYY-MM-DD.jsonl`, so you can see later who answered what.

## Connectors and the Macs

The hub calls each agent's API. That keeps it simple and safe, but an API call does not carry your
MCP connectors or control a Mac. When a request mentions Shopify, Klaviyo, Gmail, a Mac and so on,
the hub still answers, and adds a note: run that part in Claude Code / claude.ai, where the
connectors live, or on the Mac running Claude Code with Remote Control.

The **Macs** panel shows which of the five machines answer on SSH (port 22). Set each one's real
`host`, and which agent or app it is dedicated to, in the `machines` list of `agents.json`. The hub
does not run commands on them.

## Set up

```bash
cd agent-hub
npm install
cp .env.example .env      # paste in the API keys you have; agents without a key stay greyed out
npm start                 # http://localhost:4747
```

Or from the terminal:

```bash
node bin/hub.js agents                                   # who is configured
node bin/hub.js route "What are quilting brands running on Instagram this month?"
node bin/hub.js ask "Draft a Q1 plan for Linda's email program"
node bin/hub.js ask --council "Three angles for a Black Friday batting sale"
node bin/hub.js ask --agent perplexity "Shopify fee changes announced this year, with sources"
node bin/hub.js machines
npm test
```

Keys: Anthropic (console.anthropic.com), OpenAI (platform.openai.com), xAI for Grok (console.x.ai),
Perplexity (perplexity.ai/settings/api), Meta Llama API (llama.developer.meta.com). Model names
default to the values in `agents.json` and can be overridden in `.env` (`CLAUDE_MODEL`,
`OPENAI_MODEL`, `XAI_MODEL`, `PERPLEXITY_MODEL`, `META_MODEL`).

The console listens on `127.0.0.1` only. It has no login, so do not expose it on a network address
without putting authentication in front of it.

## Things to confirm

- **MetaMuse** is set up against Meta's OpenAI-compatible Llama API. If you reach it another way,
  set `META_BASE_URL` and `META_MODEL`; if it has no API, change its `provider` to `"handoff"` and
  give it a `url`.
- **Muse.ai** is treated as a video platform you hand work to. If you meant a different Muse
  (a chat assistant with an API), give it `"provider": "openai-compatible"`, a `baseURL` and a key.
- **Mac host names** in `agents.json` are placeholders (`mac-1.local` …).
- **OpenAI, Grok and Meta model names** are defaults; set the ones on your plans.

## Layout

| Path | What it does |
|---|---|
| `agents.json` | The roster: agents, Macs, connectors |
| `src/router.js` | Task signals and agent scoring |
| `src/hub.js` | Ask, smart routing, council and merge, logging |
| `src/providers/` | Claude (Anthropic SDK) and the OpenAI-compatible agents (OpenAI SDK) |
| `src/server.js`, `public/index.html` | The web console |
| `bin/hub.js` | CLI |
