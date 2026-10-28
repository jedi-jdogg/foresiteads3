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

## The playbook: who takes what

[`playbook.json`](playbook.json) is the decision matrix. Each **play** is a kind of work, with the
words that signal it, a first-choice agent, backups in order, and the reason. Run
`node bin/hub.js playbook` to print it, or open **Playbook** in the console sidebar.

| Play | First choice → backups | Council | Why |
|---|---|---|---|
| Your connected apps | Claude | | Only Claude is wired to your MCP connectors |
| Work on a Mac | Claude | | Claude Code with Remote Control operates the Macs |
| Fact check | Perplexity → Claude | Perplexity, Claude, Grok | Live sources with citations; a second agent catches misses |
| Live research | Perplexity → Grok → Claude | | Searches the web for every answer and cites it |
| Social pulse | Grok → Perplexity → Claude | | Reads X in real time |
| Facebook / Instagram | Muse → Claude → ChatGPT | | Meta's own agent |
| Images and visuals | ChatGPT → Muse → Claude | | ChatGPT makes images; Claude doesn't |
| Ideas and hooks | Claude → ChatGPT | Claude, Grok, Muse, ChatGPT | For ideas, range beats any single model |
| Strategy and decisions | Claude → ChatGPT | Claude, ChatGPT, Perplexity | Judgment calls; big ones earn a second opinion |
| Code and automation | Claude → ChatGPT | | Strongest coder; runs Claude Code on the Macs |
| Numbers and analysis | Claude → ChatGPT | | Careful with numbers, says what it is unsure of |
| Long documents | Claude → ChatGPT | | Reads very long documents in one go |
| Writing | Claude → ChatGPT | | Natural voice, follows a brief closely |
| General | Claude → ChatGPT | | Nothing more specific fits |

The assignments are a starting point: each one is based on what that product is built for (Perplexity
for live search, Grok for X, Muse for Meta's platforms, ChatGPT for images, Claude for reasoning,
writing, code and your connectors). They are not measured on your work yet. The ratings below are how
they get measured.

### How a request is decided

1. **Match.** Every play's signal words are checked against the request. The play with the most
   distinct matching words wins. On a tie, the play higher in the file wins, so specific plays sit
   above general ones.
2. **Pick the agent.** The winning play's first choice, or its first backup that has a key in `.env`.
   If it had to fall back, the hub says which key is missing.
3. **Go or recommend.**
   - **Go ahead** when one play clearly wins and it has no council: you get the answer straight away.
   - **Recommend** when it is a **close call** (another play scores the same and would pick a different
     agent) or the play has a **council** (fact checks, ideas, strategy). You get the options with
     reasons and click one.
   - The **When unsure** switch in the console (or `HUB_WHEN_UNSURE=pick` in `.env`, or `--pick` on the
     command line) skips the question and goes with the first option.
4. **Notes.** Plays with a note (your connected apps, the Macs) add it whenever they match, even when
   another play wins. For example, "analyze Shopify ROAS" goes to Claude as analysis and reminds you that
   live Shopify data needs Claude Code.

**Smart** mode hands the same playbook to Claude, which reads the request the way a person would. Use
it when the wording is unusual. It costs one extra Claude call.

### Tuning it

- **Rate answers.** Every answer card has 👍 / 👎. Ratings are saved under the play the request matched.
  `node bin/hub.js scorecard` shows the tally per play and agent. When an agent keeps losing on a play,
  move a backup up.
- **Change who takes a play:** edit `primary`, `backup` or `council` in `playbook.json`.
- **Teach it new words:** add them to that play's `signals`, for example a client's product names.
- **Add a play:** copy one and change it. Keep `general` last.

The hub checks the playbook when it starts, and refuses to start if a play names an agent that isn't
in `agents.json`. Restart it after editing.

## Ways to ask

| Mode | What happens | Cost |
|---|---|---|
| **Auto** | Follows the playbook. A clear fit goes straight through; otherwise you get options. The console shows the pick as you type. | One call |
| **Smart** | Claude reads the playbook and the request and decides. | Two calls |
| **Council** | Several agents answer in parallel, then Claude merges them, flags disagreements and gives a next step. | Up to five calls |
| **Direct** | Click an agent and talk to it alone, with follow-up memory. | One call per turn |

