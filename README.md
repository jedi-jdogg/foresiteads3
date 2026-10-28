# foresiteads3

Tooling for Foresite Ads clients.

- [`pricing-super-bot/`](pricing-super-bot/) — finds products on lindas.com that can take a price increase without losing demand, and produces a ranked report plus a review CSV. See its README for the model and how to run it. A Claude Code skill (`.claude/skills/pricing-super-bot`) documents how to refresh the data through the Shopify MCP tools.
- [`agent-hub/`](agent-hub/) — one console over Claude, ChatGPT, Grok, Perplexity, MetaMuse and Muse.ai. Routes each request to the agent best suited to it, or asks several and has Claude merge the answers. Shows which of the Macs are reachable and flags work that needs the MCP connectors. See its README to set it up.
