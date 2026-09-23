# LeadPipe connector

Connects Claude (and other MCP clients) to [LeadPipe](https://leadpipe.com) intent data, audience
building, visitor identification, and pixel management through LeadPipe's official MCP server,
[`@leadpipe/mcp`](https://github.com/leadpipe-com/mcp) (npm, v0.2.x).

The server runs locally over stdio and talks to the LeadPipe API with your API key. There is no
hosted/remote MCP URL, so it is not a claude.ai "custom connector" (those need a remote URL). Use
it from Claude Code, Claude Desktop, Cursor, or Codex as shown below.

## 1. Get your API key

1. Sign in to the LeadPipe dashboard.
2. Open **Settings → MCP** tab: <https://dashboard.leadpipe.com/dashboard/settings?tab=mcp>
3. Copy the API key. It starts with `sk_`.

Treat it like a password: it grants full access to audiences, visitor data, and pixels for the
organization. Never commit it. This repo's `.gitignore` excludes `.env`.

## 2. Connect

### Claude Code (this repo)

`.mcp.json` at the repo root already declares the server and reads the key from your shell:

```bash
export LEADPIPE_API_KEY=sk_...   # or put it in .env and source it
claude                            # approve the project MCP server when prompted
```

Check it loaded with `/mcp` inside Claude Code. To make it available in every project instead of
just this one:

```bash
claude mcp add leadpipe --scope user --env LEADPIPE_API_KEY=sk_... -- npx -y @leadpipe/mcp
```

### Claude Desktop

Add the block from [`claude_desktop_config.example.json`](claude_desktop_config.example.json) to
your config file, then fully quit and reopen Claude Desktop:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "leadpipe": {
      "command": "npx",
      "args": ["-y", "@leadpipe/mcp"],
      "env": { "LEADPIPE_API_KEY": "sk_..." }
    }
  }
}
```

Requires Node.js 18+ on the machine (`npx` ships with it).

### Cursor

Same JSON as Claude Desktop, in `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project).

### Codex

```bash
codex mcp add leadpipe --env LEADPIPE_API_KEY=sk_... -- npx -y @leadpipe/mcp
codex mcp list
```

## 3. Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `LEADPIPE_API_KEY` | yes | Organization API key (`sk_...`) from the dashboard MCP tab |
| `LEADPIPE_BASE_URL` | no | API host override. Default `https://api.aws53.cloud` |

## 4. Verify

Ask Claude: *"Call `get_account_status` on LeadPipe."* A healthy connection returns account
health, credit status, pixel counts, and intent audience slot usage. A wrong or missing key
returns an authentication error from the API.

## What you get

25 tools, 3 doc resources, and 3 guided prompts.

**Topic discovery**
- `list_topics` – browse intent topics, filter by type, industry, category, text
- `get_topic_facets` – available types, industries, categories for filters
- `search_topics` – search topics by name (autocomplete)
- `get_topic_trend` – daily trend series for one topic
- `compare_topics` – daily trend series for several topics
- `get_topic_movers` – top topics by day-over-day audience growth or decline
- `analyze_website_topics` – analyze a URL and return matched intent topics

**Audience builder**
- `get_audience_filters` – available ICP filter values
- `preview_audience` – audience size plus masked sample rows
- `query_audience` – ad hoc audience query, or browse a saved audience run
- `list_audiences`, `get_audience`, `create_audience`, `update_audience` (activate/pause), `delete_audience`

**Audience results**
- `get_audience_status` – materialization status for latest run or a date
- `get_audience_results` – paginated full results
- `list_audience_runs` – available daily runs
- `get_audience_stats` – field fill rates
- `export_audience` – CSV export with a signed download URL

**Visitor data**
- `query_visitor_data` – resolved visitor data; pass an email for one journey, or filter by timeframe/domain/page

**Pixels**
- `list_pixels`, `create_pixel`, `update_pixel` (pause, activate, excluded paths)

**Account**
- `get_account_status` – health, credits, pixel counts, audience slots

**Resources**: `leadpipe://docs/auth`, `leadpipe://docs/workflows`, `leadpipe://docs/data-api`

**Prompts**: `discover-audience-topics`, `operate-saved-audience`, `investigate-visitor-data`

## Standard workflows (from the server's own guide)

- **Discovery**: `search_topics` → `get_topic_trend` or `compare_topics` → `get_topic_movers`
- **Build audience**: `get_audience_filters` → `preview_audience` → `create_audience` → `update_audience` with `status=active`
- **Read results**: `get_audience_status` → `get_audience_results` → `get_audience_stats` → `export_audience`

## Troubleshooting

- **Server not listed**: confirm Node 18+ (`node -v`), then run `npx -y @leadpipe/mcp` in a
  terminal. It should print `Leadpipe MCP server running on stdio`.
- **Auth errors on every call**: the key is missing, wrong, or was rotated in the dashboard. Update
  `LEADPIPE_API_KEY` and restart the client.
- **`Host not in allowlist` / non-JSON error**: an outbound proxy is blocking `api.aws53.cloud`.
  Allow that host (or set `LEADPIPE_BASE_URL` to the host your org uses).
- **Claude Desktop changes not picked up**: quit from the menu bar/tray, not just the window.
