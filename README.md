# foresiteads3

Tooling for Foresite Ads clients.

- [`pricing-super-bot/`](pricing-super-bot/) — finds products on lindas.com that can take a price increase without losing demand, and produces a ranked report plus a review CSV. See its README for the model and how to run it. A Claude Code skill (`.claude/skills/pricing-super-bot`) documents how to refresh the data through the Shopify MCP tools.
- [`connectors/leadpipe/`](connectors/leadpipe/) — LeadPipe MCP connector: how to get the API key from the dashboard MCP tab and wire `@leadpipe/mcp` into Claude Code, Claude Desktop, Cursor, or Codex, plus the full tool list. `.mcp.json` at the repo root enables it for Claude Code in this repo; a Claude Code skill (`.claude/skills/leadpipe`) covers day-to-day use.
