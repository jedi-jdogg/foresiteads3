---
name: leadpipe
description: Use the LeadPipe MCP connector for intent topics, audience building, visitor identification, and pixel management. Use when Jonathan asks about LeadPipe, intent data, building or exporting an audience, who visited a site, or connecting/setting up LeadPipe for Claude.
---

# LeadPipe connector

Setup, tool list, and troubleshooting live in `connectors/leadpipe/README.md`. The server is
declared in `.mcp.json` and needs `LEADPIPE_API_KEY` in the environment (key from
https://dashboard.leadpipe.com/dashboard/settings?tab=mcp).

## Connecting someone

Point them at the README section for their client (Claude Code, Claude Desktop, Cursor, Codex).
It is a local stdio server, not a remote URL, so it cannot be added as a claude.ai custom
connector. Verify with `get_account_status`.

## Using the tools

- Start with `get_account_status` to confirm auth and credits before heavy work.
- Discovery: `search_topics` → `get_topic_trend`/`compare_topics` → `get_topic_movers`.
- Build: `get_audience_filters` → `preview_audience` (always preview first; results cost credits)
  → `create_audience` → `update_audience status=active`.
- Results: `get_audience_status` → `get_audience_results` → `get_audience_stats` → `export_audience`.
- Visitors: `query_visitor_data` with an email for one journey, or domain/timeframe for a range.
- `delete_audience`, `create_pixel`, and `update_pixel` change the account. Confirm with Jonathan
  before calling them.