Every exchange is logged to `logs/YYYY-MM-DD.jsonl`, and ratings to `logs/feedback.jsonl`. The console
has four views: **Ask** (the thread), **Playbook** (every play with a tester that shows which play a request
hits), **Scorecard** (ratings by play and agent) and **Log** (today's requests). Open `public/preview.html` in
a browser to try the interface before adding any keys; it routes for real and shows sample answers.

## Connectors and the Macs

The hub calls each agent's API. That keeps it simple and safe, but an API call does not carry your
MCP connectors or control a Mac. When a request mentions Shopify, Klaviyo, Gmail, a Mac and so on,
the hub still answers, and adds a note: run that part in Claude Code / claude.ai, where the
connectors live, or on the Mac running Claude Code with Remote Control.

The **Macs** panel shows which of the five machines answer on SSH (port 22). Set each one's real
`host`, and which agent or app it is dedicated to, in the `machines` list of `agents.json`. The hub
does not run commands on them.

## Install on a Mac

The quick way: paste the contents of [`install-mac.sh`](install-mac.sh) into Terminal. It installs Node.js
and the GitHub CLI if they are missing, signs you in to GitHub in the browser, downloads the hub to
`~/foresiteads3` and starts it. Running it again updates instead. The manual steps below do the same thing.

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
   The first run installs packages, then opens the console in your browser at http://localhost:4747.
   Go to the **Connect** tab to add your keys (see below). Close the Terminal window to stop it; double-click again to restart.

### The Mac app

The installer also builds **Agent Hub.app** into your Applications folder (keep it in the Dock). It opens a
window with the console, starts the hub behind it, and stops the hub when you quit. Launching it also pulls
the latest version first, like the Terminal launcher does. The app is built on your Mac from
[`app/main.swift`](app/main.swift) by [`app/build-app.sh`](app/build-app.sh); when that source changes, the
next launch rebuilds it.

### Keeping it updated

Every time you double-click `start-mac.command` it pulls the latest version from GitHub before starting,
so restarting the hub is updating it. The top bar of the console shows the build it is running and says
when a newer one is waiting. To update without starting, double-click `update-mac.command`.

Updates only ever fast-forward: if a file in the folder was edited by hand, the launcher says so and runs
the installed version instead of overwriting anything. Your `.env`, logs and ratings are never touched.

New versions come from this repository's branch. When Claude pushes a change, your next restart picks it
up. To let Claude update or fix the install on the Mac directly, add the `foresiteads3` folder under
Remote Control in the Claude desktop app (Settings → Claude Code → Remote Control).

Your keys stay in `agent-hub/.env` on that Mac. Git ignores the file, so it is never committed.

### Connecting the agents

Open the **Connect** tab in the console (http://localhost:4747/#connect). For each agent, paste the key,
press **Save & test**, and the hub makes one tiny call to prove it works before saving the key to
`agent-hub/.env`. Muse also needs its endpoint (base URL). Agents you have not connected stay greyed out
and their work goes to the next best agent, so you can start with one or two.

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
| `playbook.json` | Which agent takes which kind of work, and why |
| `src/router.js` | Matches requests to plays; decides go or recommend |
| `src/hub.js` | Ask, smart routing, council and merge, logging, ratings |
| `src/providers/` | Claude (Anthropic SDK) and the OpenAI-compatible agents (OpenAI SDK) |
| `install-mac.sh` | One-paste installer for macOS |
| `app/` | The Mac app: Swift source, icon, build script |
| `start-mac.command` | Double-click launcher for macOS: updates, installs, starts |
| `update-mac.command` | Update without starting |
| `src/server.js`, `public/index.html` | The web console: Ask, Playbook, Scorecard and Log views |
| `public/preview.html`, `scripts/build-preview.mjs` | The console with the roster baked in, runnable without the hub (routing is real, answers are samples). Rebuild after editing the playbook. |
| `bin/hub.js` | CLI |
