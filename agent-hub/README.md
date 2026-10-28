# Foresite Agent Hub

One console over every AI agent Foresite uses. You type what you need; the hub sends it to the agent
whose strengths fit, shows why, and can ask several agents at once and merge their answers.

```
                ┌──────────────────────────────── you ────────────────────────────────┐
                │      web console (localhost:4747)   ·   agent-hub CLI               │
                └───────────────────────────────┬─────────────────────────────────────┘
                                                │  route: rules, or Claude decides
        ┌──────────────┬──────────────┬─────────┼────────┬──────────────┬──────────────┐
     Claude        Perplexity      ChatGPT      Grok        Muse (Meta)
     lead,         web research    images,      X / social  Facebook /
     strategy,     with sources    2nd opinion  sentiment   Instagram
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
| **Muse** (Meta) | Meta's agent | Facebook, Instagram, Reels creative and audiences |

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

## Install on a Mac

1. **Install Node.js** (one time): download the LTS installer from [nodejs.org](https://nodejs.org/en/download) and run it.
2. **Get the code.** In Terminal:
   ```bash
   cd ~
   git clone https://github.com/jedi-jdogg/foresiteads3.git
   cd foresiteads3
   git checkout claude/multi-agent-interface-hub-d8ahj4
   ```
   macOS offers to install the developer tools the first time you run `git`; accept. The repository is
   private, so git asks you to sign in to GitHub. When it asks for a password, use a personal access token
   ([github.com/settings/tokens](https://github.com/settings/tokens)), or sign in once with
   [GitHub Desktop](https://desktop.github.com) and clone from there instead.
3. **Start it.** In Finder, open `foresiteads3/agent-hub` and double-click **`start-mac.command`**.
   The first run installs packages, opens `.env` in TextEdit for your keys, then opens the console in your
   browser at http://localhost:4747. Close the Terminal window to stop it; double-click again to restart.

To update later: `cd ~/foresiteads3 && git pull`, then double-click `start-mac.command` again.

Your keys stay in `agent-hub/.env` on that Mac. Git ignores the file, so it is never committed.

### Getting the keys

| Agent | `.env` line | Where |
|---|---|---|
| Claude | `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) → API keys |
| ChatGPT | `OPENAI_API_KEY` | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| Grok | `XAI_API_KEY` | [console.x.ai](https://console.x.ai) |
| Perplexity | `PERPLEXITY_API_KEY` | [perplexity.ai/settings/api](https://www.perplexity.ai/settings/api) |
| Muse | `MUSE_API_KEY` and `MUSE_BASE_URL` | Meta's developer console for the Meta Model API: the key, and the OpenAI-compatible endpoint it lists |

API keys are billed separately from ChatGPT Plus, Grok, Perplexity Pro or Claude subscriptions; each
console needs a payment method or credits. You can start with only some of them: agents without a key
stay greyed out and their work goes to the next best agent.

## Command line

```bash
cd agent-hub
npm install
cp .env.example .env
npm start                 # http://localhost:4747
```

```bash
node bin/hub.js agents                                   # who is configured
node bin/hub.js route "What are quilting brands running on Instagram this month?"
node bin/hub.js ask "Draft a Q1 plan for Linda's email program"
node bin/hub.js ask --council "Three angles for a Black Friday batting sale"
node bin/hub.js ask --agent perplexity "Shopify fee changes announced this year, with sources"
node bin/hub.js machines
npm test
```

Model names default to the values in `agents.json` and can be overridden in `.env` (`CLAUDE_MODEL`,
`OPENAI_MODEL`, `XAI_MODEL`, `PERPLEXITY_MODEL`, `MUSE_MODEL`).

The console listens on `127.0.0.1` only. It has no login, so do not expose it on a network address
without putting authentication in front of it.

## Things to confirm

- **Muse** is reached through the Meta Model API, which is in preview. The default model is
  `muse-spark-1.3`; set `MUSE_MODEL` if your console lists a different one (Muse Wonder, for example).
  The hub talks to Muse's model only. Things the Muse app does for you in the background, such as
  email, travel and purchases, still happen in the Muse app.
- **Mac host names** in `agents.json` are placeholders (`mac-1.local` …).
- **ChatGPT, Grok and Perplexity model names** are defaults; set the ones on your plans.

## Layout

| Path | What it does |
|---|---|
| `agents.json` | The roster: agents, Macs, connectors |
| `src/router.js` | Task signals and agent scoring |
| `src/hub.js` | Ask, smart routing, council and merge, logging |
| `src/providers/` | Claude (Anthropic SDK) and the OpenAI-compatible agents (OpenAI SDK) |
| `start-mac.command` | Double-click launcher for macOS |
| `src/server.js`, `public/index.html` | The web console |
| `bin/hub.js` | CLI |
